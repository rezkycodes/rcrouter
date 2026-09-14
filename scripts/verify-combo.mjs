import assert from "node:assert/strict";
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
} from "../open-sse/services/combo.js";
import { getCircuitBreaker, STATE } from "../open-sse/utils/circuitBreaker.js";

const noopLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

async function runTests() {
  console.log("=== Running RcRouter Combo P2C, Reset-Aware & Target Timeout Verification ===");

  // 1. In-flight request tracking
  console.log("Test 1: In-flight active request tracking");
  resetActiveRequests();
  assert.equal(getActiveRequests("provider/model-a"), 0);
  trackActiveRequestStart("provider/model-a");
  assert.equal(getActiveRequests("provider/model-a"), 1);
  trackActiveRequestStart("provider/model-a");
  assert.equal(getActiveRequests("provider/model-a"), 2);
  trackActiveRequestEnd("provider/model-a");
  assert.equal(getActiveRequests("provider/model-a"), 1);
  trackActiveRequestEnd("provider/model-a");
  assert.equal(getActiveRequests("provider/model-a"), 0);
  console.log("✔ In-flight tracking passed");

  // 2. P2C selection based on active request load
  console.log("Test 2: P2C selection based on active requests");
  resetActiveRequests();
  for (let i = 0; i < 4; i++) {
    trackActiveRequestStart("prov-busy/m1");
  }
  assert.equal(getActiveRequests("prov-busy/m1"), 4);
  assert.equal(getActiveRequests("prov-idle/m2"), 0);

  const p2cOrdered = orderTargetsByPowerOfTwoChoices(["prov-busy/m1", "prov-idle/m2"], { log: noopLog });
  assert.equal(p2cOrdered[0], "prov-idle/m2", "Idle target should be selected first by P2C");
  assert.equal(p2cOrdered[1], "prov-busy/m1");
  console.log("✔ P2C load-based selection passed");

  // 3. P2C selection with circuit breaker penalty
  console.log("Test 3: P2C circuit breaker penalty");
  resetActiveRequests();
  const breaker = getCircuitBreaker("prov-broken", {});
  breaker._transition(STATE.OPEN);

  const loadBroken = getTargetLoad("prov-broken/m1");
  const loadHealthy = getTargetLoad("prov-healthy/m2");
  assert.ok(loadBroken >= 10000, `Broken load should be >= 10000, got ${loadBroken}`);
  assert.equal(loadHealthy, 0);

  const p2cBreakerOrdered = orderTargetsByPowerOfTwoChoices(["prov-broken/m1", "prov-healthy/m2"], { log: noopLog });
  assert.equal(p2cBreakerOrdered[0], "prov-healthy/m2", "Healthy target must be selected over OPEN circuit breaker");
  breaker._transition(STATE.CLOSED);
  console.log("✔ P2C circuit breaker health check passed");

  // 4. Reset-Aware: Quota expiring soon (< 48 hours)
  console.log("Test 4: Reset-Aware quota prioritization (< 48 hours)");
  clearAccountQuotaResets();
  const now = Date.now();
  const in1Hour = new Date(now + 1 * 3600 * 1000).toISOString();
  const in12Hours = new Date(now + 12 * 3600 * 1000).toISOString();
  const in3Days = new Date(now + 3 * 24 * 3600 * 1000).toISOString();

  const targets = [
    { model: "prov-3days/m1", resetAt: in3Days },
    { model: "prov-12h/m2", resetAt: in12Hours },
    { model: "prov-1h/m3", resetAt: in1Hour },
    { model: "prov-unknown/m4" },
  ];

  const resetOrdered = await orderTargetsByResetAware(targets, { log: noopLog });
  assert.equal(resetOrdered[0].model, "prov-1h/m3", "Target resetting in 1h must be first (< 48h)");
  assert.equal(resetOrdered[1].model, "prov-12h/m2", "Target resetting in 12h must be second (< 48h)");
  assert.equal(resetOrdered[2].model, "prov-3days/m1", "Target resetting in 3 days must be third (> 48h)");
  assert.equal(resetOrdered[3].model, "prov-unknown/m4", "Target with unknown reset must be fourth");
  console.log("✔ Reset-aware < 48h prioritization passed");

  // 5. Reset-Aware: Demotion of exhausted accounts
  console.log("Test 5: Reset-Aware demotion of exhausted accounts");
  clearAccountQuotaResets();
  registerAccountQuotaReset("prov-exhausted", { limitReached: true, resetAt: in1Hour });
  registerAccountQuotaReset("prov-fresh", { limitReached: false, resetAt: in12Hours });

  const exhaustedTargets = ["prov-exhausted/model", "prov-fresh/model"];
  const exhaustedOrdered = await orderTargetsByResetAware(exhaustedTargets, { log: noopLog });
  assert.equal(exhaustedOrdered[0], "prov-fresh/model", "Fresh account must come before exhausted account");
  assert.equal(exhaustedOrdered[1], "prov-exhausted/model", "Exhausted account must be demoted to back");
  console.log("✔ Reset-aware exhausted demotion passed");

  // 6. Reset-Aware: Reading from provider connections
  console.log("Test 6: Reset-Aware reading from connection objects");
  clearAccountQuotaResets();
  const connResetTime = new Date(now + 6 * 3600 * 1000).toISOString(); // 6h away (<48h)
  const connections = [
    { provider: "prov-conn-fast", isActive: true, quotaResetsAt: connResetTime },
    { provider: "prov-conn-none", isActive: true },
  ];
  const connTargets = ["prov-conn-none/m1", "prov-conn-fast/m2"];
  const connOrdered = await orderTargetsByResetAware(connTargets, { connections, log: noopLog });
  assert.equal(connOrdered[0], "prov-conn-fast/m2", "Connection resetting in 6h should promote target to front");
  console.log("✔ Reset-aware connection inspection passed");

  // 7. handleComboChat with P2C strategy
  console.log("Test 7: handleComboChat with P2C strategy");
  resetActiveRequests();
  let p2cTrackedActive = 0;
  const handleSingleModelP2C = async (_body, modelStr) => {
    p2cTrackedActive = getActiveRequests(modelStr);
    return new Response(JSON.stringify({ ok: true, model: modelStr }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const p2cRes = await handleComboChat({
    body: { messages: [{ role: "user", content: "hello" }] },
    models: ["prov-x/m1", "prov-y/m2"],
    handleSingleModel: handleSingleModelP2C,
    log: noopLog,
    comboName: "p2c-test-combo",
    comboStrategy: "p2c",
  });
  assert.equal(p2cRes.ok, true);
  assert.equal(p2cTrackedActive, 1, "In-flight request counter should be 1 during execution");
  assert.equal(getActiveRequests("prov-x/m1"), 0, "Counter must return to 0 after execution");
  assert.equal(getActiveRequests("prov-y/m2"), 0, "Counter must return to 0 after execution");
  console.log("✔ handleComboChat P2C execution passed");

  // 8. handleComboChat with Reset-Aware strategy
  console.log("Test 8: handleComboChat with Reset-Aware strategy");
  clearAccountQuotaResets();
  registerAccountQuotaReset("prov-soon", { resetAt: in1Hour });
  const attemptedModels = [];
  const handleSingleModelRA = async (_body, modelStr) => {
    attemptedModels.push(modelStr);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const raRes = await handleComboChat({
    body: { messages: [{ role: "user", content: "hello" }] },
    models: ["prov-later/m1", "prov-soon/m2"],
    handleSingleModel: handleSingleModelRA,
    log: noopLog,
    comboName: "ra-test-combo",
    comboStrategy: "reset-aware",
  });
  assert.equal(raRes.ok, true);
  assert.equal(attemptedModels[0], "prov-soon/m2", "prov-soon resetting in 1h must be attempted first");
  console.log("✔ handleComboChat Reset-Aware execution passed");

  // 9. handleComboChat with targetTimeoutMs on individual target
  console.log("Test 9: handleComboChat targetTimeoutMs fallback");
  const timeoutAttempts = [];
  const handleSingleModelTimeout = async (_body, modelStr, opts) => {
    timeoutAttempts.push(modelStr);
    if (modelStr === "slow/m1") {
      // Simulate hung upstream that exceeds 50ms timeout
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 300);
        opts?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      return new Response("hung", { status: 504 });
    }
    return new Response(JSON.stringify({ success: true, from: modelStr }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const timeoutRes = await handleComboChat({
    body: { messages: [{ role: "user", content: "hello" }] },
    models: [
      { model: "slow/m1", targetTimeoutMs: 50 },
      { model: "fast/m2" },
    ],
    handleSingleModel: handleSingleModelTimeout,
    log: noopLog,
    comboName: "timeout-test-combo",
    comboStrategy: "fallback",
  });
  assert.equal(timeoutRes.ok, true);
  const timeoutData = await timeoutRes.json();
  assert.equal(timeoutData.from, "fast/m2");
  assert.deepEqual(timeoutAttempts, ["slow/m1", "fast/m2"], "Must attempt slow/m1 first, timeout, then fall back to fast/m2");
  console.log("✔ handleComboChat targetTimeoutMs fallback passed");

  // 10. Client abort signal handling
  console.log("Test 10: Client abort signal terminates combo immediately");
  const abortController = new AbortController();
  abortController.abort();

  let abortCalled = false;
  const handleSingleModelAbort = async () => {
    abortCalled = true;
    return new Response("ok", { status: 200 });
  };

  const abortRes = await handleComboChat({
    body: { messages: [{ role: "user", content: "hello" }] },
    models: ["model/1", "model/2"],
    handleSingleModel: handleSingleModelAbort,
    log: noopLog,
    signal: abortController.signal,
  });
  assert.equal(abortRes.status, 499, "Must return status 499 on client disconnect");
  assert.equal(abortCalled, false, "Should not call handleSingleModel when signal is already aborted");
  console.log("✔ Client abort signal handling passed");

  console.log("\nAll 10 Verification Tests Passed Successfully! 🎉");
}

runTests().catch((err) => {
  console.error("❌ Verification test failed:", err);
  process.exit(1);
});
