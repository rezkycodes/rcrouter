// View helpers for the Proxy Fitness dashboard page. Pure: no fetching, no
// mutation of the API payloads they are given.

const SCOPE_SEPARATOR = "::";
const ALL_MODELS_LABEL = "all models";
const DEFAULT_REASON = "blocked";
const SHORT_ID_LENGTH = 8;

// `provider::model` (model may itself contain "::", so split on the first only).
export function parseFitnessScope(scope) {
  const text = String(scope ?? "");
  const sep = text.indexOf(SCOPE_SEPARATOR);
  if (sep < 0) return { provider: text, model: "", modelLabel: ALL_MODELS_LABEL };
  const model = text.slice(sep + SCOPE_SEPARATOR.length);
  return {
    provider: text.slice(0, sep),
    model,
    modelLabel: model === "*" || model === "" ? ALL_MODELS_LABEL : model,
  };
}

// host:port only: a pool URL can embed credentials and must never reach the page text.
function proxyHostOf(proxyUrl) {
  try {
    return new URL(proxyUrl).host;
  } catch {
    return "";
  }
}

function byDisplayOrder(a, b) {
  return a.provider.localeCompare(b.provider)
    || a.poolName.localeCompare(b.poolName)
    || a.scope.localeCompare(b.scope);
}

// Flatten `{ [poolId]: { [scope]: { until, reason } } }` into table rows,
// dropping expired and malformed entries.
export function buildFitnessRecords(fitness, pools, now = Date.now()) {
  const poolsById = new Map((pools || []).map((pool) => [pool.id, pool]));
  const records = [];
  for (const [poolId, scopes] of Object.entries(fitness || {})) {
    for (const [scope, info] of Object.entries(scopes || {})) {
      const until = Number(info?.until);
      if (!Number.isFinite(until) || until <= now) continue;
      const pool = poolsById.get(poolId);
      records.push({
        key: `${poolId}:${scope}`,
        poolId,
        scope,
        ...parseFitnessScope(scope),
        until,
        reason: info?.reason || DEFAULT_REASON,
        poolName: pool?.name || poolId.slice(0, SHORT_ID_LENGTH),
        proxyHost: pool?.proxyUrl ? proxyHostOf(pool.proxyUrl) : "",
      });
    }
  }
  return records.sort(byDisplayOrder);
}

export function fitnessProviders(records) {
  return [...new Set(records.map((record) => record.provider))].sort();
}

export function filterFitnessRecords(records, { provider = "all", search = "" } = {}) {
  const needle = search.trim().toLowerCase();
  return records.filter((record) => {
    if (provider !== "all" && record.provider !== provider) return false;
    if (!needle) return true;
    return `${record.poolName} ${record.proxyHost} ${record.modelLabel} ${record.reason}`.toLowerCase().includes(needle);
  });
}

export function formatRemaining(until, now = Date.now()) {
  const ms = until - now;
  if (ms <= 0) return "expired";
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}
