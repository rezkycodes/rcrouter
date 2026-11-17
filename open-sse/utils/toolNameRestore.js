// Response-side counterpart of translator/concerns/toolNameFit.js: restores the
// ORIGINAL tool name in what the client receives, so a shortened name never
// leaks out. Operates on the final CLIENT-shaped payload (OpenAI chat, Claude,
// OpenAI Responses, Gemini), independent of which translator or passthrough
// path produced it. Pure and fail-open: unknown shapes pass through untouched.

import { CLAUDE_BLOCK, RESPONSES_ITEM } from "../translator/schema/index.js";

const SSE_DATA_PREFIX = "data:";
const RESPONSES_EVENT_PREFIX = "response.";
const NAMED_OUTPUT_ITEM_TYPES = new Set([RESPONSES_ITEM.FUNCTION_CALL, RESPONSES_ITEM.CUSTOM_TOOL_CALL]);

const isObject = (value) => value !== null && typeof value === "object";

function mapList(list, fn) {
  if (!Array.isArray(list)) return list;
  let changed = false;
  const next = list.map((item) => {
    const mapped = fn(item);
    if (mapped !== item) changed = true;
    return mapped;
  });
  return changed ? next : list;
}

function setIfChanged(patch, key, current, next) {
  if (next !== current) patch[key] = next;
}

function renameField(node, key, map) {
  const current = node?.[key];
  const original = typeof current === "string" ? map.get(current) : undefined;
  return original === undefined ? node : { ...node, [key]: original };
}

/** OpenAI `{function:{name}}` call entries (stream deltas and full messages). */
function restoreCall(call, map) {
  if (!isObject(call?.function)) return call;
  const fn = renameField(call.function, "name", map);
  return fn === call.function ? call : { ...call, function: fn };
}

function restoreOpenAIMessage(message, map) {
  if (!isObject(message)) return message;
  const patch = {};
  setIfChanged(patch, "tool_calls", message.tool_calls, mapList(message.tool_calls, (c) => restoreCall(c, map)));
  setIfChanged(patch, "function_call", message.function_call, renameField(message.function_call, "name", map));
  return Object.keys(patch).length === 0 ? message : { ...message, ...patch };
}

function restoreOpenAIChoice(choice, map) {
  if (!isObject(choice)) return choice;
  const patch = {};
  setIfChanged(patch, "delta", choice.delta, restoreOpenAIMessage(choice.delta, map));
  setIfChanged(patch, "message", choice.message, restoreOpenAIMessage(choice.message, map));
  return Object.keys(patch).length === 0 ? choice : { ...choice, ...patch };
}

function restoreClaudeBlock(block, map) {
  return block?.type === CLAUDE_BLOCK.TOOL_USE ? renameField(block, "name", map) : block;
}

function restoreResponsesItem(item, map) {
  return NAMED_OUTPUT_ITEM_TYPES.has(item?.type) ? renameField(item, "name", map) : item;
}

function restoreGeminiCandidate(candidate, map) {
  const parts = candidate?.content?.parts;
  const next = mapList(parts, (part) => {
    if (!isObject(part?.functionCall)) return part;
    const call = renameField(part.functionCall, "name", map);
    return call === part.functionCall ? part : { ...part, functionCall: call };
  });
  if (next === parts) return candidate;
  return { ...candidate, content: { ...candidate.content, parts: next } };
}

/**
 * Restore original tool names in one client-shaped payload (a streamed chunk or a
 * full response body). Returns the same reference when nothing changed.
 * @param {object} payload
 * @param {Map<string,string>} restoreMap - fitted name -> original name
 */
export function restoreToolNamesInPayload(payload, restoreMap) {
  if (!isObject(payload) || !restoreMap?.size) return payload;
  const map = restoreMap;
  const patch = {};

  setIfChanged(patch, "choices", payload.choices, mapList(payload.choices, (c) => restoreOpenAIChoice(c, map)));
  setIfChanged(patch, "content", payload.content, mapList(payload.content, (b) => restoreClaudeBlock(b, map)));
  setIfChanged(patch, "content_block", payload.content_block, restoreClaudeBlock(payload.content_block, map));
  setIfChanged(patch, "message", payload.message, restoreToolNamesInPayload(payload.message, map));
  setIfChanged(patch, "output", payload.output, mapList(payload.output, (i) => restoreResponsesItem(i, map)));
  setIfChanged(patch, "item", payload.item, restoreResponsesItem(payload.item, map));
  setIfChanged(patch, "candidates", payload.candidates, mapList(payload.candidates, (c) => restoreGeminiCandidate(c, map)));
  setIfChanged(patch, "response", payload.response, restoreToolNamesInPayload(payload.response, map));

  // Responses events such as response.function_call_arguments.done carry the name at top level.
  const isResponsesEvent = typeof payload.type === "string" && payload.type.startsWith(RESPONSES_EVENT_PREFIX);
  const restoredSelf = isResponsesEvent ? renameField(payload, "name", map) : payload;
  if (restoredSelf !== payload) patch.name = restoredSelf.name;

  return Object.keys(patch).length === 0 ? payload : { ...payload, ...patch };
}

function mentionsAny(text, needles) {
  for (const needle of needles) if (text.includes(needle)) return true;
  return false;
}

function restoreSseLine(line, map, needles, onError) {
  if (!line.startsWith(SSE_DATA_PREFIX)) return line;
  const hasCarriageReturn = line.endsWith("\r");
  const raw = line.slice(SSE_DATA_PREFIX.length, hasCarriageReturn ? -1 : undefined).trim();
  if (!raw || !mentionsAny(raw, needles)) return line;
  try {
    const parsed = JSON.parse(raw);
    const restored = restoreToolNamesInPayload(parsed, map);
    if (restored === parsed) return line;
    return `${SSE_DATA_PREFIX} ${JSON.stringify(restored)}${hasCarriageReturn ? "\r" : ""}`;
  } catch (err) {
    onError?.(err);
    return line;
  }
}

/**
 * TransformStream over SSE bytes that restores original tool names in `data:`
 * lines. Lines that mention no fitted name pass through byte-identical.
 * @param {Map<string,string>} restoreMap
 * @param {{ onError?: (err: Error) => void }} [options]
 */
export function createToolNameRestoreStream(restoreMap, { onError } = {}) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const needles = [...restoreMap.keys()].map((name) => JSON.stringify(name).slice(1, -1));
  let pending = "";

  const rewrite = (text) => text.split("\n").map((line) => restoreSseLine(line, restoreMap, needles, onError)).join("\n");

  return new TransformStream({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      const cut = pending.lastIndexOf("\n");
      if (cut === -1) return;
      const complete = pending.slice(0, cut + 1);
      pending = pending.slice(cut + 1);
      controller.enqueue(encoder.encode(rewrite(complete)));
    },
    flush(controller) {
      pending += decoder.decode();
      if (pending) controller.enqueue(encoder.encode(rewrite(pending)));
    },
  });
}

function rebuildResponse(response, body) {
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function restoreJsonResponse(response, restoreMap, onError) {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text);
    const restored = restoreToolNamesInPayload(parsed, restoreMap);
    return rebuildResponse(response, restored === parsed ? text : JSON.stringify(restored));
  } catch (err) {
    onError?.(err);
    return rebuildResponse(response, text);
  }
}

/**
 * Wrap a handler result `{ success, response }` so the client only ever sees
 * original tool names (JSON bodies and SSE streams). No-op without a map.
 * @param {{success?: boolean, response?: Response}|undefined} result
 * @param {Map<string,string>|undefined} restoreMap
 * @param {{ onError?: (err: Error) => void }} [options]
 */
export async function restoreFittedToolNamesInResult(result, restoreMap, { onError } = {}) {
  if (!restoreMap?.size || !result?.success || !result.response) return result;
  const { response } = result;
  const contentType = response.headers?.get?.("content-type") || "";

  if (contentType.includes("text/event-stream") && response.body) {
    const body = response.body.pipeThrough(createToolNameRestoreStream(restoreMap, { onError }));
    return { ...result, response: rebuildResponse(response, body) };
  }
  if (contentType.includes("application/json")) {
    return { ...result, response: await restoreJsonResponse(response, restoreMap, onError) };
  }
  return result;
}
