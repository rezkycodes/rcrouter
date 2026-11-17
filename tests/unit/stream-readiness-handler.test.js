import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  appendRequestLog: vi.fn(async () => {}),
  trackPendingRequest: vi.fn(),
}));

vi.mock("@/lib/usageDb.js", () => db);

import { handleStreamingResponse } from "../../open-sse/handlers/chatCore/streamingHandler.js";
import { createStreamController } from "../../open-sse/utils/streamHandler.js";
import { SSE_KEEPALIVE } from "../../open-sse/config/resilienceConfig.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const THRESHOLD_MS = 25_000;
const event = (text) => `data: {"choices":[{"delta":{"content":"${text}"}}]}\n\n`;

function upstreamBody() {
  let controller;
  const cancel = vi.fn();
  const body = new ReadableStream({ start(c) { controller = c; }, cancel });
  return {
    body,
    cancel,
    push: (text) => controller.enqueue(encoder.encode(text)),
    close: () => controller.close(),
    fail: (error) => controller.error(error),
  };
}

function setup({ streamReadinessTimeoutMs } = {}) {
  const upstream = upstreamBody();
  const providerResponse = new Response(upstream.body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
  const streamController = createStreamController({ provider: "openai", model: "gpt-test", log: { line: vi.fn(), errorLine: vi.fn() } });
  const abort = vi.spyOn(streamController, "abort");
  const handleError = vi.spyOn(streamController, "handleError");
  const onRequestSuccess = vi.fn(async () => {});

  const run = () => handleStreamingResponse({
    providerResponse,
    provider: "openai",
    model: "gpt-test",
    sourceFormat: "openai",
    targetFormat: "openai",
    userAgent: "vitest",
    body: { messages: [] },
    stream: true,
    translatedBody: {},
    finalBody: {},
    requestStartTime: Date.now(),
    connectionId: "conn-1",
    apiKey: null,
    clientRawRequest: { endpoint: "/v1/chat/completions" },
    onRequestSuccess,
    reqLogger: null,
    toolNameMap: null,
    customToolNames: null,
    streamController,
    onStreamComplete: vi.fn(),
    streamDetailId: "detail-1",
    pxpipe: null,
    reqTag: "t",
    log: { line: vi.fn(), errorLine: vi.fn(), warn: vi.fn() },
    credentials: null,
    streamReadinessTimeoutMs,
  });

  return { upstream, run, streamController, abort, handleError, onRequestSuccess };
}

// Passthrough emits a line and its blank terminator as separate chunks.
async function readUntil(reader, predicate) {
  let seen = "";
  while (!predicate(seen)) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += decoder.decode(value);
  }
  return seen;
}

// Starts the handler, lets the readiness threshold pass with no upstream data,
// and returns the committed (unpeeked) response.
async function commitWithoutData(options) {
  const ctx = setup(options);
  const pending = ctx.run();
  await vi.advanceTimersByTimeAsync(options?.streamReadinessTimeoutMs ?? THRESHOLD_MS);
  const result = await pending;
  return { ...ctx, result, reader: result.response.body.getReader() };
}

describe("handleStreamingResponse readiness peek", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  describe("no first chunk within the threshold", () => {
    it("commits the response instead of failing over, keeping the upstream alive", async () => {
      const ctx = setup();
      const pending = ctx.run();
      let settled = false;
      pending.then(() => { settled = true; });

      await vi.advanceTimersByTimeAsync(THRESHOLD_MS - 1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;

      expect(result.success).toBe(true);
      expect(result.response.status).toBe(200);
      expect(result.response.headers.get("content-type")).toBe("text/event-stream");
      expect(ctx.upstream.cancel).not.toHaveBeenCalled();
      expect(ctx.abort).not.toHaveBeenCalled();
      expect(ctx.handleError).not.toHaveBeenCalled();
      expect(db.saveRequestDetail).toHaveBeenCalledTimes(1);
      expect(db.appendRequestLog).not.toHaveBeenCalled();
      await result.response.body.cancel();
    });

    it("does not report upstream success at commit time", async () => {
      const { onRequestSuccess, reader } = await commitWithoutData();
      await vi.advanceTimersByTimeAsync(0);

      expect(onRequestSuccess).not.toHaveBeenCalled();
      await reader.cancel();
    });

    it("lets the keep-alive heartbeat cover the wait", async () => {
      const { reader } = await commitWithoutData();

      const first = reader.read();
      await vi.advanceTimersByTimeAsync(SSE_KEEPALIVE.INTERVAL_MS);
      expect(decoder.decode((await first).value)).toBe(SSE_KEEPALIVE.COMMENT);

      const second = reader.read();
      await vi.advanceTimersByTimeAsync(SSE_KEEPALIVE.INTERVAL_MS);
      expect(decoder.decode((await second).value)).toBe(SSE_KEEPALIVE.COMMENT);
      await reader.cancel();
    });

    it("delivers a late first chunk intact and in order, reporting success only then", async () => {
      const { upstream, onRequestSuccess, reader } = await commitWithoutData();

      await vi.advanceTimersByTimeAsync(40_000);
      expect(onRequestSuccess).not.toHaveBeenCalled();

      upstream.push(event("one"));
      upstream.push(event("two"));
      const received = await readUntil(reader, (text) => text.includes("two") && text.endsWith("\n\n"));
      const payload = received.split(SSE_KEEPALIVE.COMMENT).join("");

      expect(payload.indexOf("\"content\":\"one\"")).toBeGreaterThanOrEqual(0);
      expect(payload.indexOf("\"content\":\"one\"")).toBeLessThan(payload.indexOf("\"content\":\"two\""));
      await vi.advanceTimersByTimeAsync(0);
      expect(onRequestSuccess).toHaveBeenCalledTimes(1);
      await reader.cancel();
    });

    it("reports success when the stream ends cleanly after the threshold without data", async () => {
      const { upstream, onRequestSuccess, reader } = await commitWithoutData();
      upstream.close();

      const text = await readUntil(reader, () => false);
      expect(text).not.toContain("\"content\"");
      await vi.advanceTimersByTimeAsync(0);
      expect(onRequestSuccess).toHaveBeenCalledTimes(1);
    });

    it("surfaces a stall that ends in an upstream error as a stream error, with no retry and no success", async () => {
      const { upstream, handleError, onRequestSuccess, result, reader } = await commitWithoutData();
      const beat = reader.read();
      await vi.advanceTimersByTimeAsync(SSE_KEEPALIVE.INTERVAL_MS);
      expect(decoder.decode((await beat).value)).toBe(SSE_KEEPALIVE.COMMENT);

      const read = reader.read();
      upstream.fail(new Error("upstream exploded"));
      await expect(read).rejects.toThrow("upstream exploded");

      expect(result.success).toBe(true); // already committed: the error reaches the client as a stream error
      expect(handleError).toHaveBeenCalledWith(expect.objectContaining({ message: "upstream exploded" }));
      expect(onRequestSuccess).not.toHaveBeenCalled();
      expect(db.appendRequestLog).not.toHaveBeenCalled();
    });

    it("cancels the upstream reader and clears every timer when the client aborts during the wait", async () => {
      const { upstream, onRequestSuccess, reader } = await commitWithoutData();
      await vi.advanceTimersByTimeAsync(5_000);

      await reader.cancel("client closed");
      await vi.advanceTimersByTimeAsync(1_000); // lets the delayed abort of the stream controller fire

      expect(upstream.cancel).toHaveBeenCalledTimes(1);
      expect(onRequestSuccess).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("closes gracefully, without reporting success, when the fetch is aborted during the wait", async () => {
      const { upstream, streamController, onRequestSuccess, reader } = await commitWithoutData();
      const read = reader.read();

      streamController.abort();
      upstream.fail(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));

      expect((await read).done).toBe(true);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onRequestSuccess).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("honours a configured threshold and clamps tiny values to 1s", async () => {
      const configured = setup({ streamReadinessTimeoutMs: 5_000 });
      const pendingConfigured = configured.run();
      await vi.advanceTimersByTimeAsync(5_000);
      const committed = await pendingConfigured;
      expect(committed.success).toBe(true);
      await committed.response.body.cancel();

      const clamped = setup({ streamReadinessTimeoutMs: 10 });
      const pendingClamped = clamped.run();
      let settled = false;
      pendingClamped.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pendingClamped;
      expect(result.success).toBe(true);
      await result.response.body.cancel();
    });
  });

  describe("first chunk in time or a fast failure", () => {
    it("succeeds when the first chunk arrives in time and reports success only then", async () => {
      const { upstream, run, onRequestSuccess } = setup();
      const pending = run();

      await vi.advanceTimersByTimeAsync(10_000);
      expect(onRequestSuccess).not.toHaveBeenCalled();
      upstream.push(event("hi"));
      const result = await pending;

      expect(result.success).toBe(true);
      expect(result.response.headers.get("content-type")).toBe("text/event-stream");
      await vi.advanceTimersByTimeAsync(0);
      expect(onRequestSuccess).toHaveBeenCalledTimes(1);

      const reader = result.response.body.getReader();
      const { value } = await reader.read();
      expect(decoder.decode(value)).toContain("\"content\":\"hi\"");
      await reader.cancel();
    });

    it("fails over on an upstream read error before the first chunk (502) and does not wait", async () => {
      const { upstream, run, onRequestSuccess } = setup();
      const pending = run();
      upstream.fail(new Error("socket hang up"));
      const result = await pending;

      expect(result.success).toBe(false);
      expect(result.status).toBe(502);
      expect(onRequestSuccess).not.toHaveBeenCalled();
      expect(db.appendRequestLog).toHaveBeenCalledWith(expect.objectContaining({ status: "FAILED 502", provider: "openai" }));
    });

    it("treats a client abort during the peek as a fast failure and leaves no timer behind", async () => {
      const { upstream, run, streamController, onRequestSuccess } = setup();
      const pending = run();

      streamController.abort();
      upstream.fail(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
      const result = await pending;

      expect(result.success).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onRequestSuccess).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("keeps an upstream that closes without a byte as a normal (empty) success", async () => {
      const { upstream, run, onRequestSuccess } = setup();
      const pending = run();
      upstream.close();
      const result = await pending;

      expect(result.success).toBe(true);
      const reader = result.response.body.getReader();
      const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(decoder.decode(value));
      }
      expect(chunks.join("")).not.toContain("keep-alive");
      await vi.advanceTimersByTimeAsync(0);
      expect(onRequestSuccess).toHaveBeenCalledTimes(1);
    });

    it("keeps the client connection alive during later idle gaps", async () => {
      const { upstream, run } = setup();
      const pending = run();
      upstream.push(event("a"));
      const result = await pending;

      const reader = result.response.body.getReader();
      const seen = await readUntil(reader, (text) => text.endsWith("\n\n"));
      expect(seen).toContain("\"content\":\"a\"");

      const idle = reader.read();
      await vi.advanceTimersByTimeAsync(SSE_KEEPALIVE.INTERVAL_MS);
      expect(decoder.decode((await idle).value)).toBe(SSE_KEEPALIVE.COMMENT);
      await reader.cancel();
    });
  });
});
