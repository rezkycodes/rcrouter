// Bounded account-fallback loop: a degraded provider with dozens of accounts
// must not make one request cycle through every account (each failed attempt
// can cost a full timeout, which pushes the client past an edge proxy's limit).
//
// Budget per request = min(accountCount, MAX_FALLBACK_ATTEMPTS_CAP). It only
// governs the per-provider account loop; combo members are separate calls to
// that loop, each with its own budget.

import { MAX_FALLBACK_ATTEMPTS_CAP } from "../config/resilienceConfig.js";

export function resolveMaxFallbackAttempts(accountCount, cap = MAX_FALLBACK_ATTEMPTS_CAP) {
  const boundedCap = Math.max(1, Math.floor(Number.isFinite(cap) ? cap : MAX_FALLBACK_ATTEMPTS_CAP));
  const count = Number.isFinite(accountCount) ? Math.floor(accountCount) : 0;
  return count > 0 ? Math.min(count, boundedCap) : boundedCap;
}

/**
 * Per-request attempt counter. `consume(accountCount)` records one upstream
 * attempt (the limit is fixed by the first call); `isExhausted()` tells the
 * loop to stop and surface the last real upstream error.
 *
 * The budget only bites while untried accounts remain. Once every account has
 * been tried (limit == accountCount), the loop's natural exhaustion path
 * applies instead, which is also where the cooldown-aware retry hooks in.
 */
export function createFallbackBudget({ cap = MAX_FALLBACK_ATTEMPTS_CAP } = {}) {
  let used = 0;
  let limit = null;
  let accounts = null;

  return {
    consume(accountCount) {
      if (limit === null) limit = resolveMaxFallbackAttempts(accountCount, cap);
      if (Number.isFinite(accountCount) && accountCount > 0) accounts = Math.floor(accountCount);
      used += 1;
    },
    isExhausted() {
      if (limit === null || used < limit) return false;
      return accounts === null || accounts > used;
    },
    reset() {
      used = 0;
    },
    get used() {
      return used;
    },
    get limit() {
      return limit;
    },
  };
}
