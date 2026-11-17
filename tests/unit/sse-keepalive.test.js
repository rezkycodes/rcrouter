import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSseKeepAlive, endsAtEventBoundary } from "../../open-sse/utils/sseKeepAlive.js";
import { createDisconnectAwareStream } from "../../open-sse/utils/streamHandler.js";
import { SSE_KEEPALIVE } from "../../open-sse/config/resilienceConfig.js";

const INTERVAL = SSE_KEEPALIVE.INTERVAL_MS;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

describe("endsAtEventBoundary", () => {
  it("is true before any output and after a blank line", () => {
    expect(endsAtEventBoundary("")).toBe(true);
    expect(endsAtEventBoundary("}\n\n")).toBe(true);
    expect(endsAtEventBoundary("}\r\n\r\n")).toBe(true);
    expect(endsAtEventBoundary("\n\r\n")).toBe(true);
  });

  it("is false inside an event", () => {
    expect(endsAtEventBoundary("event: ping\n")).toBe(false);
    expect(endsAtEventBoundary("data: {\"a\":1}")).toBe(false);
    expect(endsAtEventBoundary("data: x\r\n")).toBe(false);
  });
});

describe("createSseKeepAlive", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(overrides = {}) {
    const emitted = [];
    const keepAlive = createSseKeepAlive({
      emit: (bytes) => { emitted.push(decoder.decode(bytes)); return true; },
      ...overrides,
    });
    return { keepAlive, emitted };
  }

  it("emits an SSE comment every 15s while nothing else is sent", async () => {
    const { keepAlive, emitted } = setup();
    keepAlive.start();

    await vi.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(emitted).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(emitted).toEqual([": keep-alive\n\n"]);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(emitted).toHaveLength(2);
    keepAlive.stop();
  });

  it("measures idleness from the last real output, not from a fixed grid", async () => {
    const { keepAlive, emitted } = setup();
    keepAlive.start();

    await vi.advanceTimersByTimeAsync(10_000);
    keepAlive.noteOutput("data: {}\n\n");
    await vi.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(emitted).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(emitted).toHaveLength(1);
    keepAlive.stop();
  });

  it("never injects inside a partially written event, then resumes at the boundary", async () => {
    const { keepAlive, emitted } = setup();
    keepAlive.start();

    keepAlive.noteOutput("event: message_start\n");
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(emitted).toEqual([]);

    keepAlive.noteOutput("data: {\"type\":\"message_start\"}\n\n");
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(emitted).toEqual([": keep-alive\n\n"]);
    keepAlive.stop();
  });

  it("tracks the boundary across chunk edges and for byte chunks", async () => {
    const { keepAlive, emitted } = setup();
    keepAlive.start();

    keepAlive.noteOutput(encoder.encode("data: {}\n"));
    keepAlive.noteOutput(encoder.encode("\n"));
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(emitted).toHaveLength(1);
    keepAlive.stop();
  });

  it("stops cleanly: no timer left and nothing emitted afterwards", async () => {
    const { keepAlive, emitted } = setup();
    keepAlive.start();
    keepAlive.stop();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(INTERVAL * 4);
    expect(emitted).toEqual([]);
    keepAlive.stop(); // idempotent
  });

  it("stops by itself once the stream is no longer active", async () => {
    let active = true;
    const { keepAlive, emitted } = setup({ isActive: () => active });
    keepAlive.start();
    active = false;

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(emitted).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops when the consumer is gone (emit throws) instead of crashing", async () => {
    const emit = vi.fn(() => { throw new TypeError("Invalid state: Controller is already closed"); });
    const keepAlive = createSseKeepAlive({ emit });
    keepAlive.start();

    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps ticking, without counting a skipped beat as output, when the consumer is backed up", async () => {
    const results = [false, true];
    const emit = vi.fn(() => results.shift());
    const keepAlive = createSseKeepAlive({ emit });
    keepAlive.start();

    await vi.advanceTimersByTimeAsync(INTERVAL);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(emit).toHaveBeenCalledTimes(2);
    keepAlive.stop();
  });

  it("does not keep the process alive (unref'd timer)", () => {
    vi.useRealTimers();
    const spy = vi.spyOn(globalThis, "setTimeout");
    try {
      const keepAlive = createSseKeepAlive({ emit: () => true });
      keepAlive.start();
      const timer = spy.mock.results[0].value;
      expect(typeof timer.hasRef === "function" ? timer.hasRef() : false).toBe(false);
      keepAlive.stop();
    } finally {
      spy.mockRestore();
    }
  });
});

function fakeStreamController() {
  const state = { connected: true, completed: 0, errors: [], disconnects: [] };
  return {
    state,
    signal: new AbortController().signal,
    isConnected: () => state.connected,
    handleComplete: () => { state.connected = false; state.completed += 1; },
    handleError: (error) => { state.connected = false; state.errors.push(error); },
    handleDisconnect: (reason) => { state.connected = false; state.disconnects.push(reason); },
    abort: () => {},
  };
}

// Same shape pipeWithDisconnect hands over: a readable plus a stub writable.
function upstreamPair() {
  const source = new TransformStream();
  const stub = { readable: source.readable, writable: { getWriter: () => ({ abort: () => Promise.resolve() }) } };
  return { writer: source.writable.getWriter(), stub };
}

function openPipe({ keepAliveMs = INTERVAL, onAbortTerminal = null } = {}) {
  const { writer, stub } = upstreamPair();
  const controller = fakeStreamController();
  const output = createDisconnectAwareStream(stub, controller, onAbortTerminal, { keepAliveMs });
  return { writer, controller, reader: output.getReader() };
}

async function readText(reader) {
  const { done, value } = await reader.read();
  return done ? null : decoder.decode(value);
}

describe("createDisconnectAwareStream keep-alive", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("covers a long time-to-first-byte with keep-alive comments", async () => {
    const { reader, writer } = openPipe();

    const first = readText(reader);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(await first).toBe(": keep-alive\n\n");

    const second = readText(reader);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(await second).toBe(": keep-alive\n\n");

    // Real data still flows in order afterwards.
    const data = readText(reader);
    await writer.write(encoder.encode("data: {\"ok\":true}\n\n"));
    expect(await data).toBe("data: {\"ok\":true}\n\n");
    await reader.cancel();
  });

  it("covers idle gaps in the middle of a stream", async () => {
    const { reader, writer } = openPipe();

    const chunk = readText(reader);
    await writer.write(encoder.encode("data: {\"n\":1}\n\n"));
    expect(await chunk).toBe("data: {\"n\":1}\n\n");

    const idle = readText(reader);
    await vi.advanceTimersByTimeAsync(INTERVAL);
    expect(await idle).toBe(": keep-alive\n\n");
    await reader.cancel();
  });

  it("does not inject into a half-written event", async () => {
    const { reader, writer } = openPipe();

    const part = readText(reader);
    await writer.write(encoder.encode("event: content_block_delta\n"));
    expect(await part).toBe("event: content_block_delta\n");

    const next = readText(reader);
    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    await writer.write(encoder.encode("data: {\"d\":1}\n\n"));
    expect(await next).toBe("data: {\"d\":1}\n\n");
    await reader.cancel();
  });

  it("emits nothing after the stream ends and leaves no timer behind", async () => {
    const { reader, writer } = openPipe();

    const chunk = readText(reader);
    await writer.write(encoder.encode("data: [DONE]\n\n"));
    expect(await chunk).toBe("data: [DONE]\n\n");

    const end = reader.read();
    await writer.close();
    expect((await end).done).toBe(true);

    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops when the client cancels the response", async () => {
    const { reader, controller } = openPipe();
    await reader.cancel("client closed");

    expect(controller.state.disconnects).toEqual(["client closed"]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(INTERVAL * 5);
  });

  it("stops when the stream errors", async () => {
    const { reader, writer, controller } = openPipe({ onAbortTerminal: () => encoder.encode("data: [DONE]\n\n") });

    const pending = readText(reader);
    await writer.abort(new Error("upstream reset"));
    await pending;

    expect(controller.state.errors.length).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops after a client disconnect flagged on the controller", async () => {
    const { reader, controller } = openPipe();

    const pending = reader.read();
    controller.state.connected = false;
    await vi.advanceTimersByTimeAsync(INTERVAL);
    await reader.cancel();
    await pending.catch(() => {});
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is off unless asked for (existing callers keep byte-identical output)", async () => {
    const { stub } = upstreamPair();
    const controller = fakeStreamController();
    const output = createDisconnectAwareStream(stub, controller, null);
    const reader = output.getReader();
    const idle = reader.read();

    await vi.advanceTimersByTimeAsync(INTERVAL * 4);
    expect(vi.getTimerCount()).toBe(0);
    await reader.cancel();
    await idle.catch(() => {});
  });
});

// Minimal WHATWG SSE parser: comment lines (": ...") are ignored, a blank line dispatches.
function parseSse(text) {
  const events = [];
  let current = { event: "message", data: [] };
  for (const line of text.split(/\r\n|\n/)) {
    if (line === "") {
      if (current.data.length > 0) events.push({ event: current.event, data: current.data.join("\n") });
      current = { event: "message", data: [] };
    } else if (line.startsWith(":")) {
      continue;
    } else if (line.startsWith("event:")) {
      current.event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      current.data.push(line.slice(5).trim());
    }
  }
  return events;
}

describe("keep-alive is protocol-safe for every client format", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const FORMATS = {
    "OpenAI chat": [
      "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\"}}]}\n\n",
      "data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\n",
      "data: [DONE]\n\n",
    ],
    "Claude messages": [
      "event: message_start\ndata: {\"type\":\"message_start\"}\n\n",
      "event: content_block_delta\ndata: {\"type\":\"content_block_delta\"}\n\n",
      "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n",
    ],
    "OpenAI Responses": [
      "event: response.created\ndata: {\"type\":\"response.created\"}\n\n",
      "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\"}\n\n",
      "event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n",
    ],
  };

  for (const [name, chunks] of Object.entries(FORMATS)) {
    it(`${name}: parsed events are identical with keep-alives between them`, async () => {
      const { reader, writer } = openPipe();
      let received = "";
      const drain = (async () => {
        let result = await reader.read();
        while (!result.done) {
          received += decoder.decode(result.value);
          result = await reader.read();
        }
      })();

      await vi.advanceTimersByTimeAsync(INTERVAL); // TTFB gap
      for (const chunk of chunks) {
        await writer.write(encoder.encode(chunk));
        await vi.advanceTimersByTimeAsync(INTERVAL); // idle gap between events
      }
      await writer.close();
      await drain;

      expect(received).toContain(": keep-alive\n\n");
      expect(parseSse(received)).toEqual(parseSse(chunks.join("")));
    });
  }
});
