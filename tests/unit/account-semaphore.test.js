import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquire,
  getAccountSemaphoreStats,
  isSemaphoreCapacityError,
  markBlocked,
  resolveAccountSemaphoreKey,
  resolveAccountSemaphoreMaxConcurrency,
  SemaphoreCapacityError,
} from "../../open-sse/services/accountSemaphore.js";

describe("account semaphore", () => {
  afterEach(() => vi.useRealTimers());

  it("queues requests and releases slots in FIFO order", async () => {
    const first = await acquire("test:fifo", { maxConcurrency: 1 });
    let secondResolved = false;
    const second = acquire("test:fifo", { maxConcurrency: 1 }).then((release) => {
      secondResolved = true;
      return release;
    });

    expect(getAccountSemaphoreStats()).toEqual([
      expect.objectContaining({ key: "test:fifo", running: 1, queued: 1, maxConcurrency: 1 }),
    ]);
    expect(secondResolved).toBe(false);
    first();
    const releaseSecond = await second;
    expect(secondResolved).toBe(true);
    releaseSecond();
  });

  it("cancels a queued request without leaking a slot", async () => {
    const first = await acquire("test:abort", { maxConcurrency: 1 });
    const controller = new AbortController();
    const queued = acquire("test:abort", { maxConcurrency: 1, signal: controller.signal });
    controller.abort(new Error("client disconnected"));
    await expect(queued).rejects.toThrow("client disconnected");
    first();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getAccountSemaphoreStats().find((stat) => stat.key === "test:abort")).toBeUndefined();
  });

  it("reports queue timeout as a capacity error", async () => {
    const first = await acquire("test:timeout", { maxConcurrency: 1 });
    await expect(acquire("test:timeout", { maxConcurrency: 1, timeoutMs: 5 }))
      .rejects.toBeInstanceOf(SemaphoreCapacityError);
    expect(isSemaphoreCapacityError(new SemaphoreCapacityError("test:timeout", 5))).toBe(true);
    first();
  });

  it("keeps queued work blocked during an account cooldown", async () => {
    vi.useFakeTimers();
    const first = await acquire("test:blocked", { maxConcurrency: 1 });
    markBlocked("test:blocked", 1000);
    let resolved = false;
    const queued = acquire("test:blocked", { maxConcurrency: 1 }).then((release) => {
      resolved = true;
      return release;
    });

    first();
    await Promise.resolve();
    expect(resolved).toBe(false);

    vi.advanceTimersByTime(1000);
    const releaseQueued = await queued;
    expect(resolved).toBe(true);
    releaseQueued();
  });

  it("resolves account keys and configurable limits", () => {
    expect(resolveAccountSemaphoreKey({
      provider: "openai", connectionId: "conn-1", proxyHash: "proxy-a",
    })).toBe("openai:conn-1:proxy-a");
    expect(resolveAccountSemaphoreKey({ provider: "openai" })).toBeNull();
    expect(resolveAccountSemaphoreMaxConcurrency({ providerSpecificData: { maxConcurrency: 7 } })).toBe(7);
    expect(resolveAccountSemaphoreMaxConcurrency({ providerSpecificData: { maxConcurrency: 0 } })).toBeNull();
    expect(resolveAccountSemaphoreMaxConcurrency({})).toBe(3);
  });
});
