import "open-sse/index.js";

import {
  getProviderCredentials,
  markAccountUnavailable,
  clearAccountError,
  extractApiKey,
  isValidApiKey,
  isProviderAllowed,
  isComboAllowed,
  isKindAllowed,
  isTrustedInternalRequest,
} from "../services/auth.js";
import { isModelAllowed } from "../services/allowedModels.js";
import { handleAntigravityQuotaError, clearAntigravityStrikes, getAntigravityQuotaCache } from "../services/antigravityQuota.js";
import { getSettings } from "@/lib/localDb";
import { getModelInfo, getComboModels } from "../services/model.js";
import { handleChatCore } from "open-sse/handlers/chatCore.js";
import { DEFAULT_HEADROOM_URL } from "@/lib/headroom/detect";
import { getTransform as getPxpipeTransform } from "@/lib/pxpipe/loader.js";
import { appendPxpipeEvent } from "@/lib/pxpipe/events.js";
import { errorResponse, unavailableResponse } from "open-sse/utils/error.js";
import {
  handleComboChat,
  handleFusionChat,
  detectRequiredCapabilities,
  getAccountQuotaReset,
  parseResetTimestampMs,
} from "open-sse/services/combo.js";
import { isAutoCombo, resolveAutoCombo } from "open-sse/services/autoCombo.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import * as log from "../utils/logger.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";
import {
  isProviderInCooldown,
  isProviderFullyBlocked,
  getProviderShortestCooldownMs,
  recordProviderFailure,
  recordProviderSuccess,
  isAccountUnavailable,
  isModelLockActive,
} from "open-sse/services/accountFallback.js";
import { getProxyHash } from "@/lib/network/connectionProxy.js";
import {
  acquire as acquireAccountSlot,
  markBlocked as markAccountBlocked,
  isSemaphoreCapacityError,
  resolveAccountSemaphoreKey,
  resolveAccountSemaphoreMaxConcurrency,
} from "open-sse/services/accountSemaphore.js";

function checkCircuitBreaker(provider, proxyHash = null, enabled = true) {
  if (!enabled) return false;
  return proxyHash ? isProviderInCooldown(provider, proxyHash) : isProviderFullyBlocked(provider);
}

function isQuotaExhaustedForNow(quotaInfo) {
  if (!quotaInfo || typeof quotaInfo !== "object") return false;
  const exhausted = quotaInfo.limitReached === true
    || quotaInfo.exhausted === true
    || quotaInfo.remaining === 0
    || quotaInfo.remainingPercentage === 0;
  if (!exhausted) return false;
  const resetAt = parseResetTimestampMs(quotaInfo);
  return !resetAt || resetAt > Date.now();
}

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  let body;
  try {
    body = await request.json();
  } catch {
    log.warn("CHAT", "Invalid JSON body");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid JSON body");
  }

  // Build clientRawRequest for logging (if not provided)
  if (!clientRawRequest) {
    const url = new URL(request.url);
    clientRawRequest = {
      endpoint: url.pathname,
      body,
      headers: Object.fromEntries(request.headers.entries())
    };
  }
  // Claude Code marks a 1M-context request as `<model>[1m]`; the marker matches
  // no combo, alias or provider/model pair, so it must not reach resolution.
  // The capability travels in the anthropic-beta header, forwarded as-is.
  const { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  if (contextMarker) body.model = modelStr;

  // Request summary is emitted as the unified "▶" line in chatCore (has fmt/thinking/account)

  // Log API key (masked)
  const authHeader = request.headers.get("Authorization");
  const apiKey = extractApiKey(request);
  if (authHeader && apiKey) {
    const masked = log.maskKey(apiKey);
    log.debug("AUTH", `API Key: ${masked}`);
  } else {
    log.debug("AUTH", "No API key provided (local mode)");
  }

  // Enforce API key if enabled in settings
  const settings = await getSettings();
  const comboStrategies = settings.comboStrategies || {};
  let apiKeyInfo = null;
  const trustedInternal = await isTrustedInternalRequest(request);
  if (!trustedInternal && settings.requireApiKey) {
    if (!apiKey) {
      log.warn("AUTH", "Missing API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key");
    }
    apiKeyInfo = await isValidApiKey(apiKey);
    if (!apiKeyInfo) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  } else if (!trustedInternal && apiKey) {
    apiKeyInfo = await isValidApiKey(apiKey);
    if (!apiKeyInfo) {
      log.warn("AUTH", "Invalid API key");
      return errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key");
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model");
  }

  // ACL: check if LLM kind is allowed for this API key
  if (!isKindAllowed(apiKeyInfo, "llm")) {
    log.warn("AUTH", "LLM kind not allowed for API key");
    return errorResponse(HTTP_STATUS.FORBIDDEN, "Chat/LLM requests are not allowed for this API key");
  }

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return bypassResponse.response || bypassResponse;

  const requiredCapabilities = detectRequiredCapabilities(body);
  const circuitBreakerEnabled = settings.circuitBreakerEnabled !== false && settings.circuitBreakerEnabled !== 0;
  const candidateFilter = async ({ model, connection }) => {
    const info = await getModelInfo(model);
    if (!info?.provider) return false;
    if (!(await isProviderAllowed(apiKeyInfo, info.provider))) return false;

    const resolvedModel = `${info.provider}/${info.model}`;
    const allowed = model === resolvedModel
      ? await isModelAllowed(resolvedModel, apiKeyInfo)
      : (await isModelAllowed(model, apiKeyInfo) || await isModelAllowed(resolvedModel, apiKeyInfo));
    if (!allowed) return false;

    const proxyHash = getProxyHash(connection?.providerSpecificData);
    if (checkCircuitBreaker(info.provider, proxyHash, circuitBreakerEnabled)) return false;
    if (!connection) return true;
    if (!connection.id || connection.isActive === false) return false;
    if (isAccountUnavailable(connection.rateLimitedUntil) || isAccountUnavailable(connection.unavailableUntil)) return false;
    if (isModelLockActive(connection, info.model)) return false;

    if (info.provider === "antigravity") {
      const cachedQuota = getAntigravityQuotaCache().get(connection.id)?.[info.model];
      if (cachedQuota && isQuotaExhaustedForNow(cachedQuota)) return false;
    }

    const registeredQuota = getAccountQuotaReset(connection.id)
      || getAccountQuotaReset(resolvedModel)
      || getAccountQuotaReset(info.provider);
    return !isQuotaExhaustedForNow(registeredQuota);
  };

  // Check if model is an auto-combo or manual combo
  let comboModels = null;
  let autoComboResult = null;
  if (isAutoCombo(modelStr)) {
    autoComboResult = await resolveAutoCombo({
      modelStr,
      settings,
      getComboModels,
      candidateFilter,
    });
    if (autoComboResult?.noEligibleTargets) {
      log.warn("CHAT", `Auto combo "${modelStr}" has no eligible targets`);
      return errorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, "No eligible models available for auto combo");
    }
    if (autoComboResult?.models?.length > 0) {
      comboModels = autoComboResult.models;
    }
  } else {
    comboModels = await getComboModels(modelStr);
  }

  if (comboModels) {
    // ACL: check if this combo is allowed for this API key (skip auto-combo or check if restricted)
    if (!autoComboResult && !isComboAllowed(apiKeyInfo, modelStr)) {
      log.warn("AUTH", `Combo "${modelStr}" not allowed for API key`);
      return errorResponse(HTTP_STATUS.FORBIDDEN, `Combo "${modelStr}" is not allowed for this API key`);
    }
    // Check for combo-specific strategy first, fallback to global
    const comboSpecificStrategy = autoComboResult?.strategy || comboStrategies[modelStr]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
    const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings);
    const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
      return handleFusionChat({
        body,
        models: comboModels,
        handleSingleModel: (b, m, isPanel) => {
          let cleanRawReq = clientRawRequest;
          if (isPanel && clientRawRequest) {
            const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
            cleanRawReq = { ...clientRawRequest, body: cleanBody };
          }
          return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, apiKeyInfo);
        },
        log,
        comboName: modelStr,
        judgeModel: comboStrategies[modelStr]?.judgeModel,
        tuning: comboStrategies[modelStr]?.fusionTuning,
      });
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    const sessionId = request?.headers?.get?.("x-session-id") ||
                      request?.headers?.get?.("x-conversation-id") ||
                      request?.headers?.get?.("session-id") ||
                      body?.session_id ||
                      body?.conversation_id ||
                      body?.user ||
                      null;
    log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit}${sessionId ? ", session affinity enabled" : ""})`);
    return handleComboChat({
      body,
      models: augmentedModels,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m, opts) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, apiKeyInfo, opts),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy,
      comboStickyLimit,
      signal: request?.signal ?? null,
      timeoutMs: comboStrategies[modelStr]?.targetTimeoutMs ?? null,
      queueDepth: comboStrategies[modelStr]?.queueDepth ?? null,
      sessionId,
      tenantScope: apiKeyInfo?.id || apiKey,
    });
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  const soloAugmented = augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return handleComboChat({
      body,
      models: soloAugmented,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m, opts) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, apiKeyInfo, opts),
        adapterAdded
      ),
      log,
      comboName: modelStr,
      comboStrategy: getActiveAdapterStrategy(requiredCapabilities, settings),
      signal: request?.signal ?? null,
      timeoutMs: comboStrategies[modelStr]?.targetTimeoutMs ?? null,
      queueDepth: comboStrategies[modelStr]?.queueDepth ?? null,
    });
  }

  return handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, apiKeyInfo);
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, apiKeyInfo = null, options = null) {
  const externalSignal = options?.signal ?? null;
  const clientSignal = request?.signal && externalSignal
    ? AbortSignal.any([request.signal, externalSignal])
    : (request?.signal || externalSignal || null);
  const modelInfo = await getModelInfo(modelStr);
  // If provider is null, this might be a combo name - check and handle
  if (!modelInfo.provider) {
    const comboModels = await getComboModels(modelStr);
    if (comboModels) {
      if (!isComboAllowed(apiKeyInfo, modelStr)) {
        log.warn("AUTH", `Combo "${modelStr}" not allowed for API key`);
        return errorResponse(HTTP_STATUS.FORBIDDEN, `Combo "${modelStr}" is not allowed for this API key`);
      }
      const chatSettings = await getSettings();
      // Check for combo-specific strategy first, fallback to global
      const comboStrategies = chatSettings.comboStrategies || {};
      const comboSpecificStrategy = comboStrategies[modelStr]?.fallbackStrategy;
      const comboStrategy = comboSpecificStrategy || chatSettings.comboStrategy || "fallback";
      const requiredCapabilities = detectRequiredCapabilities(body);
      const augmentedModels = augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings);
      const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

      if (comboStrategy === "fusion") {
        log.info("CHAT", `Combo "${modelStr}" with ${comboModels.length} models (strategy: fusion)`);
        return handleFusionChat({
          body,
          models: comboModels,
          handleSingleModel: (b, m, isPanel) => {
            let cleanRawReq = clientRawRequest;
            if (isPanel && clientRawRequest) {
              const { tools, tool_choice, ...cleanBody } = clientRawRequest.body || {};
              cleanRawReq = { ...clientRawRequest, body: cleanBody };
            }
            return handleSingleModelChat(b, m, cleanRawReq, request, apiKey, apiKeyInfo);
          },
          log,
          comboName: modelStr,
          judgeModel: comboStrategies[modelStr]?.judgeModel,
          tuning: comboStrategies[modelStr]?.fusionTuning,
        });
      }

      const comboStickyLimit = chatSettings.comboStickyRoundRobinLimit;
      log.info("CHAT", `Combo "${modelStr}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
      return handleComboChat({
        body,
        models: augmentedModels,
        handleSingleModel: withCapacityAdapterStripping(
          (b, m, opts) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, apiKeyInfo, opts),
          adapterAdded
        ),
        log,
        comboName: modelStr,
        comboStrategy,
        comboStickyLimit,
        signal: request?.signal ?? null,
        timeoutMs: comboStrategies[modelStr]?.targetTimeoutMs ?? null,
        queueDepth: comboStrategies[modelStr]?.queueDepth ?? null,
      });
    }
    log.warn("CHAT", "Invalid model format", { model: modelStr });
    return errorResponse(HTTP_STATUS.BAD_REQUEST, "Invalid model format");
  }

  const { provider, model } = modelInfo;

  // ACL: check if provider is allowed for this API key
  if (!(await isProviderAllowed(apiKeyInfo, provider))) {
    log.warn("AUTH", `Provider "${provider}" not allowed for API key`, { provider });
    return errorResponse(HTTP_STATUS.FORBIDDEN, `Provider "${provider}" is not allowed for this API key`);
  }

  // ACL: check if model is in available models list
  const resolvedModelStr = `${provider}/${model}`;
  const isAllowed = (modelStr === resolvedModelStr)
    ? await isModelAllowed(resolvedModelStr, apiKeyInfo)
    : (await isModelAllowed(modelStr, apiKeyInfo) || await isModelAllowed(resolvedModelStr, apiKeyInfo));
  if (!isAllowed) {
    log.warn("CHAT", `Model not in available models list`, { model: resolvedModelStr });
    return errorResponse(HTTP_STATUS.NOT_FOUND, `Model "${resolvedModelStr}" is not available. Only models listed in /v1/models can be used.`);
  }

  // Routing shown in the unified "▶" line (client model → provider/model)

  // Extract userAgent from request
  const userAgent = request?.headers?.get("user-agent") || "";

  const chatSettings = await getSettings();
  const circuitBreakerEnabled = chatSettings.circuitBreakerEnabled !== false && chatSettings.circuitBreakerEnabled !== 0;

  // Pipeline gate: check circuit breaker state BEFORE credential lookup.
  // If ALL proxy buckets for this provider are OPEN, short-circuit immediately
  // — no point querying the DB when every bucket is blocked.
  if (checkCircuitBreaker(provider, null, circuitBreakerEnabled)) {
    const cooldownMs = getProviderShortestCooldownMs(provider);
    const retryAfterSec = Math.ceil(cooldownMs / 1000) || 30;
    const retryAfterTimestamp = new Date(Date.now() + cooldownMs).toISOString();
    log.warn("GATE", `${provider} circuit breaker OPEN on all proxy buckets — short-circuiting before credential lookup`);
    return unavailableResponse(
      HTTP_STATUS.SERVICE_UNAVAILABLE,
      `[${provider}/${model}] Provider temporarily unavailable (circuit breaker open)`,
      retryAfterTimestamp,
      `${retryAfterSec}s`
    );
  }

  // Try with available accounts (fallback on errors)
  const excludeConnectionIds = new Set();
  let lastError = null;
  let lastStatus = null;

  while (true) {
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, {
      preferredConnectionId: options?.preferredConnectionId,
    });

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (options?.preferredConnectionId) {
        options?._invalidateAffinity?.(options._affinityKey, options.preferredConnectionId);
      }
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    // Compute proxy bucket key for this account — groups accounts by shared proxy.
    const proxyHash = getProxyHash(credentials.providerSpecificData);

    // Proxy-aware circuit breaker: skip THIS account if its proxy bucket is OPEN.
    // Accounts on other proxies are still tried.
    if (checkCircuitBreaker(provider, proxyHash, circuitBreakerEnabled)) {
      options?._invalidateAffinity?.(options._affinityKey, credentials.connectionId);
      log.warn("AUTH", `${provider} proxy bucket ${proxyHash} circuit breaker OPEN — skipping account ${credentials.connectionName}`);
      excludeConnectionIds.add(credentials.connectionId);
      continue;
    }
    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable");
    }

    // Account selection shown in the unified "▶" line (acc:...)
    const refreshedCredentials = await checkAndRefreshToken(provider, credentials);

    // Ensure real project ID is available for providers that need it (P0 fix: cold miss)
    if ((provider === "antigravity" || provider === "gemini-cli") && !refreshedCredentials.projectId) {
      const pid = await getProjectIdForConnection(credentials.connectionId, refreshedCredentials.accessToken, provider);
      if (pid) {
        refreshedCredentials.projectId = pid;
        // Persist to DB in background so subsequent requests have it immediately
        updateProviderCredentials(credentials.connectionId, { projectId: pid }).catch(() => { });
      }
    }

    // Use shared chatCore
    const chatSettings = await getSettings();
    const providerThinking = (chatSettings.providerThinking || {})[provider] || null;
    const semaphoreKey = resolveAccountSemaphoreKey({
      provider,
      model,
      connectionId: credentials.connectionId,
      credentials,
      proxyHash,
    });
    let releaseAccountSlot = null;
    try {
      if (semaphoreKey) {
        releaseAccountSlot = await acquireAccountSlot(semaphoreKey, {
          maxConcurrency: resolveAccountSemaphoreMaxConcurrency(credentials),
          maxQueueSize: options?.maxQueueSize,
          signal: clientSignal,
        });
      }
    } catch (error) {
      if (clientSignal?.aborted) return new Response(null, { status: 499 });
      if (!isSemaphoreCapacityError(error)) throw error;
      options?._invalidateAffinity?.(options._affinityKey, credentials.connectionId);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = error.message;
      lastStatus = HTTP_STATUS.SERVICE_UNAVAILABLE;
      log.warn("AUTH", `${provider} account capacity reached — trying another account`);
      continue;
    }

    let result;
    try {
      result = await handleChatCore({
        body: { ...body, model: `${provider}/${model}` },
        modelInfo: { provider, model },
        credentials: refreshedCredentials,
        log,
        clientRawRequest,
        connectionId: credentials.connectionId,
        userAgent,
        apiKey,
        clientSignal,
        ccFilterNaming: !!chatSettings.ccFilterNaming,
        rtkEnabled: !!chatSettings.rtkEnabled,
        headroomEnabled: !!chatSettings.headroomEnabled,
        headroomUrl: chatSettings.headroomUrl || DEFAULT_HEADROOM_URL,
        headroomCompressUserMessages: !!chatSettings.headroomCompressUserMessages,
        headroomTimeoutMs: chatSettings.headroomTimeoutMs,
        cavemanEnabled: !!chatSettings.cavemanEnabled,
        cavemanLevel: chatSettings.cavemanLevel || "full",
        ponytailEnabled: !!chatSettings.ponytailEnabled,
        ponytailLevel: chatSettings.ponytailLevel || "full",
        pxpipeEnabled: !!chatSettings.pxpipeEnabled,
        pxpipeMinChars: chatSettings.pxpipeMinChars,
        pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
        // Lazily warms the in-process module on first use; null when not installed (fail-open)
        pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
        onPxpipeEvent: appendPxpipeEvent,
        providerThinking,
        // Detect source format by endpoint + body
        sourceFormatOverride: request?.url ? detectFormatByEndpoint(new URL(request.url).pathname, body) : null,
        onCredentialsRefreshed: async (newCreds) => {
          await updateProviderCredentials(credentials.connectionId, {
            ...newCreds,
            existingProviderSpecificData: credentials.providerSpecificData,
            testStatus: "active"
          });
        },
        onRequestSuccess: async () => {
          await clearAccountError(credentials.connectionId, credentials, model);
          // "Consecutive" strikes: a success clears the breaker for this pair.
          clearAntigravityStrikes(credentials.connectionId, model);
          if (circuitBreakerEnabled) {
            recordProviderSuccess(provider, proxyHash);
          }
        }
      });
    } finally {
      releaseAccountSlot?.();
    }

    if (result.success) {
      if (!clientSignal?.aborted) {
        options?._commitAffinity?.(options._affinityKey, credentials.connectionId, modelStr);
      }
      return result.response;
    }

    if (clientSignal?.aborted) {
      log.info("CHAT", `[${provider}/${model}] client disconnected — skipping account lock/fallback`);
      return new Response(null, { status: 499 });
    }

    // Antigravity 409/429: refresh live quota to get exact resetAt before locking
    let quotaResetMs = null;
    let resetsAtMs = result.resetsAtMs;
    if (provider === "antigravity" && (result.status === 409 || result.status === 429)) {
      quotaResetMs = await handleAntigravityQuotaError(
        credentials.connectionId, result.status, model,
        refreshedCredentials.accessToken, credentials.providerSpecificData
      );
      if (quotaResetMs) resetsAtMs = quotaResetMs;
    }

    // Exhausted Antigravity model is blocked only in RAM cache until upstream resetAt.
    // Do not persist a modelLock_* for this path.
    const accountAvailability = provider === "antigravity" && quotaResetMs
      ? { shouldFallback: true, cooldownMs: Math.max(0, quotaResetMs - Date.now()) }
      : await markAccountUnavailable(credentials.connectionId, result.status, result.error, provider, model, resetsAtMs);
    const shouldFallback = accountAvailability.shouldFallback;
    // Keep queued requests behind an account that just hit a known cooldown.
    // The DB model lock protects future selections; the semaphore block also
    // prevents already-queued work from immediately repeating the same 429.
    if (shouldFallback && semaphoreKey && accountAvailability.cooldownMs > 0) {
      markAccountBlocked(semaphoreKey, accountAvailability.cooldownMs);
    }
    // Record provider-level failure for circuit breaker (429 excluded automatically inside recordProviderFailure)
    if (circuitBreakerEnabled) {
      recordProviderFailure(provider, result.status, result.error, log, credentials.connectionId, proxyHash);
    }

    if (shouldFallback) {
      options?._invalidateAffinity?.(options._affinityKey, credentials.connectionId);
      excludeConnectionIds.add(credentials.connectionId);
      lastError = result.error;
      lastStatus = result.status;
      continue;
    }

    return result.response;
  }
}
