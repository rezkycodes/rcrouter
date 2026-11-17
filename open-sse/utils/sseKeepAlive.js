// SSE keep-alive: emit a comment line (": keep-alive\n\n") whenever the client
// has seen no bytes for a while, so edge proxies (Cloudflare 520/524, nginx
// read timeouts) do not cut a response whose upstream is slow to prefill or is
// silently thinking.
//
// Protocol safety:
//   - an SSE comment is ignored by compliant parsers (OpenAI / Anthropic /
//     Responses SDKs, EventSource);
//   - it is only emitted at an event boundary (output ends with a blank line,
//     or nothing was sent yet): a blank line inside an event would dispatch it
//     early and corrupt `event:`/`data:` pairing;
//   - it stops on end/abort/error/cancel and never keeps the process alive
//     (unref'd timer).
//
// The helper is transport-agnostic: the owner supplies `emit(bytes)`.

import { SSE_KEEPALIVE } from "../config/resilienceConfig.js";

const COMMENT_BYTES = new TextEncoder().encode(SSE_KEEPALIVE.COMMENT);
const TAIL_LENGTH = 4;
const BOUNDARY_PATTERN = /\n\r?\n$/;

/** True when `tail` (last few output chars) ends an event, or nothing was sent yet. */
export function endsAtEventBoundary(tail) {
  return tail === "" || BOUNDARY_PATTERN.test(tail);
}

function lastChars(chunk) {
  if (typeof chunk === "string") return chunk.slice(-TAIL_LENGTH);
  if (chunk && typeof chunk.byteLength === "number") {
    const bytes = ArrayBuffer.isView(chunk)
      ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      : new Uint8Array(chunk);
    return String.fromCharCode(...bytes.subarray(Math.max(0, bytes.length - TAIL_LENGTH)));
  }
  return "";
}

function nextTail(previous, chunk) {
  const piece = lastChars(chunk);
  return piece === "" ? previous : (previous + piece).slice(-TAIL_LENGTH);
}

/**
 * @param {object} options
 * @param {(bytes: Uint8Array) => boolean|void} options.emit - deliver bytes to the client;
 *   return false when the consumer is backed up (the beat is skipped), throw if it is gone
 * @param {() => boolean} [options.isActive] - false once the response is over
 * @param {number} [options.intervalMs]
 * @param {() => number} [options.now]
 * @returns {{ start(): void, noteOutput(chunk: Uint8Array|string): void, stop(): void }}
 */
export function createSseKeepAlive({
  emit,
  isActive = () => true,
  intervalMs = SSE_KEEPALIVE.INTERVAL_MS,
  now = Date.now,
}) {
  let timer = null;
  let stopped = false;
  let lastOutputAt = now();
  let tail = "";

  function schedule(delayMs) {
    timer = setTimeout(tick, delayMs);
    timer.unref?.();
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function beat() {
    try {
      if (emit(COMMENT_BYTES.slice()) !== false) lastOutputAt = now();
    } catch {
      // Consumer already closed or cancelled: nothing left to keep alive.
      stop();
    }
  }

  function tick() {
    timer = null;
    if (stopped) return;
    if (!isActive()) return stop();

    const idleMs = now() - lastOutputAt;
    if (idleMs < intervalMs) return schedule(intervalMs - idleMs);
    if (!endsAtEventBoundary(tail)) return schedule(SSE_KEEPALIVE.BOUNDARY_RETRY_MS);

    beat();
    if (!stopped) schedule(intervalMs);
  }

  return {
    start() {
      if (stopped || timer) return;
      lastOutputAt = now();
      schedule(intervalMs);
    },
    noteOutput(chunk) {
      lastOutputAt = now();
      tail = nextTail(tail, chunk);
    },
    stop,
  };
}
