// Resilience knobs: cooldown-aware retry, stream readiness gate, SSE keep-alive
// and the account-fallback loop cap. Constants and pure resolvers only; no I/O.
//
// Settings (src/lib/db/repos/settingsRepo.js merges RESILIENCE_SETTING_DEFAULTS):
//   cooldownRetryEnabled     env COOLDOWN_RETRY_ENABLED       default true
//   cooldownRetryMaxWaitMs   env COOLDOWN_RETRY_MAX_WAIT_MS   default 30000 (0..60000)
//   streamReadinessTimeoutMs env STREAM_READINESS_TIMEOUT_MS  default 25000 (1000..120000)

export const COOLDOWN_RETRY = Object.freeze({
  DEFAULT_ENABLED: true,
  DEFAULT_MAX_WAIT_MS: 30_000,
  MIN_MAX_WAIT_MS: 0,
  CEILING_MAX_WAIT_MS: 60_000,
  // One retry per request: a second wait would multiply client-visible latency.
  MAX_RETRIES: 1,
  // Timers may fire a millisecond early; sleep a touch longer than the lock so
  // the retried selection does not still see the account as locked.
  SETTLE_MARGIN_MS: 50,
});

export const STREAM_READINESS = Object.freeze({
  DEFAULT_TIMEOUT_MS: 25_000,
  MIN_TIMEOUT_MS: 1_000,
  MAX_TIMEOUT_MS: 120_000,
});

export const SSE_KEEPALIVE = Object.freeze({
  INTERVAL_MS: 15_000,
  // Delay before re-checking when the last output stopped mid-event.
  BOUNDARY_RETRY_MS: 1_000,
  // SSE comment line: ignored by compliant parsers (OpenAI, Anthropic, Responses).
  COMMENT: ": keep-alive\n\n",
});

// Upper bound on account-fallback iterations per request (see fallbackCap.js).
export const MAX_FALLBACK_ATTEMPTS_CAP = 6;

/**
 * Coerce a numeric setting into [min, max]. Non-numeric input (undefined, null,
 * NaN, booleans, blank/garbage strings, objects) yields `fallback`.
 */
export function resolveBoundedMs(raw, { min, max, fallback }) {
  const isNumeric = typeof raw === "number" || (typeof raw === "string" && raw.trim() !== "");
  const value = isNumeric ? Number(raw) : NaN;
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

const TRUE_WORDS = new Set(["true", "1", "yes", "on"]);
const FALSE_WORDS = new Set(["false", "0", "no", "off"]);

export function resolveBoolean(raw, fallback) {
  if (typeof raw === "boolean") return raw;
  if (raw === 1) return true;
  if (raw === 0) return false;
  if (typeof raw === "string") {
    const word = raw.trim().toLowerCase();
    if (TRUE_WORDS.has(word)) return true;
    if (FALSE_WORDS.has(word)) return false;
  }
  return fallback;
}

export function resolveCooldownRetryConfig(settings) {
  return {
    enabled: resolveBoolean(settings?.cooldownRetryEnabled, COOLDOWN_RETRY.DEFAULT_ENABLED),
    maxWaitMs: resolveBoundedMs(settings?.cooldownRetryMaxWaitMs, {
      min: COOLDOWN_RETRY.MIN_MAX_WAIT_MS,
      max: COOLDOWN_RETRY.CEILING_MAX_WAIT_MS,
      fallback: COOLDOWN_RETRY.DEFAULT_MAX_WAIT_MS,
    }),
  };
}

export function resolveStreamReadinessTimeoutMs(raw) {
  return resolveBoundedMs(raw, {
    min: STREAM_READINESS.MIN_TIMEOUT_MS,
    max: STREAM_READINESS.MAX_TIMEOUT_MS,
    fallback: STREAM_READINESS.DEFAULT_TIMEOUT_MS,
  });
}

// Settings defaults (env-aware, evaluated once at load like HEADROOM_URL).
// Spread into DEFAULT_SETTINGS so the dashboard/API can override per install.
const env = typeof process !== "undefined" ? process.env : {};

export const RESILIENCE_SETTING_DEFAULTS = Object.freeze({
  cooldownRetryEnabled: resolveBoolean(env.COOLDOWN_RETRY_ENABLED, COOLDOWN_RETRY.DEFAULT_ENABLED),
  cooldownRetryMaxWaitMs: resolveCooldownRetryConfig({
    cooldownRetryMaxWaitMs: env.COOLDOWN_RETRY_MAX_WAIT_MS,
  }).maxWaitMs,
  streamReadinessTimeoutMs: resolveStreamReadinessTimeoutMs(env.STREAM_READINESS_TIMEOUT_MS),
});
