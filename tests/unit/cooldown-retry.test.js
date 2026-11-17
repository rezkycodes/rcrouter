import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  COOLDOWN_DECISION,
  createCooldownGate,
  isRateLimitCooldown,
  sleepWithAbort,
} from "../../open-sse/utils/cooldownRetry.js";
import { COOLDOWN_RETRY } from "../../open-sse/config/resilienceConfig.js";

const MARGIN = COOLDOWN_RETRY.SETTLE_MARGIN_MS;

function rateLimited(msFromNow, extra = {}) {
  return {
    allRateLimited: true,
    retryAfter: new Date(Date.now() + msFromNow).toISOString(),
    lastErrorCode: 429,
    lastError: "Rate limit exceeded",
    ...extra,
  };
}

describe("sleepWithAbort", () => {
  afterEach(() => vi.useRealTimers());

  it("resolves after the delay and leaves no timer behind", async () => {
    vi.useFakeTimers();
    const sleeping = sleepWithAbort(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(sleeping).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    controller.abort();
    await expect(sleepWithAbort(1_000, controller.signal)).rejects.toBeDefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects on abort mid-sleep and clears its timer", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const sleeping = sleepWithAbort(10_000, controller.signal);
    const assertion = expect(sleeping).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(2_000);
    controller.abort();
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses an unref'd timer so a pending wait never keeps the process alive", async () => {
    const spy = vi.spyOn(globalThis, "setTimeout");
    try {
      await sleepWithAbort(5);
      const timer = spy.mock.results[0].value;
      expect(typeof timer.hasRef === "function" ? timer.hasRef() : false).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("isRateLimitCooldown", () => {
  it("is true for a 429 lock", () => {
    expect(isRateLimitCooldown({ lastErrorCode: 429 })).toBe(true);
    expect(isRateLimitCooldown({ lastErrorCode: "429" })).toBe(true);
  });

  it("is true when only the error text says rate limit", () => {
    expect(isRateLimitCooldown({ lastError: "You hit a rate limit" })).toBe(true);
  });

  it("is false for transient/auth locks and unknown causes", () => {
    expect(isRateLimitCooldown({ lastErrorCode: 503, lastError: "upstream down" })).toBe(false);
    expect(isRateLimitCooldown({ lastErrorCode: 504, lastError: "timed out" })).toBe(false);
    expect(isRateLimitCooldown({ lastErrorCode: 401 })).toBe(false);
    expect(isRateLimitCooldown({})).toBe(false);
    expect(isRateLimitCooldown(null)).toBe(false);
  });
});

describe("createCooldownGate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits for the earliest account to come off cooldown and asks for a retry", async () => {
    const gate = createCooldownGate({ settings: {} });
    let decision = null;
    const pending = gate.waitIfEligible(rateLimited(5_000)).then((d) => { decision = d; });

    await vi.advanceTimersByTimeAsync(4_000);
    expect(decision).toBeNull();
    await vi.advanceTimersByTimeAsync(1_000 + MARGIN);
    await pending;
    expect(decision).toBe(COOLDOWN_DECISION.RETRY);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("skips when the cooldown exceeds the bound (default 30s) without sleeping", async () => {
    const gate = createCooldownGate({ settings: {} });
    const decision = await gate.waitIfEligible(rateLimited(30_000 + 5_000));
    expect(decision).toBe(COOLDOWN_DECISION.SKIP);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honours a configured bound", async () => {
    const gate = createCooldownGate({ settings: { cooldownRetryMaxWaitMs: 2_000 } });
    expect(await gate.waitIfEligible(rateLimited(4_000))).toBe(COOLDOWN_DECISION.SKIP);
  });

  it("clamps an oversized bound to 60s", async () => {
    const gate = createCooldownGate({ settings: { cooldownRetryMaxWaitMs: 10_000_000 } });
    expect(await gate.waitIfEligible(rateLimited(61_000))).toBe(COOLDOWN_DECISION.SKIP);
  });

  it("skips entirely when disabled", async () => {
    const gate = createCooldownGate({ settings: { cooldownRetryEnabled: false } });
    expect(await gate.waitIfEligible(rateLimited(1_000))).toBe(COOLDOWN_DECISION.SKIP);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries immediately when the lock already expired", async () => {
    const gate = createCooldownGate({ settings: {} });
    const decision = await gate.waitIfEligible(rateLimited(-1_000));
    expect(decision).toBe(COOLDOWN_DECISION.RETRY);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("skips on a missing or unparseable retryAfter", async () => {
    const gate = createCooldownGate({ settings: {} });
    expect(await gate.waitIfEligible({ ...rateLimited(1_000), retryAfter: null })).toBe(COOLDOWN_DECISION.SKIP);
    expect(await gate.waitIfEligible({ ...rateLimited(1_000), retryAfter: "soon" })).toBe(COOLDOWN_DECISION.SKIP);
  });

  it("does not wait for non-rate-limit locks (transient 5xx / timeouts)", async () => {
    const gate = createCooldownGate({ settings: {} });
    const decision = await gate.waitIfEligible(rateLimited(5_000, { lastErrorCode: 504, lastError: "stream readiness timeout" }));
    expect(decision).toBe(COOLDOWN_DECISION.SKIP);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("prefers falling through to another combo target over waiting", async () => {
    const gate = createCooldownGate({ settings: {}, hasFallbackTarget: true });
    expect(await gate.waitIfEligible(rateLimited(1_000))).toBe(COOLDOWN_DECISION.SKIP);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("allows only one wait per request", async () => {
    const gate = createCooldownGate({ settings: {} });
    const first = gate.waitIfEligible(rateLimited(1_000));
    await vi.advanceTimersByTimeAsync(1_000 + MARGIN);
    expect(await first).toBe(COOLDOWN_DECISION.RETRY);

    expect(await gate.waitIfEligible(rateLimited(1_000))).toBe(COOLDOWN_DECISION.SKIP);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is aborted by a client disconnect during the wait and leaks no timer", async () => {
    const controller = new AbortController();
    const gate = createCooldownGate({ settings: {}, signal: controller.signal });
    const pending = gate.waitIfEligible(rateLimited(20_000));

    await vi.advanceTimersByTimeAsync(3_000);
    controller.abort();
    expect(await pending).toBe(COOLDOWN_DECISION.ABORTED);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports ABORTED without sleeping when the client is already gone", async () => {
    const controller = new AbortController();
    controller.abort();
    const gate = createCooldownGate({ settings: {}, signal: controller.signal });
    expect(await gate.waitIfEligible(rateLimited(1_000))).toBe(COOLDOWN_DECISION.ABORTED);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("logs the decision without leaking credentials", async () => {
    const info = vi.fn();
    const gate = createCooldownGate({ settings: {}, log: { info, warn: vi.fn() }, label: "p/m" });
    const pending = gate.waitIfEligible(rateLimited(1_000, { accessToken: "sk-secret", apiKey: "sk-secret" }));
    await vi.advanceTimersByTimeAsync(1_000 + MARGIN);
    await pending;
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).toContain("p/m");
    expect(logged).not.toContain("sk-secret");
  });
});
