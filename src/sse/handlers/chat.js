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
import { upstreamResponseHeaders } from "open-sse/utils/upstreamHeaders.js";
import {
  handleComboChat,
  handleFusionChat,
  detectRequiredCapabilities,
  getAccountQuotaReset,
  parseResetTimestampMs,
} from "open-sse/services/combo.js";
import { isAutoCombo, resolveAutoCombo } from "open-sse/services/autoCombo.js";
import { stripComboPrefix } from "open-sse/services/comboPrefix.js";
import { augmentModelsWithCapacityAdapter, withCapacityAdapterStripping, getActiveAdapterStrategy } from "open-sse/services/capacityAdapter.js";
import { handleBypassRequest } from "open-sse/utils/bypassHandler.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import { detectFormatByEndpoint } from "open-sse/translator/formats.js";
import { extractClientSessionId } from "open-sse/utils/sessionManager.js";
import * as log from "../utils/logger.js";
import { readBoundedJson } from "../utils/boundedBody.js";
import { updateProviderCredentials, checkAndRefreshToken } from "../services/tokenRefresh.js";
import { getProjectIdForConnection } from "open-sse/services/projectId.js";
import { stripModelContextMarker } from "open-sse/utils/modelMarkers.js";
import { getKeyAccessContext, enforceKeyAccess, filterAdapterModels } from "../services/keyAccess.js";
import { resolveSmartChoice } from "../services/systemoneRouter.js";
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
import { createCooldownGate, COOLDOWN_DECISION } from "open-sse/utils/cooldownRetry.js";
import { createFallbackBudget } from "open-sse/utils/fallbackCap.js";
import {
  acquire as acquireAccountSlot,
  markBlocked as markAccountBlocked,
  isAccountSemaphoreEnabled,
  isSemaphoreCapacityError,
  resolveAccountSemaphoreKey,
  resolveAccountSemaphoreMaxConcurrency,
} from "open-sse/services/accountSemaphore.js";
import {
  addCorrelationHeader,
  createCorrelationId,
  incrementMetric,
  observeMetric,
} from "@/lib/observability/metrics.js";

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

// Session id for combo stickiness / Context-Relay affinity. Upstream's resolver
// covers the explicit client ids (x-session-id, session_id, Claude Code, ...);
// RcRouter also honours the x-conversation-id header and the OpenAI `user`
// field, ranked below those. Only explicit client ids count: a request without one
// gets null (no stickiness) instead of a random id that would add a Context-Relay
// affinity entry per sessionless request.
function resolveComboSessionId(headers, body) {
  const hint = headers?.["x-conversation-id"] || body?.user;
  const source = typeof hint === "string" && hint && !body?.session_id
    ? { ...body, session_id: hint }
    : body;
  return extractClientSessionId(headers, source) || null;
}

/**
 * Handle chat completion request
 * Supports: OpenAI, Claude, Gemini, OpenAI Responses API formats
 * Format detection and translation handled by translator
 */
export async function handleChat(request, clientRawRequest = null) {
  const requestStartTime = Date.now();
  const correlationId = createCorrelationId();
  const respond = (value) => {
    const response = value?.response || value;
    incrementMetric("router_chat_requests_total", {
      status: String(response?.status || 500),
    });
    observeMetric("router_chat_latency_ms", Date.now() - requestStartTime, { route: "chat" });
    return addCorrelationHeader(response, correlationId);
  };
  // Bounded read: 413 before JSON.parse (see utils/boundedBody.js)
  const { body, error: bodyError } = await readBoundedJson(request);
  if (bodyError) {
    log.warn("CHAT", bodyError.status === HTTP_STATUS.PAYLOAD_TOO_LARGE ? "Request body too large" : "Invalid JSON body");
    return respond(bodyError);
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
  clientRawRequest = { ...clientRawRequest, correlationId };
  Object.defineProperty(body, "__rcCorrelationId", { value: correlationId, enumerable: false });
  // Claude Code marks a 1M-context request as `<model>[1m]`; the marker matches
  // no combo, alias or provider/model pair, so it must not reach resolution.
  // The capability travels in the anthropic-beta header, forwarded as-is.
  const { model: modelStr, contextMarker } = stripModelContextMarker(body.model);
  if (contextMarker) body.model = modelStr;

  const sessionId = resolveComboSessionId(clientRawRequest?.headers, body);

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
      return respond(errorResponse(HTTP_STATUS.UNAUTHORIZED, "Missing API key"));
    }
    apiKeyInfo = await isValidApiKey(apiKey);
    if (!apiKeyInfo) {
      log.warn("AUTH", "Invalid API key (requireApiKey=true)");
      return respond(errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key"));
    }
  } else if (!trustedInternal && apiKey) {
    apiKeyInfo = await isValidApiKey(apiKey);
    if (!apiKeyInfo) {
      log.warn("AUTH", "Invalid API key");
      return respond(errorResponse(HTTP_STATUS.UNAUTHORIZED, "Invalid API key"));
    }
  }

  if (!modelStr) {
    log.warn("CHAT", "Missing model");
    return respond(errorResponse(HTTP_STATUS.BAD_REQUEST, "Missing model"));
  }

  // ACL: check if LLM kind is allowed for this API key
  if (!isKindAllowed(apiKeyInfo, "llm")) {
    log.warn("AUTH", "LLM kind not allowed for API key");
    return respond(errorResponse(HTTP_STATUS.FORBIDDEN, "Chat/LLM requests are not allowed for this API key"));
  }

  // Per-key access control: a restricted key may call only its listed combos and
  // models. Checked once on the requested target, before bypass, combo expansion
  // and any credential lookup; an allowed combo grants the members it routes to.
  const keyAccess = await getKeyAccessContext(request);
  const keyAccessDenied = await enforceKeyAccess(keyAccess, modelStr);
  if (keyAccessDenied) return respond(keyAccessDenied);

  // Bypass naming/warmup requests before combo rotation to avoid wasting rotation slots
  const userAgent = request?.headers?.get("user-agent") || "";
  const bypassResponse = handleBypassRequest(body, modelStr, userAgent, !!settings.ccFilterNaming);
  if (bypassResponse) return respond(bypassResponse.response || bypassResponse);

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
      return respond(errorResponse(HTTP_STATUS.SERVICE_UNAVAILABLE, "No eligible models available for auto combo"));
    }
    if (autoComboResult?.models?.length > 0) {
      comboModels = autoComboResult.models;
    }
  } else {
    comboModels = await getComboModels(modelStr);
  }

  if (comboModels) {
    // /v1/models publishes combos as "combo/<name>"; per-combo settings, rotation
    // state, logs and the access check all key on the bare name.
    const comboName = stripComboPrefix(modelStr);
    // ACL: check if this combo is allowed for this API key (skip auto-combo or check if restricted)
    if (!autoComboResult && !isComboAllowed(apiKeyInfo, comboName)) {
      log.warn("AUTH", `Combo "${comboName}" not allowed for API key`);
      return respond(errorResponse(HTTP_STATUS.FORBIDDEN, `Combo "${comboName}" is not allowed for this API key`));
    }
    // Check for combo-specific strategy first, fallback to global
    const comboSpecificStrategy = autoComboResult?.strategy || comboStrategies[comboName]?.fallbackStrategy;
    const comboStrategy = comboSpecificStrategy || settings.comboStrategy || "fallback";
    const augmentedModels = await filterAdapterModels(keyAccess, augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, settings), comboModels);
    const adapterAdded = augmentedModels.filter((m) => !comboModels.includes(m));

    if (comboStrategy === "fusion") {
      log.info("CHAT", `Combo "${comboName}" with ${comboModels.length} models (strategy: fusion)`);
      return respond(await handleFusionChat({
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
        comboName,
        judgeModel: comboStrategies[comboName]?.judgeModel,
        tuning: comboStrategies[comboName]?.fusionTuning,
      }));
    }

    const comboStickyLimit = settings.comboStickyRoundRobinLimit;
    const comboCfg = comboStrategies[comboName] || {};
    log.info("CHAT", `Combo "${comboName}" with ${augmentedModels.length} models (strategy: ${comboStrategy}, sticky: ${comboStickyLimit})`);
    return respond(await handleComboChat({
      body,
      models: augmentedModels,
      handleSingleModel: withCapacityAdapterStripping(
        (b, m, opts) => handleSingleModelChat(b, m, clientRawRequest, request, apiKey, apiKeyInfo, opts),
        adapterAdded
      ),
      log,
      comboName,
      comboStrategy,
      comboStickyLimit,
      signal: request?.signal ?? null,
      timeoutMs: comboStrategies[comboName]?.targetTimeoutMs ?? null,
      queueDepth: comboStrategies[comboName]?.queueDepth ?? null,
      sessionId,
      tenantScope: apiKeyInfo?.id || apiKey,
      smartPolicy: comboCfg.smartPolicy || "smart",
      sessionSticky: comboCfg.sessionSticky !== false,
      confidenceThreshold: typeof comboCfg.confidenceThreshold === "number" ? comboCfg.confidenceThreshold : 0.8,
      resolveSmartChoice: comboStrategy === "smart"
        ? (b, m) => resolveSmartChoice({
            body: b,
            models: m,
            routerModel: comboCfg.routerModel,
            log,
          })
        : null,
    }));
  }

  // Single model request — may still switch to a capacity-adapter model if the
  // target lacks a capability the request needs (e.g. no vision, request has an image).
  const soloAugmented = await filterAdapterModels(keyAccess, augmentModelsWithCapacityAdapter([modelStr], requiredCapabilities, settings), [modelStr]);
  if (soloAugmented.length > 1) {
    const adapterAdded = soloAugmented.filter((m) => m !== modelStr);
    log.info("CHAT", `Capacity adapter for [${[...requiredCapabilities].join(",")}] on "${modelStr}" → trying ${soloAugmented.join(", ")}`);
    return respond(await handleComboChat({
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
    }));
  }

  return respond(await handleSingleModelChat(body, modelStr, clientRawRequest, request, apiKey, apiKeyInfo, null, contextMarker ? `${modelStr.slice(modelStr.indexOf("/") + 1)}[${contextMarker}]` : null));
}

/**
 * Handle single model chat request
 */
async function handleSingleModelChat(body, modelStr, clientRawRequest = null, request = null, apiKey = null, apiKeyInfo = null, options = null, requestedModel = null) {
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
      // Nested combo (a combo member that is itself a combo): the access decision
      // was made on the outer target; only drop adapter models the key may not call.
      const keyAccess = await getKeyAccessContext(request);
      const augmentedModels = await filterAdapterModels(keyAccess, augmentModelsWithCapacityAdapter(comboModels, requiredCapabilities, chatSettings), comboModels);
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
      const comboCfg = comboStrategies[modelStr] || {};
      const nestedSessionId = resolveComboSessionId(clientRawRequest?.headers, body);
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
        sessionId: nestedSessionId,
        tenantScope: apiKeyInfo?.id || apiKey,
        smartPolicy: comboCfg.smartPolicy || "smart",
        sessionSticky: comboCfg.sessionSticky !== false,
        confidenceThreshold: typeof comboCfg.confidenceThreshold === "number" ? comboCfg.confidenceThreshold : 0.8,
        resolveSmartChoice: comboStrategy === "smart"
          ? (b, m) => resolveSmartChoice({
              body: b,
              models: m,
              routerModel: comboCfg.routerModel,
              log,
            })
          : null,
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
  let lastHeaders = null;
  // One bounded wait per request when every account is rate-limited; a combo
  // member that can fall through to another member never waits.
  const cooldownGate = createCooldownGate({
    settings: chatSettings,
    signal: clientSignal,
    hasFallbackTarget: options?.hasFallbackTarget === true,
    log,
    label: `${provider}/${model}`,
  });
  // At most min(accountCount, 6) account attempts per pass, so a degraded
  // provider cannot spin through dozens of accounts (each costing a timeout).
  const fallbackBudget = createFallbackBudget();

  // Lock order is deliberate: breaker gate -> provider mutex (inside
  // getProviderCredentials) -> account semaphore -> upstream request. The
  // semaphore is released before account/breaker state is updated, so no
  // fallback path ever waits while holding a lower-level lock.
  while (true) {
    if (fallbackBudget.isExhausted()) {
      log.warn("CHAT", `[${provider}/${model}] account fallback limit reached (${fallbackBudget.limit}) — returning last upstream error`);
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable", lastHeaders);
    }
    const credentials = await getProviderCredentials(provider, excludeConnectionIds, model, {
      preferredConnectionId: options?.preferredConnectionId,
      requestedModel: requestedModel || model,
    });

    // Every account cooling down: wait (holding no slot) for the earliest one, then re-select once.
    if (credentials?.allRateLimited) {
      const cooldownDecision = await cooldownGate.waitIfEligible(credentials);
      if (cooldownDecision === COOLDOWN_DECISION.ABORTED) return new Response(null, { status: 499 });
      if (cooldownDecision === COOLDOWN_DECISION.RETRY) {
        excludeConnectionIds.clear();
        fallbackBudget.reset();
        continue;
      }
    }

    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (options?.preferredConnectionId) {
        options?._invalidateAffinity?.(options._affinityKey, options.preferredConnectionId);
      }
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman, lastHeaders);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable", lastHeaders);
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
    fallbackBudget.consume(credentials.accountCount);
    // All accounts unavailable
    if (!credentials || credentials.allRateLimited) {
      if (credentials?.allRateLimited) {
        const errorMsg = lastError || credentials.lastError || "Unavailable";
        const status = HTTP_STATUS.SERVICE_UNAVAILABLE;
        log.warn("CHAT", `[${provider}/${model}] ${errorMsg} (${credentials.retryAfterHuman})`);
        return unavailableResponse(status, `[${provider}/${model}] ${errorMsg}`, credentials.retryAfter, credentials.retryAfterHuman, lastHeaders);
      }
      if (excludeConnectionIds.size === 0) {
        log.warn("AUTH", `No active credentials for provider: ${provider}`);
        return errorResponse(HTTP_STATUS.NOT_FOUND, `No active credentials for provider: ${provider}`);
      }
      log.warn("CHAT", "No more accounts available", { provider });
      return errorResponse(lastStatus || HTTP_STATUS.SERVICE_UNAVAILABLE, lastError || "All accounts unavailable", lastHeaders);
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
    // A null key switches the whole semaphore path off: no slot acquire, no block marking.
    const semaphoreKey = isAccountSemaphoreEnabled(chatSettings)
      ? resolveAccountSemaphoreKey({
        provider,
        model,
        connectionId: credentials.connectionId,
        credentials,
        proxyHash,
      })
      : null;
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

    const upstreamAttemptStart = Date.now();
    let result;
    try {
      result = await handleChatCore({
        body: { ...body, model: `${provider}/${model}` },
        modelInfo: { provider, model },
        credentials: refreshedCredentials,
        log,
        clientRawRequest,
        correlationId: clientRawRequest?.correlationId,
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
        customPromptEnabled: !!chatSettings.customPromptEnabled,
        customPrompt: chatSettings.customPrompt || "",
        pxpipeEnabled: !!chatSettings.pxpipeEnabled,
        pxpipeMinChars: chatSettings.pxpipeMinChars,
        pxpipeTimeoutMs: chatSettings.pxpipeTimeoutMs,
        // Lazily warms the in-process module on first use; null when not installed (fail-open)
        pxpipeTransform: chatSettings.pxpipeEnabled ? await getPxpipeTransform() : null,
        loopGuardEnabled: chatSettings.loopGuardEnabled !== false && chatSettings.loopGuardEnabled !== 0,
        streamReadinessTimeoutMs: chatSettings.streamReadinessTimeoutMs,
        onPxpipeEvent: appendPxpipeEvent,
        providerThinking,
        // Per-provider user overrides (custom headers / connect timeout) from settings
        providerOverrides: (chatSettings.providerOverrides || {})[provider] || null,
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
      // finally: release capacity before any fallback/account state update below.
      releaseAccountSlot?.();
      const attemptStatus = result?.success
        ? "success"
        : (result?.status ? String(result.status) : "exception");
      incrementMetric("router_upstream_attempts_total", { provider, status: attemptStatus });
      observeMetric("router_upstream_latency_ms", Date.now() - upstreamAttemptStart, { provider });
    }

    if (result.success) {
      if (!clientSignal?.aborted) {
        options?._commitAffinity?.(options._affinityKey, credentials.connectionId, modelStr);
      }
      return result.response;
    }

    // Client capability errors must not poison account health or trigger
    // fallback: another credential cannot make an unsupported wire shape valid.
    if (result.status === HTTP_STATUS.UNPROCESSABLE_ENTITY) return result.response;

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
      lastHeaders = upstreamResponseHeaders(result.response?.headers);
      continue;
    }

    return result.response;
  }
}
