import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { awaitFirstChunk, describeReadError, READINESS_STATE, SETTLED } from "../../open-sse/utils/streamReadiness.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// A controllable upstream body that records cancellation.
function controllableBody() {
  let controller;
  const cancel = vi.fn();
  const body = new ReadableStream({
    start(c) { controller = c; },
    cancel,
  });
  return {
    body,
    cancel,
    push: (text) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
    fail: (error) => controller.error(error),
  };
}

async function readAll(stream) {
  const reader = stream.getReader();
  const parts = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return parts;
    parts.push(decoder.decode(value));
  }
}

describe("awaitFirstChunk", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is ready as soon as the first chunk arrives and replays it first", async () => {
    const upstream = controllableBody();
    const pending = awaitFirstChunk(upstream.body, { timeoutMs: 25_000 });
    upstream.push("data: one\n\n");
    const result = await pending;

    expect(result.state).toBe(READINESS_STATE.READY);
    upstream.push("data: two\n\n");
    upstream.close();
    expect(await readAll(result.body)).toEqual(["data: one\n\n", "data: two\n\n"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  describe("when no chunk arrives within the threshold", () => {
    async function timedOut(timeoutMs = 25_000) {
      const upstream = controllableBody();
      const pending = awaitFirstChunk(upstream.body, { timeoutMs });
      await vi.advanceTimersByTimeAsync(timeoutMs - 1);
      let settled = false;
      pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false); // not yet at the threshold
      await vi.advanceTimersByTimeAsync(1);
      return { upstream, result: await pending };
    }

    it("commits anyway (timeout state) without cancelling the upstream, and leaks no timer", async () => {
      const { upstream, result } = await timedOut();

      expect(result.state).toBe(READINESS_STATE.TIMEOUT);
      expect(result.body).toBeInstanceOf(ReadableStream);
      expect(upstream.cancel).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("delivers the late first chunk intact and in order, then the rest", async () => {
      const { upstream, result } = await timedOut();

      const reader = result.body.getReader();
      const first = reader.read();
      await vi.advanceTimersByTimeAsync(40_000);
      upstream.push("data: late\n\n");
      expect(decoder.decode((await first).value)).toBe("data: late\n\n");
      expect(await result.firstSettled).toBe(SETTLED.DATA);

      upstream.push("data: two\n\n");
      upstream.close();
      const rest = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        rest.push(decoder.decode(value));
      }
      expect(rest).toEqual(["data: two\n\n"]);
    });

    it("reports END (a clean empty stream) when upstream closes without data", async () => {
      const { upstream, result } = await timedOut();
      upstream.close();

      expect(await result.firstSettled).toBe(SETTLED.END);
      expect(await readAll(result.body)).toEqual([]);
    });

    it("surfaces a stall that ends in an upstream error as a stream error, not a success", async () => {
      const { upstream, result } = await timedOut();
      const reader = result.body.getReader();
      const read = reader.read();
      upstream.fail(new Error("upstream exploded"));

      await expect(read).rejects.toThrow("upstream exploded");
      expect(await result.firstSettled).toBe(SETTLED.ERROR);
    });

    it("cancelling during the wait cancels the upstream reader and is not reported as data or end", async () => {
      const { upstream, result } = await timedOut();
      const reader = result.body.getReader();
      const read = reader.read();

      await reader.cancel("client closed");
      expect((await read).done).toBe(true);
      expect(upstream.cancel).toHaveBeenCalledWith("client closed");
      expect(await result.firstSettled).toBe(SETTLED.CANCELLED);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("treats an upstream that closes without a byte as empty, not as a failure", async () => {
    const upstream = controllableBody();
    const pending = awaitFirstChunk(upstream.body, { timeoutMs: 25_000 });
    upstream.close();
    const result = await pending;

    expect(result.state).toBe(READINESS_STATE.EMPTY);
    expect(await readAll(result.body)).toEqual([]);
  });

  it("reports a read error before the first chunk and releases the upstream", async () => {
    const upstream = controllableBody();
    const pending = awaitFirstChunk(upstream.body, { timeoutMs: 25_000 });
    const boom = new Error("socket hang up");
    upstream.fail(boom);
    const result = await pending;

    expect(result.state).toBe(READINESS_STATE.ERROR);
    expect(result.error).toBe(boom);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("passes non-stream bodies through untouched", async () => {
    expect(await awaitFirstChunk(null, { timeoutMs: 1_000 })).toEqual({ state: READINESS_STATE.READY, body: null });
  });

  it("propagates a mid-stream error to the consumer after the first chunk", async () => {
    const upstream = controllableBody();
    const pending = awaitFirstChunk(upstream.body, { timeoutMs: 25_000 });
    upstream.push("data: one\n\n");
    const { body } = await pending;

    const reader = body.getReader();
    expect(decoder.decode((await reader.read()).value)).toBe("data: one\n\n");
    const next = reader.read();
    upstream.fail(new Error("reset"));
    await expect(next).rejects.toThrow("reset");
  });

  it("cancelling the resumed stream cancels the upstream", async () => {
    const upstream = controllableBody();
    const pending = awaitFirstChunk(upstream.body, { timeoutMs: 25_000 });
    upstream.push("data: one\n\n");
    const { body } = await pending;

    await body.cancel("client closed");
    expect(upstream.cancel).toHaveBeenCalledWith("client closed");
  });
});

describe("describeReadError", () => {
  it("maps a pre-first-chunk read error to a 502 carrying the cause", () => {
    const failure = describeReadError({ state: READINESS_STATE.ERROR, error: new Error("socket hang up") });
    expect(failure.status).toBe(502);
    expect(failure.errorCode).toBe("STREAM_READ_ERROR");
    expect(failure.message).toContain("socket hang up");
  });

  it("copes with an error without a message", () => {
    expect(describeReadError({ state: READINESS_STATE.ERROR }).message).toContain("read error");
  });

  it("never matches a rate-limit rule, so it is a plain transient failure for account fallback", () => {
    const { message } = describeReadError({ state: READINESS_STATE.ERROR, error: new Error("terminated") });
    expect(/rate limit|too many requests|quota exceeded|capacity|overloaded/i.test(message)).toBe(false);
  });
});
