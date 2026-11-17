// Cooldown-aware retry (ported from VansRouter cooldownRetry.js, adapted).
//
// When every account of a provider is locked, getProviderCredentials reports
// { allRateLimited, retryAfter }. If the earliest lock expires within a short,
// configurable bound, waiting for it and re-running the account selection once
// beats failing the request immediately.
//
// Rules enforced here:
//   - nothing is held while sleeping (callers invoke this between account
//     attempts, after the account semaphore slot was released);
//   - the wait is cancelled at once by the client's AbortSignal and uses an
//     unref'd timer, so nothing leaks;
//   - at most COOLDOWN_RETRY.MAX_RETRIES waits per request;
//   - only rate-limit-class locks are waited on (a 5xx/timeout lock signals a
//     degraded provider; waiting would only add latency);
//   - a combo member that can fall through to another member never waits.

import { checkFallbackError } from "../services/accountFallback.js";
import { COOLDOWN_RETRY, resolveCooldownRetryConfig } from "../config/resilienceConfig.js";

export const COOLDOWN_DECISION = Object.freeze({
  RETRY: "retry",
  SKIP: "skip",
  ABORTED: "aborted",
});

/**
 * Sleep for `ms`, rejecting early (and clearing the timer) if `signal` aborts.
 * The timer is unref'd so a pending wait never keeps the process alive.
 */
export function sleepWithAbort(ms, signal = null) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    let onAbort = null;
    const timer = setTimeout(() => {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    if (!signal) return;
    onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function toEpochMs(value) {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

/**
 * True when the lock that blocks the accounts came from a rate-limit class
 * error (429 / "rate limit" / "overloaded" ...), i.e. one that backs off.
 */
export function isRateLimitCooldown(credentials) {
  const status = Number(credentials?.lastErrorCode) || 0;
  const text = typeof credentials?.lastError === "string" ? credentials.lastError : "";
  if (!status && !text) return false;
  return checkFallbackError(status, text).newBackoffLevel !== undefined;
}

function evaluateWait({ config, credentials, retriesUsed, hasFallbackTarget, now }) {
  if (!config.enabled) return { reason: "disabled" };
  if (hasFallbackTarget) return { reason: "combo_has_fallback_target" };
  if (retriesUsed >= COOLDOWN_RETRY.MAX_RETRIES) return { reason: "retry_budget_used" };
  if (!isRateLimitCooldown(credentials)) return { reason: "not_rate_limit_cooldown" };
  const target = toEpochMs(credentials?.retryAfter);
  if (target === null) return { reason: "invalid_retry_after" };
  const waitMs = Math.max(0, target - now());
  if (waitMs > config.maxWaitMs) return { reason: "wait_exceeds_bound" };
  return { waitMs };
}

/**
 * Per-request gate. Create one before the account-selection loop and call
 * `waitIfEligible(credentials)` whenever selection reports allRateLimited.
 *
 * @returns {{ waitIfEligible: (credentials: object) => Promise<string> }}
 *   resolves to a COOLDOWN_DECISION: RETRY (re-run selection), SKIP (fail as
 *   before) or ABORTED (client disconnected; stop).
 */
export function createCooldownGate({
  settings,
  signal = null,
  hasFallbackTarget = false,
  log = null,
  label = "",
  now = Date.now,
  sleep = sleepWithAbort,
} = {}) {
  const config = resolveCooldownRetryConfig(settings);
  let retriesUsed = 0;

  async function waitIfEligible(credentials) {
    const verdict = evaluateWait({ config, credentials, retriesUsed, hasFallbackTarget, now });
    if (verdict.reason) {
      log?.debug?.("CHAT", `[${label}] cooldown retry skipped: ${verdict.reason}`);
      return COOLDOWN_DECISION.SKIP;
    }
    if (signal?.aborted) return COOLDOWN_DECISION.ABORTED;

    retriesUsed += 1;
    if (verdict.waitMs > 0) {
      log?.info?.("CHAT", `[${label}] all accounts rate-limited — waiting ${verdict.waitMs}ms for the earliest cooldown, then retrying once`);
      try {
        await sleep(verdict.waitMs + COOLDOWN_RETRY.SETTLE_MARGIN_MS, signal);
      } catch (error) {
        if (signal?.aborted) {
          log?.info?.("CHAT", `[${label}] client disconnected during cooldown wait`);
          return COOLDOWN_DECISION.ABORTED;
        }
        log?.warn?.("CHAT", `[${label}] cooldown wait failed: ${error?.message || error}`);
        return COOLDOWN_DECISION.SKIP;
      }
    }
    return COOLDOWN_DECISION.RETRY;
  }

  return { waitIfEligible };
}
