import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { awaitFirstChunk, describeReadinessFailure, READINESS_STATE } from "../../open-sse/utils/streamReadiness.js";

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

  it("times out when no chunk arrives, cancels the upstream body and leaks no timer", async () => {
    const upstream = controllableBody();
    const pending = awaitFirstChunk(upstream.body, { timeoutMs: 25_000 });

    await vi.advanceTimersByTimeAsync(24_999);
    expect(upstream.cancel).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(result.state).toBe(READINESS_STATE.TIMEOUT);
    expect(upstream.cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores a chunk that shows up after the timeout", async () => {
    const upstream = controllableBody();
    const pending = awaitFirstChunk(upstream.body, { timeoutMs: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await pending).state).toBe(READINESS_STATE.TIMEOUT);

    expect(() => upstream.push("late")).toThrow(); // controller already closed by the cancel
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

describe("describeReadinessFailure", () => {
  it("maps a timeout to a 504 that names the bound", () => {
    const failure = describeReadinessFailure({ state: READINESS_STATE.TIMEOUT }, { timeoutMs: 25_000 });
    expect(failure.status).toBe(504);
    expect(failure.errorCode).toBe("STREAM_READINESS_TIMEOUT");
    expect(failure.message).toBe("[504]: no data from upstream within 25000ms (stream readiness timeout)");
  });

  it("maps a pre-first-chunk read error to a 502 carrying the cause", () => {
    const failure = describeReadinessFailure({ state: READINESS_STATE.ERROR, error: new Error("socket hang up") }, { timeoutMs: 25_000 });
    expect(failure.status).toBe(502);
    expect(failure.errorCode).toBe("STREAM_READ_ERROR");
    expect(failure.message).toContain("socket hang up");
  });

  it("copes with an error without a message", () => {
    const failure = describeReadinessFailure({ state: READINESS_STATE.ERROR }, { timeoutMs: 1_000 });
    expect(failure.message).toContain("read error");
  });

  it("never matches a rate-limit rule, so it is a plain transient failure for account fallback", () => {
    const { message } = describeReadinessFailure({ state: READINESS_STATE.TIMEOUT }, { timeoutMs: 25_000 });
    expect(/rate limit|too many requests|quota exceeded|capacity|overloaded/i.test(message)).toBe(false);
  });
});
