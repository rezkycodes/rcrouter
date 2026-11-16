import { PROVIDERS } from "../config/providers.js";

// Public catalog: no API key required, but upstream expects the CLI transport headers.
const COMMANDCODE_MODELS_ENDPOINT = "https://api.commandcode.ai/provider/v1/models?view=client";
const FETCH_TIMEOUT_MS = 5000;

function toModel(raw) {
  const inputModalities = Array.isArray(raw.inputModalities) ? raw.inputModalities : [];
  const reasoningEfforts = Array.isArray(raw.reasoningEfforts) ? raw.reasoningEfforts : [];
  return {
    id: raw.id,
    name: raw.display?.label || raw.name || raw.id,
    description: raw.display?.description || null,
    contextLength: raw.context_length,
    maxOutputTokens: raw.maxOutputTokens ?? undefined,
    isVL: inputModalities.includes("image"),
    isReasoning: reasoningEfforts.length > 0,
  };
}

/**
 * Fetch Command Code's live model catalog (the static registry list lags upstream).
 * ponytail: no TTL cache or in-flight dedupe, same as the cline/cursor resolvers. allowedModels only
 * caches the built lists (15-30s), so concurrent cache misses each hit upstream; add a shared cache
 * here if that latency ever shows up on the request path.
 *
 * @param {typeof fetch} [fetchImpl] - injectable for tests
 * @returns {Promise<{ models: object[] } | null>} null on any failure or when nothing usable returns
 */
export async function resolveCommandcodeModels(fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetchImpl(COMMANDCODE_MODELS_ENDPOINT, {
      method: "GET",
      headers: { ...PROVIDERS.commandcode.headers },
      signal: controller.signal,
    });
    if (!response?.ok) return null;

    const json = await response.json();
    const rawList = Array.isArray(json?.data) ? json.data : [];
    const models = rawList.filter((m) => m?.id && !m.hidden).map(toModel);
    return models.length ? { models } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
