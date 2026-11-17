// Turns a dashboard/API request body into the input of createProviderConnection.
// Shared by POST /api/providers (one connection) and POST /api/providers/bulk
// (many) so both apply the same provider rules, node hydration and proxy defaults.
import { getProviderNodeById, getProxyPoolById } from "@/models";
import { APIKEY_PROVIDERS } from "@/shared/constants/config";
import {
  AI_PROVIDERS,
  FREE_TIER_PROVIDERS,
  WEB_COOKIE_PROVIDERS,
  isOpenAICompatibleProvider,
  isAnthropicCompatibleProvider,
  isCustomEmbeddingProvider,
} from "@/shared/constants/providers";
import { normalizeProviderId, normalizeProviderSpecificData } from "@/lib/providerNormalization";

export const BULK_MAX_ITEMS = 500;
const TEST_STATUSES = new Set(["active", "unknown"]);

function normalizeProxyConfig(body = {}) {
  const enabled = body?.connectionProxyEnabled === true;
  const url = typeof body?.connectionProxyUrl === "string" ? body.connectionProxyUrl.trim() : "";
  const noProxy = typeof body?.connectionNoProxy === "string" ? body.connectionNoProxy.trim() : "";

  if (enabled && !url) {
    return { error: "Connection proxy URL is required when connection proxy is enabled" };
  }

  return { connectionProxyEnabled: enabled, connectionProxyUrl: url, connectionNoProxy: noProxy };
}

async function normalizeProxyPoolId(proxyPoolId) {
  if (proxyPoolId === undefined || proxyPoolId === null || proxyPoolId === "" || proxyPoolId === "__none__") {
    return { proxyPoolId: null };
  }

  const normalizedId = String(proxyPoolId).trim();
  if (!normalizedId) return { proxyPoolId: null };

  const proxyPool = await getProxyPoolById(normalizedId);
  if (!proxyPool) return { error: "Proxy pool not found" };

  return { proxyPoolId: normalizedId };
}

function isValidApiKeyProvider(provider) {
  const isWebCookieProvider = !!WEB_COOKIE_PROVIDERS[provider];
  // Dual-auth providers (e.g. codebuddy-cn, xai) live under category "oauth" but also
  // accept an API key via authModes — they aren't in APIKEY_PROVIDERS, so allow them here.
  const supportsApiKeyMode = !!AI_PROVIDERS[provider]?.authModes?.includes("apikey");
  return !!(
    APIKEY_PROVIDERS[provider] ||
    FREE_TIER_PROVIDERS[provider] ||
    supportsApiKeyMode ||
    isWebCookieProvider ||
    isOpenAICompatibleProvider(provider) ||
    isAnthropicCompatibleProvider(provider) ||
    isCustomEmbeddingProvider(provider)
  );
}

// Compatible/embedding providers point at a user-defined node: copy its routing
// fields into the connection. Returns { providerSpecificData } or { error, status }.
async function hydrateFromNode(provider, providerSpecificData, nodeCache) {
  const kind = isOpenAICompatibleProvider(provider)
    ? { label: "OpenAI Compatible", withApiType: true }
    : isAnthropicCompatibleProvider(provider)
      ? { label: "Anthropic Compatible", withApiType: false }
      : isCustomEmbeddingProvider(provider)
        ? { label: "Custom Embedding", withApiType: false }
        : null;
  if (!kind) return { providerSpecificData };

  if (!nodeCache.has(provider)) nodeCache.set(provider, await getProviderNodeById(provider));
  const node = nodeCache.get(provider);
  if (!node) return { error: `${kind.label} node not found`, status: 404 };

  return {
    providerSpecificData: {
      ...(providerSpecificData || {}),
      prefix: node.prefix,
      ...(kind.withApiType ? { apiType: node.apiType } : {}),
      baseUrl: node.baseUrl,
      nodeName: node.name,
    },
  };
}

/**
 * Validate one request body and build the createProviderConnection input.
 *
 * @param {object} body
 * @param {{ nodeCache?: Map<string, object|null> }} [options] share one cache across a
 *   batch so each compatible node is looked up once
 * @returns {Promise<{ input: object } | { error: string, status: number }>}
 */
export async function buildApiKeyConnectionInput(body, { nodeCache = new Map() } = {}) {
  const provider = normalizeProviderId(body?.provider);
  const { apiKey, name, displayName, priority, globalPriority, defaultModel, testStatus } = body || {};

  const proxyConfig = normalizeProxyConfig(body);
  if (proxyConfig.error) return { error: proxyConfig.error, status: 400 };

  const proxyPoolResult = await normalizeProxyPoolId(body?.proxyPoolId);
  if (proxyPoolResult.error) return { error: proxyPoolResult.error, status: 400 };

  if (!provider || !isValidApiKeyProvider(provider)) return { error: "Invalid provider", status: 400 };

  const isWebCookieProvider = !!WEB_COOKIE_PROVIDERS[provider];
  // A provider may declare a providerSpecificData field that stands in for an API key — e.g.
  // Bedrock's `profile`, where the credential lives in the local AWS config and there is no
  // key to paste. Without this, following such a provider's own setup notice returns 400.
  const apiKeySubstitute = AI_PROVIDERS[provider]?.apiKeyOptionalWith;
  const hasApiKeySubstitute = !!(apiKeySubstitute && body?.providerSpecificData?.[apiKeySubstitute]);
  if (!apiKey && provider !== "ollama-local" && !hasApiKeySubstitute) {
    return { error: `${isWebCookieProvider ? "Cookie value" : "API Key"} is required`, status: 400 };
  }
  const connectionName = name || displayName || AI_PROVIDERS[provider]?.name;
  if (!connectionName) return { error: "Name is required", status: 400 };

  const hydrated = await hydrateFromNode(
    provider,
    normalizeProviderSpecificData(provider, body, body?.providerSpecificData),
    nodeCache,
  );
  if (hydrated.error) return { error: hydrated.error, status: hydrated.status };

  const providerSpecificData = {
    ...(hydrated.providerSpecificData || {}),
    connectionProxyEnabled: proxyConfig.connectionProxyEnabled,
    connectionProxyUrl: proxyConfig.connectionProxyUrl,
    connectionNoProxy: proxyConfig.connectionNoProxy,
  };
  if (proxyPoolResult.proxyPoolId !== null) providerSpecificData.proxyPoolId = proxyPoolResult.proxyPoolId;

  return {
    input: {
      provider,
      authType: isWebCookieProvider ? "cookie" : "apikey",
      name: connectionName,
      apiKey: apiKey || "",
      priority: priority || 1,
      globalPriority: globalPriority || null,
      defaultModel: defaultModel || null,
      providerSpecificData,
      isActive: true,
      testStatus: testStatus || "unknown",
    },
  };
}

/** Bulk flavour: a pasted batch only ever carries a key, and may only claim "active"/"unknown". */
export async function buildBulkConnectionInput(item, options) {
  const name = typeof item?.name === "string" ? item.name.trim() : "";
  const apiKey = typeof item?.apiKey === "string" ? item.apiKey.trim() : "";
  // A name is mandatory here: the single route falls back to the provider's display
  // name, which would collide for every item of a batch.
  if (!name || !apiKey) {
    return { error: "Every item requires a valid provider, name, and apiKey", status: 400 };
  }
  return buildApiKeyConnectionInput({
    ...item,
    name,
    apiKey,
    displayName: undefined,
    testStatus: TEST_STATUSES.has(item.testStatus) ? item.testStatus : "unknown",
  }, options);
}
