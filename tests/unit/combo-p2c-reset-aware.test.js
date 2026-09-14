import { describe, it, expect, beforeEach, vi } from "vitest";

import {
  handleComboChat,
  orderTargetsByPowerOfTwoChoices,
  orderTargetsByResetAware,
  getActiveRequests,
  trackActiveRequestStart,
  trackActiveRequestEnd,
  resetActiveRequests,
  registerAccountQuotaReset,
  clearAccountQuotaResets,
  getTargetLoad,
  DEFAULT_COMBO_TARGET_TIMEOUT_MS,
} from "../../open-sse/services/combo.js";
import { getCircuitBreaker, STATE } from "../../open-sse/utils/circuitBreaker.js";

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

describe("Combo P2C (Power of Two Choices) Strategy", () => {
  beforeEach(() => {
    resetActiveRequests();
    clearAccountQuotaResets();
  });

  it("tracks in-flight active requests accurately", () => {
    expect(getActiveRequests("provider/model-a")).toBe(0);
    trackActiveRequestStart("provider/model-a");
    expect(getActiveRequests("provider/model-a")).toBe(1);
    trackActiveRequestStart("provider/model-a");
    expect(getActiveRequests("provider/model-a")).toBe(2);
    trackActiveRequestEnd("provider/model-a");
    expect(getActiveRequests("provider/model-a")).toBe(1);
    trackActiveRequestEnd("provider/model-a");
    expect(getActiveRequests("provider/model-a")).toBe(0);
  });

  it("chooses the least loaded candidate when comparing two models", () => {
    const models = ["provider-a/model-1", "provider-b/model-2"];

    // Make provider-a loaded with 5 in-flight requests
    for (let i = 0; i < 5; i++) {
      trackActiveRequestStart("provider-a/model-1");
    }

    const ordered = orderTargetsByPowerOfTwoChoices(models, { log: noopLog });
    // provider-b/model-2 has 0 load, provider-a/model-1 has 5 load
    expect(ordered[0]).toBe("provider-b/model-2");
    expect(ordered).toContain("provider-a/model-1");
  });
  it("penalizes models whose circuit breaker is OPEN", () => {
    const models = ["broken-prov/model-1", "healthy-prov/model-2"];
    const breaker = getCircuitBreaker("broken-prov", {});
    breaker._transition(STATE.OPEN);

    const loadBroken = getTargetLoad("broken-prov/model-1");
    const loadHealthy = getTargetLoad("healthy-prov/model-2");
    expect(loadBroken).toBeGreaterThanOrEqual(10000);
    expect(loadHealthy).toBe(0);

    const ordered = orderTargetsByPowerOfTwoChoices(models, { log: noopLog });
    expect(ordered[0]).toBe("healthy-prov/model-2");

    breaker._transition(STATE.CLOSED);
  });

  it("works with single or empty target lists gracefully", () => {
    expect(orderTargetsByPowerOfTwoChoices([])).toEqual([]);
    expect(orderTargetsByPowerOfTwoChoices(["sole/model"])).toEqual(["sole/model"]);
  });
});

describe("Combo Reset-Aware Quota Scheduling", () => {
  beforeEach(() => {
    clearAccountQuotaResets();
    resetActiveRequests();
  });

  it("prioritizes accounts whose quota resets in < 48 hours over accounts with distant or no reset", async () => {
    const now = Date.now();
    const in2Hours = new Date(now + 2 * 3600 * 1000).toISOString();
    const in10Hours = new Date(now + 10 * 3600 * 1000).toISOString();
    const in5Days = new Date(now + 5 * 24 * 3600 * 1000).toISOString();

    const targets = [
      { model: "prov-distant/m1", resetAt: in5Days },
      { model: "prov-soon10/m2", resetAt: in10Hours },
      { model: "prov-urgent2/m3", resetAt: in2Hours },
      { model: "prov-unknown/m4" },
    ];

    const ordered = await orderTargetsByResetAware(targets, { log: noopLog });

    // Tier 1 (< 48h): urgent2 (2h) then soon10 (10h)
    // Tier 2 (> 48h): distant (5d)
    // Tier 3 (unknown): prov-unknown
    expect(ordered[0].model).toBe("prov-urgent2/m3");
    expect(ordered[1].model).toBe("prov-soon10/m2");
    expect(ordered[2].model).toBe("prov-distant/m1");
    expect(ordered[3].model).toBe("prov-unknown/m4");
  });

  it("demotes exhausted accounts (limitReached: true) to the back", async () => {
    const now = Date.now();
    const in2Hours = new Date(now + 2 * 3600 * 1000).toISOString();

    registerAccountQuotaReset("prov-exhausted", { limitReached: true, resetAt: in2Hours });
    registerAccountQuotaReset("prov-healthy", { limitReached: false, resetAt: in2Hours });

    const targets = ["prov-exhausted/model", "prov-healthy/model"];
    const ordered = await orderTargetsByResetAware(targets, { log: noopLog });

    expect(ordered[0]).toBe("prov-healthy/model");
    expect(ordered[1]).toBe("prov-exhausted/model");
  });

  it("reads quota reset timestamps from provider connections", async () => {
    const now = Date.now();
    const resetTime = new Date(now + 5 * 3600 * 1000).toISOString(); // 5h away (<48h)

    const connections = [
      { provider: "prov-db", isActive: true, quotaResetsAt: resetTime },
      { provider: "prov-other", isActive: true },
    ];

    const targets = ["prov-other/model", "prov-db/model"];
    const ordered = await orderTargetsByResetAware(targets, { connections, log: noopLog });

    // prov-db has a reset in 5h (< 48h), so it must be promoted to the front
    expect(ordered[0]).toBe("prov-db/model");
    expect(ordered[1]).toBe("prov-other/model");
  });
});

describe("handleComboChat with P2C, Reset-Aware, and targetTimeoutMs", () => {
  beforeEach(() => {
    clearAccountQuotaResets();
    resetActiveRequests();
  });

  it("routes through p2c strategy and manages active requests", async () => {
    const models = ["prov-a/m1", "prov-b/m2"];
    let activeDuringCall = 0;

    const handleSingleModel = vi.fn().mockImplementation(async (_body, modelStr) => {
      activeDuringCall = getActiveRequests(modelStr);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models,
      handleSingleModel,
      log: noopLog,
      comboName: "test-p2c",
      comboStrategy: "p2c",
    });

    expect(res.ok).toBe(true);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
    expect(activeDuringCall).toBe(1);
    expect(getActiveRequests("prov-a/m1")).toBe(0);
    expect(getActiveRequests("prov-b/m2")).toBe(0);
  });

  it("routes through reset-aware strategy prioritizing near-reset target", async () => {
    const now = Date.now();
    const in1h = new Date(now + 3600 * 1000).toISOString();
    registerAccountQuotaReset("prov-fast", { resetAt: in1h });

    const models = ["prov-slow/m1", "prov-fast/m2"];
    const attempted = [];

    const handleSingleModel = vi.fn().mockImplementation(async (_body, modelStr) => {
      attempted.push(modelStr);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models,
      handleSingleModel,
      log: noopLog,
      comboName: "test-reset-aware",
      comboStrategy: "reset-aware",
    });

    expect(res.ok).toBe(true);
    // prov-fast resets in 1h, so it must be attempted first
    expect(attempted[0]).toBe("prov-fast/m2");
  });

  it("supports targetTimeoutMs on individual combo target and falls back", async () => {
    const models = [
      { model: "slow-prov/m1", targetTimeoutMs: 50 },
      { model: "fast-prov/m2" },
    ];

    const attempted = [];
    const handleSingleModel = vi.fn().mockImplementation(async (_body, modelStr, opts) => {
      attempted.push(modelStr);
      if (modelStr === "slow-prov/m1") {
        // Hang longer than 50ms
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 200);
          opts?.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        return new Response("hung", { status: 500 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models,
      handleSingleModel,
      log: noopLog,
      comboName: "test-timeout",
      comboStrategy: "fallback",
    });

    expect(res.ok).toBe(true);
    expect(attempted).toEqual(["slow-prov/m1", "fast-prov/m2"]);
  });

  it("aborts combo execution immediately when client signal aborts", async () => {
    const controller = new AbortController();
    controller.abort();

    const handleSingleModel = vi.fn();

    const res = await handleComboChat({
      body: { messages: [{ role: "user", content: "hi" }] },
      models: ["prov/m1", "prov/m2"],
      handleSingleModel,
      log: noopLog,
      comboName: "test-abort",
      signal: controller.signal,
    });

    expect(res.status).toBe(499);
    expect(handleSingleModel).not.toHaveBeenCalled();
  });
});
