/**
 * Shared combo (model combo) handling with fallback support
 */

import { checkFallbackError, formatRetryAfter } from "./accountFallback.js";
import { unavailableResponse } from "../utils/error.js";
import { DEFAULT_COMBO_TARGET_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { getCircuitBreaker, STATE } from "../utils/circuitBreaker.js";
import { getCapabilitiesForModel } from "../providers/capabilities.js";
import { parseModel } from "./model.js";
import { extractTextContent } from "../translator/formats/gemini.js";
import { createHash } from "node:crypto";
import { incrementMetric } from "@/lib/observability/metrics.js";
import { descriptorConnectionId, descriptorKey, makeDescriptor } from "./targetDescriptor.js";
import { peekStreamForContent, reconstructStream, isNoRetryFinish } from "./emptyFailover.js";
import {
  getStickyComboModel,
  setStickyComboModel,
  clearStickyComboSession,
  orderModelsByChoice,
} from "./systemoneRouter.js";

// Strip "combo/" prefix from model string (e.g. "combo/coding-stack" → "coding-stack")
export function stripComboPrefix(modelStr) {
  if (typeof modelStr !== "string") return modelStr;
  return modelStr.startsWith("combo/") ? modelStr.slice(6) : modelStr;
}

export { DEFAULT_COMBO_TARGET_TIMEOUT_MS };

// Peek a 2xx combo response for real content. Returns null for non-SSE responses (leave
// them untouched). For SSE, returns { outcome: "content"|"empty", finishReason, response }
// where `response` is a faithful replay of the original stream (head buffer + live reader).
async function peekComboResponse(result, log) {
  const ct = (result.headers.get("content-type") || "").toLowerCase();
  if (!result.body || !ct.includes("text/event-stream")) return null;
  const peeked = await peekStreamForContent(result.body);
  const response = new Response(reconstructStream(peeked.head, peeked.reader, peeked.pendingRead), {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  });
  return { outcome: peeked.outcome, finishReason: peeked.finishReason, timedOut: peeked.timedOut, response };
}

// Hard capabilities = input modalities; missing one drops request data (e.g. image
// stripped). Must be prioritized. Soft (e.g. search) only degrades a feature.
const HARD_CAPS = new Set(["vision", "pdf", "audioInput", "videoInput"]);

// Prefixes used when flattening tool turns into plain prose for panel models.
const TOOL_CALL_PREFIX = "[Called tools: ";
const TOOL_RESULT_PREFIX = "[Tool result: ";

// Flatten tool turns into prose so panel models keep the context but can't loop
// on tools: drop the request's tools, turn tool/function results into assistant
// text, and inline assistant tool_calls names instead of the structured field.
function flattenToolHistory(messages) {
  return messages
    .filter((msg) => msg)
    .map((msg) => {
      if (msg.role === "tool" || msg.role === "function") {
        return { role: "assistant", content: `${TOOL_RESULT_PREFIX}${extractTextContent(msg.content) || String(msg.content ?? "")}]` };
      }
      if (msg.role === "assistant" && Array.isArray(msg.tool_calls)) {
        const { tool_calls, ...rest } = msg;
        const names = tool_calls.map((c) => c?.function?.name || c?.name || "tool").join(", ");
        const base = extractTextContent(rest.content) || (typeof rest.content === "string" ? rest.content : "");
        return { ...rest, content: `${base}${base ? "\n" : ""}${TOOL_CALL_PREFIX}${names}]` };
      }
      if (Array.isArray(msg.content)) {
        const hasToolUse = msg.content.some((c) => c.type === "tool_use");
        const hasToolResult = msg.content.some((c) => c.type === "tool_result");
        if (hasToolUse || hasToolResult) {
          const textParts = [];
          const toolNames = [];
          const toolResults = [];
          for (const block of msg.content) {
            if (block.type === "text" && block.text) textParts.push(block.text);
            if (block.type === "tool_use") toolNames.push(block.name || "tool");
            if (block.type === "tool_result") toolResults.push(extractTextContent(block.content) || String(block.content ?? ""));
          }
          const { ...rest } = msg;
          let newContent = textParts.join("\n");
          if (toolNames.length > 0) {
            newContent = `${newContent}${newContent ? "\n" : ""}${TOOL_CALL_PREFIX}${toolNames.join(", ")}]`;
          }
          if (toolResults.length > 0) {
            newContent = `${newContent}${newContent ? "\n" : ""}${TOOL_RESULT_PREFIX}${toolResults.join("\n")}]`;
          }
          return { ...rest, content: newContent };
        }
      }
      return msg;
    });
}

// Reorder combo models by capability fit. Stable; never drops a model (fallback intact).
// Tier 0: satisfies all hard + all soft. Tier 1: all hard only. Tier 2: rest.
export function reorderByCapabilities(models, required) {
  if (!required || required.size === 0 || !Array.isArray(models) || models.length <= 1) return models;
  const hard = [...required].filter((c) => HARD_CAPS.has(c));
  const soft = [...required].filter((c) => !HARD_CAPS.has(c));

  const tierOf = (m) => {
    const rawStr = descriptorKey(m);
    const slash = typeof rawStr === "string" ? rawStr.indexOf("/") : -1;
    const provider = slash > 0 ? rawStr.slice(0, slash) : "";
    const model = slash > 0 ? rawStr.slice(slash + 1) : rawStr;
    const caps = getCapabilitiesForModel(provider, model);
    if (!hard.every((c) => caps[c] === true)) return 2;
    return soft.every((c) => caps[c] === true) ? 0 : 1;
  };

  // Stable sort by tier (Array.prototype.sort is stable in modern engines).
  const tiered = models.map((m, i) => ({ m, i, t: tierOf(m) }));
  if (tiered.every((x) => x.t === 2)) return models;
  return tiered
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.m);
}

/**
 * Track rotation state per combo (for round-robin strategy)
 * @type {Map<string, { index: number, consecutiveUseCount: number }>}
 */
const comboRotationState = new Map();

// Trailing run of items after the last assistant/model turn = the current user
// turn. It may span several messages (e.g. text + image split across blocks),
// so we return all of them. History media (older turns) must not pin the combo
// to a vision model — those get stripped + placeholdered downstream instead.
function trailingUserItems(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return [];
  const isAssistant = (r) => r === "assistant" || r === "model";
  let i = arr.length - 1;
  while (i >= 0 && !isAssistant(arr[i]?.role)) i--;
  return arr.slice(i + 1);
}

// Detect which capabilities a request needs. Modalities (vision/pdf) are scanned
// only on the current user turn; "search" is request-wide (lives in tools).
// Returns a Set of: "vision" | "pdf" | "search".
export function detectRequiredCapabilities(body) {
  const required = new Set();
  if (!body || typeof body !== "object") return required;

  const addByMime = (mime) => {
    if (typeof mime !== "string") return;
    if (mime.startsWith("image/")) required.add("vision");
    else if (mime === "application/pdf") required.add("pdf");
    else if (mime.startsWith("audio/")) required.add("audioInput");
    else if (mime.startsWith("video/")) required.add("videoInput");
  };

  const scanBlock = (b) => {
    if (!b || typeof b !== "object") return;
    const t = b.type;
    if (t === "image_url" || t === "image" || t === "input_image") required.add("vision");
    if (t === "input_audio" || t === "audio_url" || t === "audio") required.add("audioInput");
    if (t === "input_video" || t === "video_url" || t === "video") required.add("videoInput");
    if (t === "file" || t === "document" || t === "input_file") {
      // Infer modality from embedded mime when available; fall back to pdf for generic files.
      let fmime = null;
      if (b.input_audio?.format) fmime = `audio/${b.input_audio.format}`;
      else if (b.file?.file_data) fmime = String(b.file.file_data).match(/^data:([^;,]+)/)?.[1];
      else if (b.source?.media_type) fmime = b.source.media_type;
      else if (b.source?.data) fmime = String(b.source.data).match(/^data:([^;,]+)/)?.[1];
      if (fmime) addByMime(fmime);
      else required.add("pdf");
    }
    // gemini parts: inlineData/fileData carry a mime
    addByMime(b.inlineData?.mimeType || b.fileData?.mimeType);
  };

  const scanContent = (content) => {
    if (Array.isArray(content)) for (const b of content) scanBlock(b);
  };

  const scanMessage = (m) => {
    if (!m || typeof m !== "object") return;

    // Ollama / Hermes images array (strings or objects)
    if (Array.isArray(m.images) && m.images.length > 0) {
      required.add("vision");
    }

    // Vercel AI SDK / Hermes attachments / experimental_attachments
    const attachments = m.experimental_attachments || m.attachments;
    if (Array.isArray(attachments)) {
      for (const att of attachments) {
        if (!att) continue;
        const mime = att.contentType || att.mediaType || (typeof att.url === "string" && att.url.match(/^data:([^;,]+)/)?.[1]);
        if (mime) addByMime(mime);
        else if (att.url || att.data) required.add("vision");
      }
    }

    // Direct message-level modality properties
    if (m.image_url || m.image) required.add("vision");
    if (m.audio_url || m.audio) required.add("audioInput");

    // Scan array content blocks
    scanContent(m.content);

    // Scan string content for embedded data URIs
    if (typeof m.content === "string") {
      if (m.content.includes("data:image/")) required.add("vision");
      else if (m.content.includes("data:audio/")) required.add("audioInput");
      else if (m.content.includes("data:application/pdf")) required.add("pdf");
    }
  };

  // Modalities: current user turn only (trailing user run across each known shape).
  for (const m of trailingUserItems(body.messages)) scanMessage(m);              // openai / claude / hermes / ollama
  for (const it of trailingUserItems(body.input)) scanContent(it.content);       // responses
  const contents = body.contents || body.request?.contents;                      // gemini / antigravity
  for (const c of trailingUserItems(contents)) scanContent(c.parts);

  // Search tools are a capability requirement even when the user turn is
  // text-only. Keep both the native Claude name and the OpenAI function shape
  // recognized so Auto Combo does not select a model that cannot search.
  if (Array.isArray(body.tools)) {
    const needsSearch = body.tools.some((tool) =>
      tool?.type === "web_search" ||
      tool?.name === "web_search" ||
      tool?.function?.name === "web_search" ||
      tool?.function?.name === "web_search_preview",
    );
    if (needsSearch) required.add("search");
  }

  return required;
}

function normalizeStickyLimit(stickyLimit) {
  const parsed = Number.parseInt(stickyLimit, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

function rotateModelsFromIndex(models, currentIndex) {
  const rotatedModels = [...models];
  for (let i = 0; i < currentIndex; i++) {
    const moved = rotatedModels.shift();
    rotatedModels.push(moved);
  }
  return rotatedModels;
}

/**
 * Get rotated model list based on strategy
 * @param {string[]} models - Array of model strings
 * @param {string} comboName - Name of the combo
 * @param {string} strategy - "fallback" or "round-robin"
 * @param {number|string} [stickyLimit=1] - Requests per combo model before switching
 * @returns {string[]} Rotated models array
 */
export function getRotatedModels(models, comboName, strategy, stickyLimit = 1) {
  if (!models || models.length <= 1 || strategy !== "round-robin") {
    return models;
  }

  const rotationKey = comboName || "__default__";
  const normalizedStickyLimit = normalizeStickyLimit(stickyLimit);
  const existingState = comboRotationState.get(rotationKey);
  const state = typeof existingState === "number"
    ? { index: existingState, consecutiveUseCount: 0 }
    : (existingState || { index: 0, consecutiveUseCount: 0 });

  const currentIndex = state.index % models.length;
  const rotatedModels = rotateModelsFromIndex(models, currentIndex);
  const nextUseCount = state.consecutiveUseCount + 1;

  if (nextUseCount >= normalizedStickyLimit) {
    comboRotationState.set(rotationKey, {
      index: (currentIndex + 1) % models.length,
      consecutiveUseCount: 0,
    });
  } else {
    comboRotationState.set(rotationKey, {
      index: currentIndex,
      consecutiveUseCount: nextUseCount,
    });
  }

  return rotatedModels;
}

/**
 * Reset in-memory rotation state when combo/settings change
 * @param {string} [comboName] - Combo name to reset; omit to clear all
 */
export function resetComboRotation(comboName) {
  if (comboName) {
    comboRotationState.delete(comboName);
    clearStickyComboSession(comboName);
  } else {
    comboRotationState.clear();
    clearStickyComboSession();
  }
}

/**
 * Get combo models from combos data
 * @param {string} modelStr - Model string to check
 * @param {Array|Object} combosData - Array of combos or object with combos
 * @returns {string[]|null} Array of models or null if not a combo
 */
export function getComboModelsFromData(modelStr, combosData) {
  // Don't check if it's in provider/model format
  if (modelStr.includes("/")) return null;
  
  // Handle both array and object formats
  const combos = Array.isArray(combosData) ? combosData : (combosData?.combos || []);
  
  const combo = combos.find(c => c.name === modelStr);
  if (combo && combo.models && combo.models.length > 0) {
    return combo.models;
  }
  return null;
}

/**
 * Combine multiple AbortSignals into one. The returned signal aborts as soon as
 * any source aborts. Sources that are not AbortSignal instances are ignored.
 */
function combineSignals(...signals) {
  const sources = signals.filter((s) => s && typeof s.addEventListener === "function");
  if (sources.length === 0) return null;
  if (sources.length === 1) return sources[0];

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  const registered = [];

  for (const sig of sources) {
    if (sig.aborted) {
      for (const s of registered) s.removeEventListener("abort", onAbort);
      controller.abort();
      return controller.signal;
    }
    sig.addEventListener("abort", onAbort, { once: true });
    registered.push(sig);
  }

  return controller.signal;
}

/**
 * In-memory active request tracking per target/model
 * @type {Map<string, number>}
 */
const activeRequestsMap = new Map();

/**
 * Get the current active/in-flight request count for a target
 * @param {string|object} target
 * @returns {number}
 */
export function getActiveRequests(target) {
  const key = descriptorKey(target);
  return activeRequestsMap.get(key) || 0;
}

/**
 * Increment active request count for a target
 * @param {string|object} target
 */
export function trackActiveRequestStart(target) {
  const key = descriptorKey(target);
  if (!key) return;
  activeRequestsMap.set(key, (activeRequestsMap.get(key) || 0) + 1);
}

/**
 * Decrement active request count for a target
 * @param {string|object} target
 */
export function trackActiveRequestEnd(target) {
  const key = descriptorKey(target);
  if (!key) return;
  const current = activeRequestsMap.get(key) || 0;
  if (current <= 1) {
    activeRequestsMap.delete(key);
  } else {
    activeRequestsMap.set(key, current - 1);
  }
}

/**
 * Reset all active request counters (for testing or reconfig)
 */
export function resetActiveRequests() {
  activeRequestsMap.clear();
}

/**
 * Calculate candidate load score for P2C selection.
 * Lower load score = healthier/less loaded candidate.
 * @param {string|object} target
 * @param {object} [options]
 * @returns {number}
 */
export function getTargetLoad(target, options = {}) {
  const modelStr = descriptorKey(target);
  const provider = modelStr.split("/")[0] || "";

  // 1. In-flight active request count
  const activeCount = getActiveRequests(modelStr);

  // 2. Circuit breaker health
  let breakerPenalty = 0;
  try {
    const breaker = getCircuitBreaker(provider);
    if (breaker) {
      if (breaker.state === STATE.OPEN) {
        breakerPenalty += 10000;
      } else if (breaker.state === STATE.HALF_OPEN) {
        breakerPenalty += 50;
      } else if (breaker.state === STATE.DEGRADED) {
        breakerPenalty += 20;
      }
      breakerPenalty += (breaker.failureCount || 0) * 5;
    }
  } catch {
    // Fail-safe if circuit breaker is not accessible
  }

  // 3. Target queue depth (from candidate object or passed options)
  const targetQueueDepth = (typeof target === "object" && Number.isFinite(target?.queueDepth))
    ? target.queueDepth
    : 0;

  return activeCount + breakerPenalty + targetQueueDepth;
}

/**
 * Power of Two Choices (P2C) target ordering:
 * Randomly selects two distinct candidates, evaluates their load and connection health,
 * and orders the least loaded candidate first, followed by the second candidate and the rest.
 *
 * @param {Array<string|object>} targets - Array of target models or target objects
 * @param {object} [options] - Options (log, comboName, queueDepth)
 * @returns {Array<string|object>} Reordered targets array
 */
export function orderTargetsByPowerOfTwoChoices(targets, options = {}) {
  if (!Array.isArray(targets) || targets.length <= 1) return targets ? [...targets] : [];

  // Pick two distinct random indices
  const idx1 = Math.floor(Math.random() * targets.length);
  let idx2 = Math.floor(Math.random() * (targets.length - 1));
  if (idx2 >= idx1) idx2++;

  const target1 = targets[idx1];
  const target2 = targets[idx2];

  const load1 = getTargetLoad(target1, options);
  const load2 = getTargetLoad(target2, options);

  // Pick the one with lower load
  const selectedIndex = load2 < load1 ? idx2 : idx1;
  const chosen = targets[selectedIndex];

  if (options?.log?.info) {
    const chosenStr = typeof chosen === "string" ? chosen : (chosen?.model || chosen?.modelStr);
    options.log.info("COMBO", `P2C selected ${chosenStr} (load1: ${load1}, load2: ${load2})`);
  }

  return [chosen, ...targets.filter((_, idx) => idx !== selectedIndex)];
}

/**
 * Context-Relay Strategy: Session & Cache-Aware Affinity Map
 * Tracks active sessions and anchors them to specific targets to maximize
 * upstream prompt cache hits (e.g. Anthropic Claude, Gemini, DeepSeek).
 * When an anchored candidate fails or trips the circuit breaker, it seamlessly
 * fails over to the next healthy candidate and re-anchors the session.
 */
const sessionContextMap = new Map();
const SESSION_CONTEXT_TTL_MS = 30 * 60 * 1000; // 30 min affinity
const SESSION_CONTEXT_MAX_ENTRIES = 10_000;

export function resetContextRelay() {
  sessionContextMap.clear();
}

/**
 * After a successful upstream request on a Context-Relay session, commit the
 * winning connectionId so the next request for the same session pins to the
 * same upstream account (account-aware affinity).
 * @param {string} sessionKey - opaque key returned via options.onAffinityKey
 * @param {string} connectionId
 */
export function commitContextRelayAffinity(sessionKey, connectionId, targetKey) {
  if (!sessionKey || !connectionId || !targetKey) return;
  incrementMetric("router_affinity_events_total", { outcome: "committed" });
  const now = Date.now();
  // ponytail: an in-process binding is enough until cross-process affinity is required.
  sessionContextMap.delete(sessionKey);
  sessionContextMap.set(sessionKey, {
    descriptor: makeDescriptor(targetKey, connectionId),
    targetKey,
    connectionId,
    anchoredAt: now,
    lastSeenAt: now,
  });
  while (sessionContextMap.size > SESSION_CONTEXT_MAX_ENTRIES) {
    sessionContextMap.delete(sessionContextMap.keys().next().value);
  }
}

/**
 * After a failover (account error), invalidate the pinned connectionId so the
 * next attempt for this session selects a new account.
 * @param {string} sessionKey
 * @param {string} connectionId - only clears if it matches the currently pinned id
 */
export function invalidateContextRelayAffinity(sessionKey, connectionId) {
  const entry = sessionContextMap.get(sessionKey);
  if (entry && entry.connectionId === connectionId) {
    sessionContextMap.delete(sessionKey);
    incrementMetric("router_affinity_events_total", { outcome: "invalidated" });
  }
}

function affinityId(...parts) {
  return createHash("sha256").update(parts.map((part) => String(part || "")).join("\0")).digest("hex");
}

export function orderTargetsByContextRelay(targets, options = {}) {
  if (!Array.isArray(targets) || targets.length === 0) return [];

  const now = Date.now();
  // Prune stale sessions
  for (const [id, entry] of sessionContextMap.entries()) {
    if (now - entry.lastSeenAt > SESSION_CONTEXT_TTL_MS) {
      sessionContextMap.delete(id);
      incrementMetric("router_affinity_events_total", { outcome: "expired" });
    }
  }

  const sessionId = options.sessionId;
  if (!sessionId) {
    incrementMetric("router_affinity_events_total", { outcome: "disabled" });
    return [...targets];
  }

  const sessionKey = affinityId(options.tenantScope, options.comboName || "default", sessionId);
  const sessionCorrelation = sessionKey.slice(0, 12);
  const existing = sessionContextMap.get(sessionKey);
  if (!existing) incrementMetric("router_affinity_events_total", { outcome: "miss" });

  const isHealthy = (target) => {
    try {
      const modelStr = descriptorKey(target);
      const slashIdx = modelStr.indexOf("/");
      const provider = slashIdx !== -1 ? modelStr.slice(0, slashIdx) : modelStr;
      const targetBreaker = getCircuitBreaker(modelStr, {});
      if (targetBreaker && targetBreaker.state === STATE.OPEN) return false;
      const providerBreaker = getCircuitBreaker(provider, {});
      if (providerBreaker && providerBreaker.state === STATE.OPEN) return false;
      return true;
    } catch {
      return true;
    }
  };
  const getTargetKey = (t) => descriptorKey(t);

  let targetIndex = -1;
  if (existing) {
    targetIndex = targets.findIndex((t) => getTargetKey(t) === existing.targetKey);
    // If the anchored target is still in the pool and healthy, keep it!
    if (targetIndex !== -1 && isHealthy(targets[targetIndex])) {
      incrementMetric("router_affinity_events_total", { outcome: "hit" });
      existing.lastSeenAt = now;
      sessionContextMap.delete(sessionKey);
      sessionContextMap.set(sessionKey, existing);
      if (options?.log?.info) {
        options.log.info("COMBO", `Context-Relay: cache hit affinity ${sessionCorrelation} -> ${existing.targetKey}`);
      }
      // Expose key + existing connectionId so caller can re-pin to same account
      if (typeof options.onAffinityKey === "function") {
        options.onAffinityKey(sessionKey, existing.connectionId || null, existing.targetKey);
      }
      const chosen = targets[targetIndex];
      return [chosen, ...targets.filter((_, i) => i !== targetIndex)];
    }
    sessionContextMap.delete(sessionKey);
  }

  // If no existing anchor or anchored target became unhealthy: pick the first healthy candidate
  const healthyIndex = targets.findIndex(isHealthy);
  const selectedIndex = healthyIndex !== -1 ? healthyIndex : 0;
  const newTarget = targets[selectedIndex];
  const newTargetKey = getTargetKey(newTarget);
  if (options?.log?.info) {
    options.log.info("COMBO", `Context-Relay: candidate affinity ${sessionCorrelation} -> ${newTargetKey}`);
  }

  // Expose session key + preferred connectionId to caller for commit/invalidate
  if (typeof options.onAffinityKey === "function") {
    options.onAffinityKey(sessionKey, null, newTargetKey);
  }

  return [newTarget, ...targets.filter((_, i) => i !== selectedIndex)];
}

/**
 * In-memory registry for account/provider quota reset timestamps and quota state.
 * Allows quota fetchers, background sync, or tests to register known quota resets.
 * @type {Map<string, object|string|number>}
 */
const quotaResetRegistry = new Map();

/**
 * Register account quota reset information
 * @param {string} providerOrKey - Provider name or connection ID or model string
 * @param {object|string|number} resetInfo - ISO string, timestamp ms, or object { resetAt, limitReached, ... }
 */
export function registerAccountQuotaReset(providerOrKey, resetInfo) {
  if (!providerOrKey) return;
  quotaResetRegistry.set(providerOrKey, resetInfo);
}

/**
 * Get registered quota reset info
 * @param {string} providerOrKey
 * @returns {object|string|number|null}
 */
export function getAccountQuotaReset(providerOrKey) {
  return quotaResetRegistry.get(providerOrKey) || null;
}

/**
 * Clear quota reset registry (for tests)
 */
export function clearAccountQuotaResets() {
  quotaResetRegistry.clear();
}

/**
 * Parse an arbitrary value into a timestamp in milliseconds
 * @param {unknown} val
 * @returns {number|null}
 */
export function parseResetTimestampMs(val) {
  if (!val) return null;
  if (typeof val === "number" && Number.isFinite(val)) {
    return val < 10_000_000_000 ? val * 1000 : val;
  }
  if (typeof val === "string") {
    const parsed = Date.parse(val);
    if (Number.isFinite(parsed)) return parsed;
    if (/^\d+(\.\d+)?$/.test(val)) {
      const num = Number(val);
      return num < 10_000_000_000 ? num * 1000 : num;
    }
  }
  if (typeof val === "object" && val !== null) {
    const candidate =
      val.resetAt ??
      val.quotaResetsAt ??
      val.resetsAt ??
      val.resetTime ??
      val.quotaResetDate ??
      val.periodEnd ??
      val.window7d?.resetAt ??
      val.windowWeekly?.resetAt ??
      val.windowMonthly?.resetAt ??
      val.rateLimitedUntil ??
      val.providerSpecificData?.resetAt ??
      val.providerSpecificData?.quotaResetDate ??
      val.providerSpecificData?.resetsAt ??
      val.providerSpecificData?.periodEnd;
    if (candidate) return parseResetTimestampMs(candidate);
  }
  return null;
}

/**
 * Check if a candidate target's quota is exhausted
 * @param {string|object} target
 * @param {string} provider
 * @returns {boolean}
 */
function isTargetQuotaExhausted(target, provider) {
  // Check target object itself
  if (typeof target === "object" && target !== null) {
    if (target.limitReached === true || target.exhausted === true) return true;
    if (target.remaining === 0 || target.remainingPercentage === 0) return true;
  }

  // Check registry by model or provider
  const modelStr = descriptorKey(target);
  const modelInfo = quotaResetRegistry.get(modelStr);
  if (modelInfo && typeof modelInfo === "object") {
    if (modelInfo.limitReached === true || modelInfo.remaining === 0) return true;
  }
  const provInfo = quotaResetRegistry.get(provider);
  if (provInfo && typeof provInfo === "object") {
    if (provInfo.limitReached === true || provInfo.remaining === 0) return true;
  }

  // Check circuit breaker
  try {
    const breaker = getCircuitBreaker(provider);
    if (breaker && breaker.state === STATE.OPEN) return true;
  } catch {
    // Fail-safe
  }

  return false;
}

/**
 * Find the earliest upcoming quota reset timestamp for a target/provider
 * @param {string|object} target
 * @param {string} provider
 * @param {object} [options]
 * @returns {Promise<number|null>}
 */
async function resolveEarliestResetMs(target, provider, options = {}) {
  const now = Date.now();
  let earliest = null;

  const check = (val) => {
    const ms = parseResetTimestampMs(val);
    if (ms && Number.isFinite(ms) && ms > now) {
      if (earliest === null || ms < earliest) {
        earliest = ms;
      }
    }
  };

  // 1. Direct target property
  check(target);

  // 2. Registry entry for model or provider
  const modelStr = descriptorKey(target);
  check(quotaResetRegistry.get(modelStr));
  check(quotaResetRegistry.get(provider));

  // 3. Check connections (passed in options or loaded dynamically)
  let connections = options.connections;
  if (!connections) {
    try {
      const { getProviderConnections } = await import("../../src/lib/db/repos/connectionsRepo.js");
      connections = await getProviderConnections({ provider, isActive: true });
    } catch {
      connections = [];
    }
  }
  if (Array.isArray(connections)) {
    for (const conn of connections) {
      if (conn && conn.provider === provider && conn.isActive !== false) {
        check(conn);
      }
    }
  }

  return earliest;
}

/** 48 hours in milliseconds */
export const RESET_AWARE_EXPIRING_WINDOW_MS = 48 * 60 * 60 * 1000;

/**
 * Reset-Aware Quota Scheduling:
 * Inspects account quota reset timestamps (especially accounts resetting in < 48 hours)
 * and sorts/prioritizes them first so expiring monthly free tokens are used before resetting.
 *
 * Tiers:
 * 1. Expiring soon (< 48 hours): sorted ascending by msUntilReset (resets soonest first)
 * 2. Scheduled reset (> 48 hours): sorted ascending by msUntilReset
 * 3. Unknown / No reset timestamp: retains original relative priority
 * 4. Quota exhausted / Limit reached: demoted to the end
 *
 * @param {Array<string|object>} targets - Candidate models or target objects
 * @param {object} [options] - Options (log, comboName, connections, expiringWindowMs)
 * @returns {Promise<Array<string|object>>}
 */
export async function orderTargetsByResetAware(targets, options = {}) {
  if (!Array.isArray(targets) || targets.length <= 1) return targets ? [...targets] : [];

  const now = Date.now();
  const expiringWindowMs = Number.isFinite(options?.expiringWindowMs) && options.expiringWindowMs > 0
    ? options.expiringWindowMs
    : RESET_AWARE_EXPIRING_WINDOW_MS;

  const scoredTargets = await Promise.all(
    targets.map(async (target, index) => {
      const modelStr = descriptorKey(target);
      const provider = modelStr.split("/")[0] || "";

      const exhausted = isTargetQuotaExhausted(target, provider);
      if (exhausted) {
        return { target, index, tier: 4, msUntilReset: Infinity, modelStr };
      }

      const earliestResetMs = await resolveEarliestResetMs(target, provider, options);

      if (earliestResetMs && Number.isFinite(earliestResetMs) && earliestResetMs > now) {
        const msUntilReset = earliestResetMs - now;
        if (msUntilReset <= expiringWindowMs) {
          // Tier 1: Expiring in < 48 hours — prioritize!
          return { target, index, tier: 1, msUntilReset, modelStr };
        }
        // Tier 2: Resets in > 48 hours
        return { target, index, tier: 2, msUntilReset, modelStr };
      }

      // Tier 3: No known future reset timestamp
      return { target, index, tier: 3, msUntilReset: Infinity, modelStr };
    })
  );

  // Sort: Tier 1 (< 48h) first, then Tier 2, then Tier 3, then Tier 4 (exhausted).
  // Within Tier 1 and 2, sort ascending by msUntilReset (earliest reset first).
  // Ties preserve original combo order.
  scoredTargets.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.tier === 1 || a.tier === 2) {
      // 1-minute tie-band to avoid jitter on nearly identical reset times
      if (Math.abs(a.msUntilReset - b.msUntilReset) > 60_000) {
        return a.msUntilReset - b.msUntilReset;
      }
    }
    return a.index - b.index;
  });

  if (options?.log?.info) {
    const first = scoredTargets[0];
    const firstStr = descriptorKey(first?.target);
    const timeDesc = first?.msUntilReset !== Infinity ? `${Math.round(first.msUntilReset / 3600000)}h` : "unknown";
    options.log.info("COMBO", `Reset-Aware selected ${firstStr} (tier: ${first?.tier}, resets in: ${timeDesc})`);
  }

  return scoredTargets.map((item) => item.target);
}

/**
 * Detect whether a 2xx JSON response contains zero usable content
 * (e.g. empty assistant message with in_progress/incomplete)
 * so combo fallback can continue to the next model.
 */
export function isZeroContentResponse(data) {
  if (!data || typeof data !== "object") return false;

  // OpenAI chat format
  if (Array.isArray(data.choices)) {
    if (data.choices.length === 0) return true;
    const choice = data.choices[0];
    if (!choice) return true;

    const msg = choice.message || choice.delta;
    const content = msg?.content;
    const hasContent = typeof content === "string" ? content.trim().length > 0 : (Array.isArray(content) && content.length > 0);
    const hasToolCalls = (Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0) || Boolean(msg?.function_call);
    const hasReasoning = typeof msg?.reasoning_content === "string" ? msg.reasoning_content.trim().length > 0 : false;

    const finish = choice.finish_reason;
    const isNormalFinish = finish === "stop" || finish === "length" || finish === "tool_calls" || finish === "function_call";

    if (!hasContent && !hasToolCalls && !hasReasoning && (!isNormalFinish || finish === "in_progress" || finish === "incomplete")) {
      return true;
    }
  }

  // Anthropic messages format
  if (Array.isArray(data.content)) {
    const hasContent = data.content.some((c) => (c.type === "text" && c.text?.trim().length > 0) || c.type === "tool_use");
    const stopReason = data.stop_reason;
    if (!hasContent && (!stopReason || stopReason === "in_progress" || stopReason === "incomplete")) {
      return true;
    }
  }

  return false;
}

/**
 * Handle combo chat with fallback
 * @param {Object} options
 * @param {Object} options.body - Request body
 * @param {Array<string|object>} options.models - Array of model strings or target objects to try
 * @param {Function} options.handleSingleModel - Function to handle single model: (body, modelStr, opts) => Promise<Response>
 * @param {Object} options.log - Logger object
 * @param {string} [options.comboName] - Name of the combo
 * @param {string} [options.comboStrategy] - Strategy: "fallback", "round-robin", "p2c", "reset-aware", "context-relay", or "smart"
 * @param {number|string} [options.comboStickyLimit=1] - Requests per combo model before switching
 * @param {boolean} [options.autoSwitch=true] - Reorder by capability fit
 * @param {AbortSignal} [options.signal=null] - Optional external signal (e.g. client disconnect) that aborts every target
 * @param {number} [options.timeoutMs=DEFAULT_COMBO_TARGET_TIMEOUT_MS] - Max time to wait for headers
 * @param {number} [options.queueDepth=null] - Optional per-combo account queue depth
 * @param {Array<object>} [options.connections=null] - Optional preloaded connections
 * @param {string|null} [options.sessionId=null] - Client session identifier (smart-router stickiness / context-relay affinity / prompt cache retention)
 * @param {string|null} [options.tenantScope=null] - Tenant scope mixed into the context-relay affinity key
 * @param {Function|null} [options.onAffinityKey=null] - Context-relay hook: (sessionKey, preferredConnectionId, targetKey) => void
 * @param {string} [options.smartPolicy="smart"] - Policy: "smart" (adaptive ≥80%), "strict" (lock 1st model), "per-turn", or "custom"
 * @param {boolean} [options.sessionSticky=true] - Keep chosen model across session requests to retain prompt cache
 * @param {number} [options.confidenceThreshold=0.8] - Minimum confidence required for model switch (0-1)
 * @param {Function|null} [options.resolveSmartChoice=null] - Smart router resolver callback: (body, models) => Promise<{ choice, probabilities, confidence } | null>
 * @returns {Promise<Response>}
 */
export async function handleComboChat({
  body,
  models,
  handleSingleModel,
  log,
  comboName,
  comboStrategy,
  comboStickyLimit = 1,
  autoSwitch = true,
  signal = null,
  timeoutMs = DEFAULT_COMBO_TARGET_TIMEOUT_MS,
  queueDepth = null,
  connections = null,
  sessionId = null,
  tenantScope = null,
  onAffinityKey = null,      // (sessionKey, preferredConnectionId, targetKey) => void
  smartPolicy = "smart",
  sessionSticky = true,
  confidenceThreshold = 0.8,
  resolveSmartChoice = null,
}) {
  // Account-aware Context-Relay: capture affinity key + preferred connectionId
  // so the first model selection can pin to the same upstream account.
  let _affinityKey = null;
  let _preferredConnectionId = null;
  let _preferredTargetKey = null;

  const captureAffinityKey = typeof onAffinityKey === "function"
    ? (key, connId, targetKey) => { _affinityKey = key; _preferredConnectionId = connId; _preferredTargetKey = targetKey; onAffinityKey(key, connId, targetKey); }
    : (key, connId, targetKey) => { _affinityKey = key; _preferredConnectionId = connId; _preferredTargetKey = targetKey; };

  // Apply strategy. Default "fallback" tries the models in the given order.
  let rotatedModels = Array.isArray(models) ? [...models] : [];
  let activeStickyModel = null;

  if (comboStrategy === "smart") {
    const policy = (typeof smartPolicy === "string" ? smartPolicy : "smart").toLowerCase();
    const isPerTurn = policy === "per-turn" || sessionSticky === false;
    const isStrict = policy === "strict";

    let switchThreshold = 0.8;
    if (policy === "custom") {
      const custom = Number(confidenceThreshold);
      if (Number.isFinite(custom) && custom > 0) switchThreshold = custom;
    } else if (policy === "smart-switch-70") switchThreshold = 0.7;
    else if (policy === "smart-switch-90") switchThreshold = 0.9;
    else if (policy.startsWith("smart-switch") || policy === "smart") {
      const custom = Number(confidenceThreshold);
      if (Number.isFinite(custom) && custom > 0) switchThreshold = custom;
    }

    if (!isPerTurn && sessionId) {
      activeStickyModel = getStickyComboModel(comboName, sessionId, models);
    }

    if (activeStickyModel) {
      if (isStrict) {
        // Strict Lock: re-use sticky model without invoking System One (0ms, 0 extra tokens)
        rotatedModels = [activeStickyModel, ...models.filter((m) => m !== activeStickyModel)];
        log.info("COMBO", `smart-router [strict] locked session "${sessionId}" → ${activeStickyModel}`);
      } else if (typeof resolveSmartChoice === "function") {
        // Smart Switch (Adaptive): check if the user's task drastically shifted
        try {
          const smartResult = await resolveSmartChoice(body, models);
          const newChoice = smartResult?.choice;
          const conf = typeof smartResult?.confidence === "number" ? smartResult.confidence : null;

          if (newChoice && newChoice !== activeStickyModel && models.includes(newChoice) && conf !== null && conf >= switchThreshold) {
            // Task changed with high confidence: switch model and update session
            rotatedModels = orderModelsByChoice(models, smartResult);
            log.info("COMBO", `smart-router [smart-switch] task changed → switched from ${activeStickyModel} to ${newChoice} (confidence: ${conf} >= ${switchThreshold})`);
            if (sessionId) {
              setStickyComboModel(comboName, sessionId, newChoice);
              activeStickyModel = newChoice;
            }
          } else {
            // Stay on current model to preserve warm prompt cache
            rotatedModels = [activeStickyModel, ...models.filter((m) => m !== activeStickyModel)];
            log.info("COMBO", `smart-router [smart-switch] retained prompt cache model "${activeStickyModel}"`);
          }
        } catch (err) {
          // Fail open to active sticky model
          rotatedModels = [activeStickyModel, ...models.filter((m) => m !== activeStickyModel)];
          log.warn("COMBO", `smart-router error, retained model "${activeStickyModel}"`, { error: err?.message || String(err) });
        }
      } else {
        rotatedModels = [activeStickyModel, ...models.filter((m) => m !== activeStickyModel)];
      }
    } else if (typeof resolveSmartChoice === "function") {
      // Turn 1 or per-turn: evaluate System One to select initial model
      try {
        const smartResult = await resolveSmartChoice(body, models);
        const conf = typeof smartResult?.confidence === "number" ? smartResult.confidence : null;

        if (smartResult?.choice && models.includes(smartResult.choice)) {
          if (switchThreshold > 0 && conf !== null && conf < switchThreshold) {
            log.info("COMBO", `smart-router confidence (${conf}) below threshold (${switchThreshold}), fallback to order: [${models.join(", ")}]`);
          } else {
            rotatedModels = orderModelsByChoice(models, smartResult);
            log.info("COMBO", `smart-router selected ${smartResult.choice} (confidence: ${conf ?? "N/A"})`);
            if (!isPerTurn && sessionId) {
              setStickyComboModel(comboName, sessionId, smartResult.choice);
              activeStickyModel = smartResult.choice;
            }
          }
        } else {
          log.info("COMBO", `smart-router no decision, fallback to order: [${models.join(", ")}]`);
        }
      } catch (err) {
        log.warn("COMBO", `smart-router error, fallback to order: [${models.join(", ")}]`, { error: err?.message || String(err) });
      }
    }
  } else if (comboStrategy === "p2c") {
    rotatedModels = orderTargetsByPowerOfTwoChoices(models, { comboName, log, queueDepth });
  } else if (comboStrategy === "reset-aware") {
    rotatedModels = await orderTargetsByResetAware(models, { comboName, log, connections, queueDepth });
  } else if (comboStrategy === "context-relay") {
    rotatedModels = orderTargetsByContextRelay(models, { comboName, sessionId, tenantScope, log, queueDepth, onAffinityKey: captureAffinityKey });
  } else if (comboStrategy === "round-robin") {
    rotatedModels = getRotatedModels(models, comboName, comboStrategy, comboStickyLimit);
  }

  // Auto-switch: float models that satisfy the request's required capabilities to the front.
  if (autoSwitch) {
    const required = detectRequiredCapabilities(body);
    if (required.size > 0) {
      const reordered = reorderByCapabilities(rotatedModels, required);
      if (reordered[0] !== rotatedModels[0]) {
        const firstStr = typeof reordered[0] === "string" ? reordered[0] : (reordered[0]?.model || reordered[0]?.modelStr);
        log.info("COMBO", `auto-switch for [${[...required].join(",")}] → ${firstStr}`);
      }
      rotatedModels = reordered;
    }
  }
  
  let lastError = null;
  let earliestRetryAfter = null;
  let lastStatus = null;
  let requestScopedResult = null;

  for (let i = 0; i < rotatedModels.length; i++) {
    const target = rotatedModels[i];
    const modelStr = descriptorKey(target);
    const targetConnectionId = descriptorConnectionId(target);

    // Per-target timeout overrides combo-level timeout if specified
    const effectiveTimeoutMs = (typeof target === "object" && Number.isFinite(target?.targetTimeoutMs))
      ? target.targetTimeoutMs
      : timeoutMs;

    // Honor external abort before trying the next target.
    if (signal?.aborted) {
      log.info("COMBO", "External signal aborted — stopping combo fallback");
      return new Response(
        JSON.stringify({ error: { message: "Client disconnected" } }),
        { status: 499, headers: { "Content-Type": "application/json" } }
      );
    }

    log.info("COMBO", `Trying model ${i + 1}/${rotatedModels.length}: ${modelStr}`);

    const addAffinityOptions = (targetOptions, targetSignal) => {
      if (i === 0 && _preferredConnectionId && modelStr === _preferredTargetKey) targetOptions.preferredConnectionId = _preferredConnectionId;
      else if (targetConnectionId) targetOptions.preferredConnectionId = targetConnectionId;
      if (!_affinityKey) return;
      targetOptions._affinityKey = _affinityKey;
      targetOptions._invalidateAffinity = (...args) => {
        if (!targetSignal?.aborted) invalidateContextRelayAffinity(...args);
      };
      targetOptions._commitAffinity = (...args) => {
        if (!targetSignal?.aborted) commitContextRelayAffinity(...args);
      };
    };

    // A member that can fall through to another member must not sit out a
    // rate-limit cooldown (see cooldownRetry.js); only the last candidate may.
    const addFallbackOptions = (targetOptions) => {
      if (i < rotatedModels.length - 1) targetOptions.hasFallbackTarget = true;
    };

    try {
      let result;
      trackActiveRequestStart(modelStr);

      try {
        if (!Number.isFinite(effectiveTimeoutMs) || effectiveTimeoutMs <= 0) {
          const targetOptions = {};
          if (signal) targetOptions.signal = signal;
          if (queueDepth != null) targetOptions.maxQueueSize = queueDepth;
          addAffinityOptions(targetOptions, signal);
          addFallbackOptions(targetOptions);
          result = await handleSingleModel(body, modelStr, Object.keys(targetOptions).length > 0 ? targetOptions : undefined);
        } else {
          const timeoutController = new AbortController();
          let timeoutId;
          let timedOut = false;

          const targetSignal = combineSignals(signal, timeoutController.signal);
          const targetOptions = {};
          if (targetSignal) targetOptions.signal = targetSignal;
          if (queueDepth != null) targetOptions.maxQueueSize = queueDepth;
          addAffinityOptions(targetOptions, targetSignal);
          addFallbackOptions(targetOptions);

          const timeoutPromise = new Promise((resolve) => {
            timeoutId = setTimeout(() => {
              timedOut = true;
              log.warn("COMBO", `Model ${modelStr} exceeded ${effectiveTimeoutMs}ms timeout — falling back`);
              timeoutController.abort(new Error("combo-per-model-timeout"));
              resolve(
                new Response(
                  JSON.stringify({ error: { message: `Model ${modelStr} timed out` } }),
                  { status: 524, headers: { "Content-Type": "application/json" } }
                )
              );
            }, effectiveTimeoutMs);
          });

          try {
            result = await Promise.race([
              Promise.resolve(handleSingleModel(body, modelStr, Object.keys(targetOptions).length > 0 ? targetOptions : undefined)).catch((err) => {
                if (timedOut) return; // discard — timeoutPromise already resolved with 524; do not return a 599 sentinel
                throw err;
              }),
              timeoutPromise,
            ]);
          } finally {
            clearTimeout(timeoutId);
          }
        }
      } finally {
        trackActiveRequestEnd(modelStr);
      }
      
      // Success (2xx). A 2xx is necessary but NOT sufficient: Gemini aborts (e.g.
      // MALFORMED_FUNCTION_CALL) still return 200 and stream empty content, which would
      // otherwise be delivered as a successful empty answer with no failover.
      // Peek the stream for real content before committing to this candidate.
      if (result.ok) {
        let peeked = null;
        try {
          peeked = await peekComboResponse(result, log);
        } catch (peekErr) {
          // peekStreamForContent is written not to throw; if reconstruction/Response
          // construction ever does, result.body is already locked by getReader() and can no
          // longer be streamed. Returning `result` would hand the client a locked, unreadable
          // body. Degrade to a clean, valid (empty) SSE stream instead.
          log.warn("COMBO", `empty-peek error on ${modelStr}, returning empty SSE: ${peekErr?.message || peekErr}`);
          return new Response("data: [DONE]\n\n", {
            status: 200,
            headers: { "Content-Type": "text/event-stream" },
          });
        }

        if (!peeked) {
          // Non-streaming (or non-SSE) response — not this peek's job. The zero-content
          // JSON check still applies on a non-final seat.
          const isLastModel = i === rotatedModels.length - 1;
          if (!isLastModel) {
            const contentType = result.headers?.get?.("content-type") || "";
            if (contentType.includes("application/json")) {
              try {
                const peekBody = await result.clone().json();
                if (isZeroContentResponse(peekBody)) {
                  log.warn("COMBO", `Model ${modelStr} returned HTTP 200 with zero usable content, falling back to next model`);
                  if (comboStrategy === "smart" && sessionId && modelStr === activeStickyModel) {
                    clearStickyComboSession(comboName, sessionId);
                  }
                  lastError = "Zero usable content";
                  lastStatus = 200;
                  continue;
                }
              } catch {
                // Ignore JSON parse errors
              }
            }
          }

          log.info("COMBO", `Model ${modelStr} succeeded`);
          return result;
        }

        if (peeked.outcome === "content") {
          log.info("COMBO", `Model ${modelStr} succeeded${peeked.timedOut ? " (peek deadline; committed)" : ""}`);
          return peeked.response;
        }

        // Empty generation. Fall through to the next candidate unless this is a legitimately
        // empty class (content filter) or the last candidate — in which case return the
        // (empty) response as-is, preserving prior behaviour rather than manufacturing a 5xx.
        const reasonLabel = peeked.finishReason || "no-content";
        const isLast = i === rotatedModels.length - 1;
        if (isNoRetryFinish(peeked.finishReason) || isLast) {
          log.warn("COMBO", `Model ${modelStr} returned empty (${reasonLabel}) — ${isNoRetryFinish(peeked.finishReason) ? "no-retry class" : "last candidate"}, returning as-is`);
          return peeked.response;
        }

        log.warn("COMBO", `Model ${modelStr} returned empty (${reasonLabel}) — falling through to next candidate`);
        if (comboStrategy === "smart" && sessionId && modelStr === activeStickyModel) {
          clearStickyComboSession(comboName, sessionId);
        }
        // Drain/close the discarded stream in the background so its usage logging still runs.
        peeked.response.body?.cancel?.().catch(() => {});
        lastError = `empty generation (${reasonLabel})`;
        if (!lastStatus) lastStatus = 502;
        continue;
      }

      // If the model that failed was the session-sticky model, clear it so next turns re-evaluate
      if (comboStrategy === "smart" && sessionId && modelStr === activeStickyModel) {
        clearStickyComboSession(comboName, sessionId);
      }

      // Extract error info from response
      let errorText = result.statusText || "";
      let retryAfter = null;
      try {
        const errorBody = await result.clone().json();
        errorText = errorBody?.error?.message || errorBody?.error || errorBody?.message || errorText;
        retryAfter = errorBody?.retryAfter || null;
      } catch {
        // Ignore JSON parse errors
      }

      // Track earliest retryAfter across all combo models
      if (retryAfter && (!earliestRetryAfter || new Date(retryAfter) < new Date(earliestRetryAfter))) {
        earliestRetryAfter = retryAfter;
      }

      // Normalize error text to string (Worker-safe)
      if (typeof errorText !== "string") {
        try { errorText = JSON.stringify(errorText); } catch { errorText = String(errorText); }
      }

      // Check if should fallback to next model
      const { provider } = parseModel(modelStr);
      const { shouldFallback, cooldownMs, requestScoped } = checkFallbackError(result.status, errorText, 0, provider);

      if (!shouldFallback && !requestScoped) {
        log.warn("COMBO", `Model ${modelStr} failed (no fallback)`, { status: result.status });
        return result;
      }

      // A request-scoped 4xx (validation failure, unsupported parameter, context
      // overflow) says this member cannot serve THIS request — not that the
      // credential is unhealthy. Members run on different providers with
      // different validation, so the next member may well serve it. Advance
      // without a cooldown, and without waiting: there is nothing to recover.
      // checkFallbackError() reports no account fallback here on purpose (a
      // request-scoped fault must not evict a healthy account from rotation).
      if (requestScoped) {
        log.warn("COMBO", `Model ${modelStr} rejected the request (${result.status}), trying next`, { status: result.status });
        lastError = errorText || String(result.status);
        if (!lastStatus) lastStatus = result.status;
        if (!requestScopedResult) requestScopedResult = result;
        continue;
      }

      // For transient errors (503/502/504), wait for cooldown before falling through
      // so a briefly-overloaded provider gets a chance to recover rather than being
      // skipped immediately (fixes: combo falls through on transient 503)
      if (cooldownMs && cooldownMs > 0 && cooldownMs <= 5000 &&
          (result.status === 503 || result.status === 502 || result.status === 504)) {
        log.info("COMBO", `Model ${modelStr} transient ${result.status}, waiting ${cooldownMs}ms before next`);
        await new Promise(r => setTimeout(r, cooldownMs));
      }

      // Fallback to next model
      lastError = errorText || String(result.status);
      // Preserve the first failure status for the aggregated response.
      // Subsequent failures may override only when the first was a client error.
      if (!lastStatus) lastStatus = result.status;
      log.warn("COMBO", `Model ${modelStr} failed, trying next`, { status: result.status });
    } catch (error) {
      // Catch unexpected exceptions to ensure fallback continues
      if (comboStrategy === "smart" && sessionId && modelStr === activeStickyModel) {
        clearStickyComboSession(comboName, sessionId);
      }
      lastError = error.message || String(error);
      if (!lastStatus) lastStatus = 500;
      log.warn("COMBO", `Model ${modelStr} threw error, trying next`, { error: lastError });
    }
  }

  // At least one member rejected the request itself. Hand back that member's own
  // response — status and body — rather than the synthesized envelope below: the
  // synthesized one reaches the client as a 200 carrying an error object, which
  // reads as an empty success, and it buries the member that named the real cause.
  // This is also what the caller saw before combos advanced on these errors.
  if (requestScopedResult) {
    log.warn("COMBO", `No model served the request; returning the first request-scoped failure (${requestScopedResult.status})`);
    return requestScopedResult;
  }

  // All models failed
  // Use 503 (Service Unavailable) rather than 406 (Not Acceptable) — 406 implies
  // the request itself is invalid, but here the providers are simply unavailable
  // or have no active credentials. 503 is more accurate and retryable by clients.
  const allDisabled = lastError && lastError.toLowerCase().includes("no credentials");
  const status = allDisabled ? 503 : (lastStatus || 503);
  const msg = lastError || "All combo models unavailable";

  if (earliestRetryAfter) {
    const retryHuman = formatRetryAfter(earliestRetryAfter);
    log.warn("COMBO", `All models failed | ${msg} (${retryHuman})`);
    return unavailableResponse(status, msg, earliestRetryAfter, retryHuman);
  }

  log.warn("COMBO", `All models failed | ${msg}`);
  return new Response(
    JSON.stringify({ error: { message: msg } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

/**
 * Extract assistant text from a non-stream completion across formats
 * (OpenAI chat, Claude messages, Gemini, OpenAI Responses). Returns "" if none.
 * Panel responses are already translated to the client format by chatCore, so the
 * leaf content→string step reuses the translator's own extractTextContent.
 */
function extractPanelText(json) {
  if (!json || typeof json !== "object") return "";

  // OpenAI chat completion
  const choice = json.choices?.[0];
  if (choice) {
    const msg = choice.message ?? choice.delta ?? {};
    const t = extractTextContent(msg.content);
    if (t.trim()) return t;
    if (typeof choice.text === "string" && choice.text.trim()) return choice.text;
  }

  // Claude messages (text blocks share OpenAI's {type:"text"} shape)
  const claudeText = extractTextContent(json.content);
  if (claudeText.trim()) return claudeText;

  // Gemini (parts carry .text without a type discriminator)
  const parts = json.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const t = parts.map((p) => p?.text || "").join("");
    if (t.trim()) return t;
  }

  // OpenAI Responses API
  if (Array.isArray(json.output)) {
    const t = json.output
      .flatMap((o) => (Array.isArray(o.content) ? o.content.map((c) => c?.text || "") : []))
      .join("");
    if (t.trim()) return t;
  }

  return "";
}

/**
 * Append a synthesized user turn to whichever message array the request format uses.
 * Preserves the original conversation + system prompt so the judge has full context.
 */
function appendUserTurn(body, text) {
  const next = { ...body };
  if (Array.isArray(body.messages)) {
    next.messages = [...body.messages, { role: "user", content: text }];
  } else if (Array.isArray(body.input)) {
    next.input = [...body.input, { role: "user", content: text }];
  } else if (Array.isArray(body.contents)) {
    next.contents = [...body.contents, { role: "user", parts: [{ text }] }];
  } else {
    next.messages = [{ role: "user", content: text }];
  }
  return next;
}

/**
 * Build the judge directive. Per OpenRouter's Fusion design, the judge does NOT
 * merge — it analyzes (consensus / contradictions / partial coverage / unique
 * insights / blind spots) then writes one answer grounded in that analysis.
 * ~3/4 of fusion's quality lift comes from this synthesis step.
 *
 * Sources are anonymized ("Source N") so the judge weighs substance, not the
 * reputation of a model brand.
 */
function buildJudgePrompt(answers) {
  const panel = answers
    .map((a, i) => `[Source ${i + 1}]\n${a.text}`)
    .join("\n\n");

  return [
    `You are the JUDGE in a model-fusion panel. ${answers.length} expert models independently answered the user's most recent request. Their responses are below, anonymized by source.`,
    "",
    "Do NOT mention that multiple models were used, and do NOT refer to the sources. Produce ONE authoritative final answer addressed directly to the user.",
    "",
    "First, internally analyze the panel along these dimensions: consensus (points most sources agree on — treat as higher-confidence), contradictions (where they disagree — resolve with your own judgment), partial coverage, unique insights only one source surfaced, and blind spots every source missed. Then write the best possible final answer grounded in that analysis — more complete and correct than any single response, with no filler.",
    "",
    "=== PANEL RESPONSES ===",
    panel,
    "=== END PANEL RESPONSES ===",
    "",
    "Now write the final answer to the user's original request.",
  ].join("\n");
}

// Fusion tuning. Overridable per-combo via settings.comboStrategies[name].
const FUSION_DEFAULTS = {
  minPanel: 2,             // answers needed before stragglers get a grace window
  stragglerGraceMs: 8000,  // wait this long for laggards once quorum is reached
  panelHardTimeoutMs: 90000, // absolute cap so one hung model can't stall forever
};

// Resolve a Response (or {__error}) within ms; the loser keeps running but is ignored.
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ __timeout: true }), ms);
    Promise.resolve(promise)
      .then((v) => { clearTimeout(t); resolve(v); })
      .catch((e) => { clearTimeout(t); resolve({ __error: e }); });
  });
}

/**
 * Collect panel responses with quorum-grace: as soon as `minPanel` calls succeed,
 * start a short grace timer for the rest, then proceed with whatever arrived. This
 * caps the straggler penalty (the slowest model otherwise dominates wall time) while
 * still preferring a full panel when everyone is fast. Bounded by a hard timeout.
 * Returns a sparse array aligned to `calls` (undefined = not yet / dropped).
 */
function collectPanel(calls, { minPanel, stragglerGraceMs, panelHardTimeoutMs }) {
  return new Promise((resolve) => {
    const out = new Array(calls.length);
    let settled = 0;
    let ok = 0;
    let finished = false;
    let graceTimer = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(hardTimer);
      if (graceTimer) clearTimeout(graceTimer);
      resolve(out);
    };
    const hardTimer = setTimeout(finish, panelHardTimeoutMs);
    calls.forEach((p, i) => {
      Promise.resolve(p)
        .then((v) => { out[i] = v; })
        .catch((e) => { out[i] = { __error: e }; })
        .finally(() => {
          settled++;
          if (out[i] && out[i].ok) ok++;
          if (settled === calls.length) return finish();
          if (ok >= minPanel && !graceTimer) graceTimer = setTimeout(finish, stragglerGraceMs);
        });
    });
  });
}

/**
 * Handle a fusion combo: fan the prompt out to every panel model in parallel,
 * then a judge model synthesizes one final answer from all panel responses.
 *
 * Panel calls are forced non-streaming with tools stripped (the judge needs
 * complete prose to synthesize). The judge call keeps the client's original
 * stream flag + tools, so streaming and downstream tool use still work.
 *
 * Speed: quorum-grace collection caps the straggler penalty. Quality: the judge
 * runs the consensus/contradiction/blind-spot analysis before writing.
 *
 * Degrades gracefully: 0 panel answers -> 503, exactly 1 -> return it directly.
 *
 * @param {Object} options
 * @param {Object} options.body - Request body (client format)
 * @param {string[]} options.models - Panel model strings
 * @param {Function} options.handleSingleModel - (body, modelStr) => Promise<Response>
 * @param {Object} options.log - Logger
 * @param {string} [options.comboName] - Combo name (logging)
 * @param {string} [options.judgeModel] - Judge model; falls back to panel[0]
 * @param {Object} [options.tuning] - Override FUSION_DEFAULTS (minPanel, grace, timeout)
 * @returns {Promise<Response>}
 */
export async function handleFusionChat({ body, models, handleSingleModel, log, comboName, judgeModel, tuning }) {
  const panel = Array.isArray(models) ? models.filter(Boolean) : [];
  if (panel.length === 0) {
    return new Response(
      JSON.stringify({ error: { message: "Fusion combo has no models" } }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // A single-model fusion has nothing to fuse — just answer directly.
  if (panel.length === 1) {
    return handleSingleModel(body, panel[0]);
  }

  const cfg = { ...FUSION_DEFAULTS, ...(tuning || {}) };
  const minPanel = Math.min(Math.max(2, cfg.minPanel), panel.length);
  const judge = judgeModel && judgeModel.trim() ? judgeModel.trim() : panel[0];
  log.info("FUSION", `Combo "${comboName}" | panel=${panel.length} [${panel.join(", ")}] | judge=${judge} | quorum=${minPanel}`);

  // 1. Fan out to the panel in parallel: non-streaming, tools stripped (we want prose).
  const { tools, tool_choice, stream_options, ...rest } = body;
  // Fusion runs panel models non-streaming; drop stream_options too, or providers
  // like DeepSeek reject it with "stream_options should be set along with stream = true".
  // See issue #3024.
  const panelBody = { ...rest, stream: false };

  // Flatten tool turns to prose so panel models keep context without emitting tool_calls.
  if (Array.isArray(panelBody.messages)) {
    panelBody.messages = flattenToolHistory(panelBody.messages);
  } else if (Array.isArray(panelBody.input)) {
    panelBody.input = flattenToolHistory(panelBody.input);
  }

  const t0 = Date.now();
  const calls = panel.map((m) => withTimeout(handleSingleModel(panelBody, m, true), cfg.panelHardTimeoutMs));
  const settled = await collectPanel(calls, { ...cfg, minPanel });
  log.info("FUSION", `fan-out collected in ${Date.now() - t0}ms`);

  // 2. Collect successful answers.
  const answers = [];
  for (let i = 0; i < settled.length; i++) {
    const res = settled[i];
    const model = panel[i];
    if (!res) { log.warn("FUSION", `Panel ${model} dropped (straggler/timeout)`); continue; }
    if (res.__timeout) { log.warn("FUSION", `Panel ${model} timed out`); continue; }
    if (res.__error) { log.warn("FUSION", `Panel ${model} threw`, { error: res.__error?.message || String(res.__error) }); continue; }
    if (!res.ok) { log.warn("FUSION", `Panel ${model} failed`, { status: res.status }); continue; }
    try {
      const json = await res.clone().json();
      const text = extractPanelText(json);
      if (text) {
        answers.push({ model, text });
        log.info("FUSION", `Panel ${model} ok (${text.length} chars)`);
      } else {
        log.warn("FUSION", `Panel ${model} returned empty content`);
      }
    } catch (e) {
      log.warn("FUSION", `Panel ${model} unparseable`, { error: e.message || String(e) });
    }
  }

  // 3. Degrade gracefully when the panel is too thin to fuse.
  if (answers.length === 0) {
    log.warn("FUSION", "All panel models failed");
    return new Response(
      JSON.stringify({ error: { message: "All fusion panel models failed" } }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }
  if (answers.length === 1) {
    log.info("FUSION", `Only ${answers[0].model} succeeded — answering directly (no fusion)`);
    return handleSingleModel(body, answers[0].model);
  }

  // 4. Judge analyzes + writes one final answer (streams to client if requested).
  const judgeBody = appendUserTurn(body, buildJudgePrompt(answers));
  log.info("FUSION", `Judging ${answers.length} answers with ${judge}`);
  return handleSingleModel(judgeBody, judge);
}

export {
  getStickyComboModel,
  setStickyComboModel,
  clearStickyComboSession,
  orderModelsByChoice,
} from "./systemoneRouter.js";
