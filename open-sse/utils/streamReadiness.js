// Stream readiness peek: wait (bounded) for the first upstream chunk so a FAST
// failure becomes a normal failover, while a SLOW first chunk (big-context
// prefill, reasoning models that stay silent until the first token) is never
// cancelled. Mirrors VansRouter's peekStreamReadiness.
//
//   ready    first chunk arrived in time; `body` replays it, then the rest
//   empty    upstream closed without a byte; `body` is an empty closed stream
//            (kept as a success on purpose: that is what the pipe did before)
//   timeout  nothing within timeoutMs. NOT a failure: the in-flight read is
//            kept, so `body` delivers the first real chunk intact and in order
//            whenever it arrives. The caller commits the response now and the
//            SSE keep-alive covers the rest of the wait. `firstSettled`
//            resolves to SETTLED.DATA | END | ERROR | CANCELLED once that
//            read settles, so success is only reported after real data.
//   error    the read failed before the first chunk; the upstream was released
//
// timeoutMs is therefore the "commit headers + start heartbeat" threshold.

export const READINESS_STATE = Object.freeze({
  READY: "ready",
  EMPTY: "empty",
  TIMEOUT: "timeout",
  ERROR: "error",
});

export const SETTLED = Object.freeze({
  DATA: "data",
  END: "end",
  ERROR: "error",
  CANCELLED: "cancelled",
});

const TIMED_OUT = Symbol("stream-readiness-timeout");

function emptyStream() {
  return new ReadableStream({ start(controller) { controller.close(); } });
}

// Forwards `reader`, first replaying an already-read chunk (`firstChunk`) or
// awaiting the in-flight first read (`pendingRead`). Pull-based, so the original
// backpressure is preserved (highWaterMark 1 holds the replayed chunk).
function resumeStream(reader, { firstChunk, pendingRead = null }) {
  let cancelled = false;
  let pending = pendingRead;
  const body = new ReadableStream({
    start(controller) {
      if (firstChunk !== undefined) controller.enqueue(firstChunk);
    },
    async pull(controller) {
      try {
        const { done, value } = await (pending ?? reader.read());
        pending = null;
        if (cancelled) return;
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        if (!cancelled) controller.error(error);
      }
    },
    cancel(reason) {
      cancelled = true;
      return reader.cancel(reason);
    },
  }, { highWaterMark: 1 });
  return { body, wasCancelled: () => cancelled };
}

// Cancel without awaiting (the fallback path must not block on a slow socket)
// and without leaving an unhandled rejection behind.
function abandon(reader, pendingRead, reason) {
  pendingRead.catch(() => {});
  try {
    Promise.resolve(reader.cancel(reason)).catch(() => {});
  } catch {
    // Reader already released/errored: nothing left to cancel.
  }
}

function lateStream(reader, firstRead) {
  const { body, wasCancelled } = resumeStream(reader, { pendingRead: firstRead });
  const firstSettled = firstRead.then(
    (result) => {
      if (wasCancelled()) return SETTLED.CANCELLED;
      return result.done ? SETTLED.END : SETTLED.DATA;
    },
    () => SETTLED.ERROR,
  );
  return { state: READINESS_STATE.TIMEOUT, body, firstSettled };
}

/**
 * @param {ReadableStream|null} body - upstream response body
 * @param {object} options
 * @param {number} options.timeoutMs - how long to wait for the first chunk before committing anyway
 * @returns {Promise<{state: string, body?: ReadableStream|null, error?: Error, firstSettled?: Promise<string>}>}
 */
export async function awaitFirstChunk(body, { timeoutMs }) {
  if (!body || typeof body.getReader !== "function") {
    return { state: READINESS_STATE.READY, body };
  }
  const reader = body.getReader();
  const firstRead = reader.read();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
    timer.unref?.();
  });

  try {
    const outcome = await Promise.race([firstRead, timeout]);
    if (outcome === TIMED_OUT) return lateStream(reader, firstRead);
    if (outcome.done) return { state: READINESS_STATE.EMPTY, body: emptyStream() };
    const resumed = resumeStream(reader, { firstChunk: outcome.value });
    return { state: READINESS_STATE.READY, body: resumed.body };
  } catch (error) {
    abandon(reader, firstRead, error);
    return { state: READINESS_STATE.ERROR, error };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Client-facing details for a read error before the first chunk (fast failure).
 * @returns {{ status: number, message: string, detail: string, errorCode: string }}
 */
export function describeReadError(readiness) {
  const detail = `upstream stream failed before the first chunk: ${readiness.error?.message || "read error"}`;
  return { status: 502, message: `[502]: ${detail}`, detail, errorCode: "STREAM_READ_ERROR" };
}
