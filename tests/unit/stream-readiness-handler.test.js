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

describe("handleStreamingResponse readiness gate", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("fails with 504 after 25s without a first chunk, cancelling the upstream", async () => {
    const { upstream, run, abort, handleError, onRequestSuccess } = setup();
    const pending = run();

    await vi.advanceTimersByTimeAsync(24_999);
    expect(abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(result.success).toBe(false);
    expect(result.status).toBe(504);
    expect(result.error).toContain("stream readiness timeout");
    expect(result.response.status).toBe(504);
    expect((await result.response.json()).error.message).toContain("stream readiness timeout");

    expect(upstream.cancel).toHaveBeenCalledTimes(1);
    expect(abort).toHaveBeenCalledTimes(1);
    expect(handleError).toHaveBeenCalledTimes(1);
    expect(onRequestSuccess).not.toHaveBeenCalled();
    expect(db.saveRequestDetail).not.toHaveBeenCalled();
    expect(db.appendRequestLog).toHaveBeenCalledWith(expect.objectContaining({ status: "FAILED 504", provider: "openai" }));
  });

  it("succeeds when the first chunk arrives in time and reports success only then", async () => {
    const { upstream, run, onRequestSuccess } = setup();
    const pending = run();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(onRequestSuccess).not.toHaveBeenCalled();
    upstream.push("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n");
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

  it("honours a configured readiness timeout and clamps tiny values to 1s", async () => {
    const configured = setup({ streamReadinessTimeoutMs: 5_000 });
    const pendingConfigured = configured.run();
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await pendingConfigured).status).toBe(504);

    const clamped = setup({ streamReadinessTimeoutMs: 10 });
    const pendingClamped = clamped.run();
    await vi.advanceTimersByTimeAsync(999);
    expect(clamped.abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await pendingClamped).status).toBe(504);
  });

  it("treats an upstream read error before the first chunk as a failure (502)", async () => {
    const { upstream, run, onRequestSuccess } = setup();
    const pending = run();
    upstream.fail(new Error("socket hang up"));
    const result = await pending;

    expect(result.success).toBe(false);
    expect(result.status).toBe(502);
    expect(onRequestSuccess).not.toHaveBeenCalled();
  });

  it("keeps an upstream that closes without a byte as a normal (empty) success", async () => {
    const { upstream, run } = setup();
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
  });

  it("keeps the client connection alive during later idle gaps", async () => {
    const { upstream, run } = setup();
    const pending = run();
    upstream.push("data: {\"choices\":[{\"delta\":{\"content\":\"a\"}}]}\n\n");
    const result = await pending;

    const reader = result.response.body.getReader();
    // Passthrough emits a line and its blank terminator as separate chunks.
    let seen = "";
    while (!seen.endsWith("\n\n")) seen += decoder.decode((await reader.read()).value);
    expect(seen).toContain("\"content\":\"a\"");

    const idle = reader.read();
    await vi.advanceTimersByTimeAsync(SSE_KEEPALIVE.INTERVAL_MS);
    expect(decoder.decode((await idle).value)).toBe(SSE_KEEPALIVE.COMMENT);
    await reader.cancel();
  });
});
