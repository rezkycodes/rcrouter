import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { commitContextRelayAffinity, getRotatedModels, handleComboChat, orderTargetsByContextRelay, resetComboRotation, resetContextRelay } from "../../open-sse/services/combo.js";
import { makeDescriptor } from "../../open-sse/services/targetDescriptor.js";

describe("combo round-robin routing", () => {
  beforeEach(() => {
    resetComboRotation();
    resetContextRelay();
  });
  afterEach(() => vi.useRealTimers());

  it("keeps existing one-request round-robin behavior by default", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 4 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin")[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-b",
      "provider/model-a",
      "provider/model-b",
    ]);
  });

  it("sticks to each combo model for the configured number of requests", () => {
    const models = ["provider/model-a", "provider/model-b"];

    const firstChoices = Array.from({ length: 6 }, () => (
      getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]
    ));

    expect(firstChoices).toEqual([
      "provider/model-a",
      "provider/model-a",
      "provider/model-b",
      "provider/model-b",
      "provider/model-a",
      "provider/model-a",
    ]);
  });

  it("tracks sticky rotation independently per combo", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-a");
    expect(getRotatedModels(models, "code-high", "round-robin", 2)[0]).toBe("provider/model-b");
    expect(getRotatedModels(models, "code-xhigh", "round-robin", 2)[0]).toBe("provider/model-a");
  });

  it("does not rotate fallback combos", () => {
    const models = ["provider/model-a", "provider/model-b"];

    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
    expect(getRotatedModels(models, "code-xhigh", "fallback", 2)).toEqual(models);
  });

  it("carries an explicit TargetDescriptor account pin into the leaf handler", async () => {
    const handleSingleModel = vi.fn(async (_body, model, options) => {
      expect(model).toBe("provider/model-a");
      expect(options?.preferredConnectionId).toBe("account-a");
      return new Response("ok");
    });

    const response = await handleComboChat({
      body: { messages: [] },
      models: [makeDescriptor("provider/model-a", "account-a")],
      comboStrategy: "fallback",
      autoSwitch: false,
      timeoutMs: 0,
      log: { info: vi.fn(), warn: vi.fn() },
      handleSingleModel,
    });

    expect(response.ok).toBe(true);
    expect(handleSingleModel).toHaveBeenCalledTimes(1);
  });

  it("isolates Context Relay affinity by tenant without logging raw session IDs", () => {
    const log = { info: vi.fn() };
    const sessionId = "private-session-123";
    let sessionKey;

    expect(orderTargetsByContextRelay(["provider/model-a", "provider/model-b"], {
      comboName: "combo/coding", sessionId, tenantScope: "tenant-a", log,
      onAffinityKey: (key) => { sessionKey = key; },
    })[0]).toBe("provider/model-a");
    commitContextRelayAffinity(sessionKey, "account-a", "provider/model-a");
    expect(orderTargetsByContextRelay(["provider/model-b", "provider/model-a"], {
      comboName: "combo/coding", sessionId, tenantScope: "tenant-a", log,
    })[0]).toBe("provider/model-a");
    expect(orderTargetsByContextRelay(["provider/model-b", "provider/model-a"], {
      comboName: "combo/coding", sessionId, tenantScope: "tenant-b", log,
    })[0]).toBe("provider/model-b");

    expect(log.info.mock.calls.flat().join(" ")).not.toContain(sessionId);
    expect(log.info.mock.calls.flat().join(" ")).not.toContain("account-a");
  });

  it("pins the successful account and rebinds after model fallback", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const attempts = [];
    const run = async (models, failFirst = false) => handleComboChat({
      body: { messages: [] }, models, comboName: "combo/coding",
      comboStrategy: "context-relay", sessionId: "session-a", tenantScope: "tenant-a",
      autoSwitch: false, timeoutMs: 0, log,
      handleSingleModel: async (_body, model, opts) => {
        attempts.push({ model, preferred: opts?.preferredConnectionId });
        if (failFirst && model === "provider/model-a") {
          return new Response("failed", { status: 503 });
        }
        const account = model === "provider/model-a" ? "account-a" : "account-b";
        opts?._commitAffinity?.(opts._affinityKey, account, model);
        return new Response("ok");
      },
    });

    expect((await run(["provider/model-a", "provider/model-b"])).ok).toBe(true);
    expect((await run(["provider/model-b", "provider/model-a"])).ok).toBe(true);
    expect(attempts.at(-1)).toEqual({ model: "provider/model-a", preferred: "account-a" });

    expect((await run(["provider/model-a", "provider/model-b"], true)).ok).toBe(true);
    expect(attempts.slice(-2)).toEqual([
      { model: "provider/model-a", preferred: "account-a" },
      { model: "provider/model-b", preferred: undefined },
    ]);
    expect((await run(["provider/model-a", "provider/model-b"])).ok).toBe(true);
    expect(attempts.at(-1)).toEqual({ model: "provider/model-b", preferred: "account-b" });
  });

  it("does not anchor a failed request", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    const options = {
      body: { messages: [] }, comboName: "combo/coding", comboStrategy: "context-relay",
      sessionId: "session-a", tenantScope: "tenant-a", autoSwitch: false, timeoutMs: 0, log,
    };
    const failed = await handleComboChat({
      ...options, models: ["provider/model-a"],
      handleSingleModel: async () => new Response("failed", { status: 503 }),
    });
    expect(failed.ok).toBe(false);

    const attempt = vi.fn(async () => new Response("ok"));
    await handleComboChat({
      ...options, models: ["provider/model-b", "provider/model-a"], handleSingleModel: attempt,
    });
    expect(attempt.mock.calls[0][1]).toBe("provider/model-b");
    expect(attempt.mock.calls[0][2]?.preferredConnectionId).toBeUndefined();
  });

  it("expires an idle binding after 30 minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-13T00:00:00Z"));
    const options = { comboName: "combo/coding", sessionId: "idle", tenantScope: "tenant-a" };
    let key;
    orderTargetsByContextRelay(["provider/model-a"], {
      ...options, onAffinityKey: (sessionKey) => { key = sessionKey; },
    });
    commitContextRelayAffinity(key, "account-a", "provider/model-a");

    vi.advanceTimersByTime(30 * 60 * 1000 + 1);
    const preferred = vi.fn();
    expect(orderTargetsByContextRelay(["provider/model-b", "provider/model-a"], {
      ...options, onAffinityKey: preferred,
    })[0]).toBe("provider/model-b");
    expect(preferred).toHaveBeenCalledWith(key, null, "provider/model-b");
  });

  it("evicts the least recently used binding at the entry cap", () => {
    const keyFor = (sessionId) => {
      let key;
      orderTargetsByContextRelay(["provider/model-a"], {
        comboName: "combo/coding", sessionId, tenantScope: "tenant-a",
        onAffinityKey: (sessionKey) => { key = sessionKey; },
      });
      return key;
    };
    const oldKey = keyFor("old");
    const coldKey = keyFor("cold");
    const newKey = keyFor("new");
    commitContextRelayAffinity(oldKey, "account-a", "provider/model-a");
    commitContextRelayAffinity(coldKey, "account-a", "provider/model-a");
    for (let i = 0; i < 9998; i++) {
      commitContextRelayAffinity(`filler-${i}`, "account-a", "provider/model-a");
    }

    const reversed = ["provider/model-b", "provider/model-a"];
    expect(orderTargetsByContextRelay(reversed, {
      comboName: "combo/coding", sessionId: "old", tenantScope: "tenant-a",
    })[0]).toBe("provider/model-a");
    commitContextRelayAffinity(newKey, "account-b", "provider/model-b");
    expect(orderTargetsByContextRelay(reversed, {
      comboName: "combo/coding", sessionId: "cold", tenantScope: "tenant-a",
    })[0]).toBe("provider/model-b");
    expect(orderTargetsByContextRelay(reversed, {
      comboName: "combo/coding", sessionId: "old", tenantScope: "tenant-a",
    })[0]).toBe("provider/model-a");
  });

  it("ignores late affinity callbacks from a timed-out target", async () => {
    const log = { info: vi.fn(), warn: vi.fn() };
    let lateOptions;
    const common = {
      body: { messages: [] }, comboName: "combo/coding", comboStrategy: "context-relay",
      sessionId: "timeout", tenantScope: "tenant-a", autoSwitch: false, log,
    };
    const response = await handleComboChat({
      ...common, models: ["provider/model-a", "provider/model-b"], timeoutMs: 5,
      handleSingleModel: (_body, model, options) => {
        if (model === "provider/model-a") {
          lateOptions = options;
          return new Promise(() => {});
        }
        options._commitAffinity(options._affinityKey, "account-b", model);
        return Promise.resolve(new Response("ok"));
      },
    });
    expect(response.ok).toBe(true);
    expect(lateOptions.signal.aborted).toBe(true);
    lateOptions._commitAffinity(lateOptions._affinityKey, "account-a", "provider/model-a");
    lateOptions._invalidateAffinity(lateOptions._affinityKey, "account-b");

    const attempt = vi.fn(async () => new Response("ok"));
    await handleComboChat({
      ...common, models: ["provider/model-a", "provider/model-b"], timeoutMs: 0,
      handleSingleModel: attempt,
    });
    expect(attempt.mock.calls[0][1]).toBe("provider/model-b");
    expect(attempt.mock.calls[0][2].preferredConnectionId).toBe("account-b");
  });
});
