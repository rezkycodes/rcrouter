import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";

// Request-body ceiling for every /v1 entry point that reads a body.
//
// - Content-Length is checked first, so an announced oversize is rejected (413)
//   before a single byte is read off the socket.
// - Otherwise the body is consumed through a counting TransformStream, so a
//   chunked or lying sender is stopped (and its source cancelled) the moment it
//   crosses the limit, before JSON.parse / multipart parsing allocates anything.
// - The counted stream is handed straight to Response.json() / .text() /
//   .formData(): one pass, never a second copy of the raw bytes.
//
// Limits are configurable per deployment (read at call time, so tests and
// hot-reloaded env both work):
//   MAX_REQUEST_BODY_BYTES  JSON / text bodies      (default 64 MiB)
//   MAX_UPLOAD_BODY_BYTES   multipart / binary bodies (default 128 MiB, which
//                           is also next.config.mjs proxyClientMaxBodySize)
// Invalid values (non-numeric, zero, negative, fractional, unsafe) fall back
// to the defaults.

const MIB = 1024 * 1024;

export const DEFAULT_MAX_JSON_BODY_BYTES = 64 * MIB;
export const DEFAULT_MAX_UPLOAD_BODY_BYTES = 128 * MIB;

const BODY_KINDS = Object.freeze({
  json: { env: "MAX_REQUEST_BODY_BYTES", fallback: DEFAULT_MAX_JSON_BODY_BYTES },
  upload: { env: "MAX_UPLOAD_BODY_BYTES", fallback: DEFAULT_MAX_UPLOAD_BODY_BYTES },
});

const DIGITS_ONLY = /^\d+$/;

function parsePositiveInteger(value) {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !DIGITS_ONLY.test(text.trim())) return null;
  const parsed = Number(text.trim());
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Resolve the byte ceiling for a body kind from the environment.
 * @param {"json"|"upload"} [kind="json"]
 * @param {Record<string, string|undefined>} [env=process.env]
 * @returns {number}
 */
export function resolveBodyLimit(kind = "json", env = process.env) {
  const spec = BODY_KINDS[kind] || BODY_KINDS.json;
  return parsePositiveInteger(env?.[spec.env]) ?? spec.fallback;
}

function limitFor(kind, options) {
  const explicit = typeof options?.limit === "number" ? parsePositiveInteger(options.limit) : null;
  return explicit ?? resolveBodyLimit(kind);
}

function tooLarge(max) {
  return errorResponse(HTTP_STATUS.PAYLOAD_TOO_LARGE, `Request body too large (limit ${max} bytes)`);
}

function declaredLength(request) {
  const raw = request.headers?.get?.("content-length");
  return typeof raw === "string" && DIGITS_ONLY.test(raw.trim()) ? Number(raw.trim()) : null;
}

async function discardBody(request) {
  try {
    await request.body?.cancel();
  } catch {
    // Body already locked or closed: nothing left to release.
  }
}

/** Pass-through stream that errors out once more than `max` bytes went through. */
function createByteLimiter(max) {
  let bytes = 0;
  let exceeded = false;
  const stream = new TransformStream({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      if (bytes > max) {
        exceeded = true;
        controller.error(new Error("request body exceeds limit"));
        return;
      }
      controller.enqueue(chunk);
    },
  });
  return { stream, bytes: () => bytes, exceeded: () => exceeded };
}

/**
 * Consume `request.body` once through `read(response)` under a byte ceiling.
 * @returns {Promise<{tooLarge: true} | {failure: Error} | {value: *, bytes: number}>}
 */
async function readBounded(request, max, read) {
  const declared = declaredLength(request);
  if (declared !== null && declared > max) {
    await discardBody(request);
    return { tooLarge: true };
  }

  const limiter = createByteLimiter(max);
  const readable = request.body ? request.body.pipeThrough(limiter.stream) : null;
  const contentType = request.headers?.get?.("content-type");
  const response = new Response(readable, contentType ? { headers: { "content-type": contentType } } : undefined);
  try {
    const value = await read(response);
    return { value, bytes: limiter.bytes() };
  } catch (failure) {
    return limiter.exceeded() ? { tooLarge: true } : { failure };
  }
}

async function readAs(kind, request, options, read, invalidMessage) {
  const max = limitFor(kind, options);
  const outcome = await readBounded(request, max, read);
  if (outcome.tooLarge) return { error: tooLarge(max) };
  if (outcome.failure) return { error: errorResponse(HTTP_STATUS.BAD_REQUEST, invalidMessage) };
  return { value: outcome.value, bytes: outcome.bytes };
}

/**
 * Build the follow-up POST Request routes hand to handleChat after translating or
 * tagging an already-bounded body. Drops Content-Length: it described the original
 * body, not this one.
 * @param {Request} request - the original request (url + headers are reused)
 * @param {*} body - JSON-serializable replacement body
 * @returns {Request}
 */
export function cloneRequestWithJson(request, body) {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request.url, { method: "POST", headers, body: JSON.stringify(body) });
}

/**
 * Read and parse a JSON request body under the JSON ceiling.
 * @param {Request} request
 * @param {{limit?: number}} [options] explicit ceiling (bytes); defaults to MAX_REQUEST_BODY_BYTES
 * @returns {Promise<{body: *, bytes: number} | {error: Response}>}
 */
export async function readBoundedJson(request, options) {
  const result = await readAs("json", request, options, (r) => r.json(), "Invalid JSON body");
  return result.error ? { error: result.error } : { body: result.value, bytes: result.bytes };
}

/**
 * Read a text body under the JSON ceiling (callers that must keep the raw text).
 * @returns {Promise<{text: string, bytes: number} | {error: Response}>}
 */
export async function readBoundedText(request, options) {
  const result = await readAs("json", request, options, (r) => r.text(), "Invalid request body");
  return result.error ? { error: result.error } : { text: result.value, bytes: result.bytes };
}

/**
 * Read a binary body (byte-preserving) under the upload ceiling.
 * @returns {Promise<{buffer: Buffer, bytes: number} | {error: Response}>}
 */
export async function readBoundedBuffer(request, options) {
  const result = await readAs(
    "upload", request, options, async (r) => Buffer.from(await r.arrayBuffer()), "Invalid request body",
  );
  return result.error ? { error: result.error } : { buffer: result.value, bytes: result.bytes };
}

/**
 * Parse a multipart/form-data body under the upload ceiling.
 * @returns {Promise<{formData: FormData, bytes: number} | {error: Response}>}
 */
export async function readBoundedFormData(request, options) {
  const result = await readAs("upload", request, options, (r) => r.formData(), "Invalid multipart form data");
  return result.error ? { error: result.error } : { formData: result.value, bytes: result.bytes };
}
