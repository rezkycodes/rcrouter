// Stream readiness gate: wait (bounded) for the first upstream chunk before the
// streaming response is committed to the client, so a stalled upstream becomes
// a normal failure (account/combo fallback) instead of a response that hangs.
//
//   ready   first chunk arrived; `body` replays it, then the rest of the stream
//   empty   upstream closed without a byte; `body` is an empty closed stream
//           (kept as a success on purpose: that is what the pipe did before)
//   timeout nothing within timeoutMs; the upstream reader/body was cancelled
//   error   the read failed before the first chunk; the upstream was released

export const READINESS_STATE = Object.freeze({
  READY: "ready",
  EMPTY: "empty",
  TIMEOUT: "timeout",
  ERROR: "error",
});

const TIMED_OUT = Symbol("stream-readiness-timeout");

function emptyStream() {
  return new ReadableStream({ start(controller) { controller.close(); } });
}

// Replays the peeked chunk, then forwards the same reader. Pull-based, so the
// original backpressure behaviour is preserved (highWaterMark 1 holds the replay).
function resumeStream(firstChunk, reader) {
  return new ReadableStream({
    start(controller) { controller.enqueue(firstChunk); },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  }, { highWaterMark: 1 });
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

/**
 * @param {ReadableStream|null} body - upstream response body
 * @param {object} options
 * @param {number} options.timeoutMs - max wait for the first chunk
 * @returns {Promise<{state: string, body?: ReadableStream|null, error?: Error}>}
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
    if (outcome === TIMED_OUT) {
      abandon(reader, firstRead, new Error(`no upstream data within ${timeoutMs}ms`));
      return { state: READINESS_STATE.TIMEOUT };
    }
    if (outcome.done) return { state: READINESS_STATE.EMPTY, body: emptyStream() };
    return { state: READINESS_STATE.READY, body: resumeStream(outcome.value, reader) };
  } catch (error) {
    abandon(reader, firstRead, error);
    return { state: READINESS_STATE.ERROR, error };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Client-facing failure details for a readiness outcome (timeout / error).
 * @returns {{ status: number, message: string, detail: string, errorCode: string }}
 */
export function describeReadinessFailure(readiness, { timeoutMs }) {
  if (readiness.state === READINESS_STATE.TIMEOUT) {
    const detail = `no data from upstream within ${timeoutMs}ms (stream readiness timeout)`;
    return { status: 504, message: `[504]: ${detail}`, detail, errorCode: "STREAM_READINESS_TIMEOUT" };
  }
  const detail = `upstream stream failed before the first chunk: ${readiness.error?.message || "read error"}`;
  return { status: 502, message: `[502]: ${detail}`, detail, errorCode: "STREAM_READ_ERROR" };
}
