import { describe, expect, it } from "vitest";

import { createFallbackBudget, resolveMaxFallbackAttempts } from "../../open-sse/utils/fallbackCap.js";
import { MAX_FALLBACK_ATTEMPTS_CAP } from "../../open-sse/config/resilienceConfig.js";

describe("resolveMaxFallbackAttempts", () => {
  it("is min(accountCount, 6)", () => {
    expect(resolveMaxFallbackAttempts(1)).toBe(1);
    expect(resolveMaxFallbackAttempts(3)).toBe(3);
    expect(resolveMaxFallbackAttempts(6)).toBe(6);
    expect(resolveMaxFallbackAttempts(7)).toBe(6);
    expect(resolveMaxFallbackAttempts(100)).toBe(MAX_FALLBACK_ATTEMPTS_CAP);
  });

  it("uses the cap when the account count is unknown or invalid", () => {
    for (const unknown of [undefined, null, 0, -4, NaN, Infinity, "many"]) {
      expect(resolveMaxFallbackAttempts(unknown)).toBe(6);
    }
  });

  it("honours a custom cap and never goes below one attempt", () => {
    expect(resolveMaxFallbackAttempts(10, 2)).toBe(2);
    expect(resolveMaxFallbackAttempts(10, 0)).toBe(1);
    expect(resolveMaxFallbackAttempts(2.9)).toBe(2);
  });
});

describe("createFallbackBudget", () => {
  it("is not exhausted before the first attempt", () => {
    const budget = createFallbackBudget();
    expect(budget.isExhausted()).toBe(false);
    expect(budget.used).toBe(0);
  });

  it("allows min(accountCount, 6) attempts, then reports exhaustion", () => {
    const budget = createFallbackBudget();
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      expect(budget.isExhausted()).toBe(false);
      budget.consume(50);
    }
    expect(budget.used).toBe(6);
    expect(budget.limit).toBe(6);
    expect(budget.isExhausted()).toBe(true);
  });

  it("never preempts natural exhaustion once every account was tried", () => {
    const budget = createFallbackBudget();
    budget.consume(2);
    budget.consume(2);
    expect(budget.limit).toBe(2);
    // All accounts tried: the loop's own exhaustion path (and cooldown retry) decides.
    expect(budget.isExhausted()).toBe(false);
  });

  it("bites for a mid-size provider with untried accounts left", () => {
    const budget = createFallbackBudget({ cap: 2 });
    budget.consume(5);
    budget.consume(5);
    expect(budget.isExhausted()).toBe(true);
  });

  it("falls back to the cap when the account count is unknown", () => {
    const budget = createFallbackBudget();
    for (let attempt = 0; attempt < 6; attempt += 1) budget.consume(undefined);
    expect(budget.isExhausted()).toBe(true);
  });

  it("reset() starts a fresh pass (used after a cooldown retry)", () => {
    const budget = createFallbackBudget();
    for (let attempt = 0; attempt < 6; attempt += 1) budget.consume(50);
    expect(budget.isExhausted()).toBe(true);
    budget.reset();
    expect(budget.isExhausted()).toBe(false);
    expect(budget.used).toBe(0);
  });

  it("accepts a custom cap", () => {
    const budget = createFallbackBudget({ cap: 2 });
    budget.consume(40);
    budget.consume(40);
    expect(budget.isExhausted()).toBe(true);
  });
});
