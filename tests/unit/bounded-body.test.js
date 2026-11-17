import { afterEach, describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_JSON_BODY_BYTES,
  DEFAULT_MAX_UPLOAD_BODY_BYTES,
  cloneRequestWithJson,
  readBoundedBuffer,
  readBoundedFormData,
  readBoundedJson,
  readBoundedText,
  resolveBodyLimit,
} from "../../src/sse/utils/boundedBody.js";

const MIB = 1024 * 1024;
const encoder = new TextEncoder();

afterEach(() => {
  delete process.env.MAX_REQUEST_BODY_BYTES;
  delete process.env.MAX_UPLOAD_BODY_BYTES;
});

function jsonRequest(payload, headers = {}) {
  return new Request("https://rc.local/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

/** Request-like stub whose body yields `chunks` lazily and records how many were pulled. */
function streamingRequest({ chunks, declaredLength, infiniteChunk = null, contentType = "application/json" }) {
  const stats = { pulled: 0, cancelled: false };
  let index = 0;
  const body = new ReadableStream({
    pull(controller) {
      stats.pulled += 1;
      if (infiniteChunk) {
        controller.enqueue(infiniteChunk);
        return;
      }
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index++]);
    },
    cancel() {
      stats.cancelled = true;
    },
  }, { highWaterMark: 0 });
  const headers = new Headers({ "content-type": contentType });
  if (declaredLength !== undefined) headers.set("content-length", String(declaredLength));
  return { request: { headers, body, url: "https://rc.local/v1/x" }, stats };
}

async function expectTooLarge(response, limit) {
  expect(response.status).toBe(413);
  expect(response.headers.get("content-type")).toBe("application/json");
  const json = await response.json();
  expect(json.error.code).toBe("request_entity_too_large");
  expect(json.error.type).toBe("invalid_request_error");
  expect(json.error.message).toContain(String(limit));
  expect(json.error.message).not.toMatch(/MAX_|env|secret|token|key/i);
  return json;
}

describe("resolveBodyLimit", () => {
  it("defaults to 64 MiB for JSON and 128 MiB for uploads (never above next.config's 128mb)", () => {
    expect(DEFAULT_MAX_JSON_BODY_BYTES).toBe(64 * MIB);
    expect(DEFAULT_MAX_UPLOAD_BODY_BYTES).toBe(128 * MIB);
    expect(resolveBodyLimit("json", {})).toBe(64 * MIB);
    expect(resolveBodyLimit("upload", {})).toBe(128 * MIB);
    expect(resolveBodyLimit(undefined, {})).toBe(64 * MIB);
    expect(resolveBodyLimit("nonsense", {})).toBe(64 * MIB);
  });

  it("reads MAX_REQUEST_BODY_BYTES and MAX_UPLOAD_BODY_BYTES independently", () => {
    const env = { MAX_REQUEST_BODY_BYTES: "1048576", MAX_UPLOAD_BODY_BYTES: " 2097152 " };
    expect(resolveBodyLimit("json", env)).toBe(1048576);
    expect(resolveBodyLimit("upload", env)).toBe(2097152);
    expect(resolveBodyLimit("json", { MAX_UPLOAD_BODY_BYTES: "10" })).toBe(64 * MIB);
  });

  it("falls back to the defaults for invalid env values", () => {
    for (const bad of ["", "   ", "abc", "-5", "0", "1e3", "12.5", "0x10", "10MB", "9007199254740993", "NaN", "Infinity"]) {
      expect(resolveBodyLimit("json", { MAX_REQUEST_BODY_BYTES: bad })).toBe(64 * MIB);
      expect(resolveBodyLimit("upload", { MAX_UPLOAD_BODY_BYTES: bad })).toBe(128 * MIB);
    }
  });

  it("reads process.env at call time by default", () => {
    process.env.MAX_REQUEST_BODY_BYTES = "321";
    expect(resolveBodyLimit("json")).toBe(321);
  });
});

describe("readBoundedJson", () => {
  it("parses a body under the limit and reports its byte size", async () => {
    const payload = { model: "gpt-4o", messages: [{ role: "user", content: "héllo 世界" }] };
    const result = await readBoundedJson(jsonRequest(payload));
    expect(result.error).toBeUndefined();
    expect(result.body).toEqual(payload);
    expect(result.bytes).toBe(encoder.encode(JSON.stringify(payload)).byteLength);
  });

  it("accepts a body exactly at the limit and rejects one byte over", async () => {
    const text = JSON.stringify({ a: "x".repeat(40) });
    const size = encoder.encode(text).byteLength;
    const ok = await readBoundedJson(jsonRequest(text), { limit: size });
    expect(ok.body).toEqual(JSON.parse(text));
    const over = await readBoundedJson(jsonRequest(text), { limit: size - 1 });
    await expectTooLarge(over.error, size - 1);
  });

  it("returns 400 'Invalid JSON body' for malformed or empty bodies", async () => {
    for (const bad of ["{not json", ""]) {
      const result = await readBoundedJson(jsonRequest(bad));
      expect(result.error.status).toBe(400);
      expect((await result.error.json()).error.message).toBe("Invalid JSON body");
    }
    const noBody = await readBoundedJson(new Request("https://rc.local/x", { method: "POST" }));
    expect(noBody.error.status).toBe(400);
  });

  it("rejects an over-limit Content-Length with 413 without reading the body", async () => {
    const { request, stats } = streamingRequest({ chunks: [encoder.encode("{}")], declaredLength: 10_000 });
    const result = await readBoundedJson(request, { limit: 1_000 });
    await expectTooLarge(result.error, 1_000);
    expect(stats.pulled).toBe(0);
    expect(stats.cancelled).toBe(true);
  });

  it("enforces the limit on chunked / unknown-length bodies and stops reading early", async () => {
    const { request, stats } = streamingRequest({ infiniteChunk: encoder.encode("x".repeat(100)) });
    const result = await readBoundedJson(request, { limit: 1_000 });
    await expectTooLarge(result.error, 1_000);
    // 1000-byte limit / 100-byte chunks: the 11th chunk trips it; never an unbounded read.
    expect(stats.pulled).toBeLessThanOrEqual(15);
    expect(stats.cancelled).toBe(true);
  });

  it("catches a lying Content-Length with the counted read", async () => {
    const chunks = [encoder.encode('{"a":"'), encoder.encode("y".repeat(500)), encoder.encode('"}')];
    const { request } = streamingRequest({ chunks, declaredLength: 10 });
    const result = await readBoundedJson(request, { limit: 200 });
    await expectTooLarge(result.error, 200);
  });

  it("uses MAX_REQUEST_BODY_BYTES from the environment when no explicit limit is given", async () => {
    process.env.MAX_REQUEST_BODY_BYTES = "64";
    const result = await readBoundedJson(jsonRequest({ pad: "z".repeat(200) }));
    await expectTooLarge(result.error, 64);
    process.env.MAX_REQUEST_BODY_BYTES = "not-a-number";
    const ok = await readBoundedJson(jsonRequest({ pad: "z".repeat(200) }));
    expect(ok.body.pad).toHaveLength(200);
  });

  it("ignores an invalid explicit limit and uses the configured one", async () => {
    process.env.MAX_REQUEST_BODY_BYTES = "64";
    for (const bad of [0, -1, 1.5, NaN, "9", null]) {
      const result = await readBoundedJson(jsonRequest({ pad: "z".repeat(200) }), { limit: bad });
      expect(result.error?.status).toBe(413);
    }
  });
});

describe("cloneRequestWithJson", () => {
  it("keeps url and headers, drops the stale Content-Length and carries the new JSON body", async () => {
    const original = new Request("https://rc.local/v1/responses/compact?x=1", {
      method: "POST",
      headers: { "content-type": "application/json", "x-trace": "abc", "content-length": "9999" },
      body: "{}",
    });
    const copy = cloneRequestWithJson(original, { a: 1, nested: { b: "é" } });
    expect(copy.url).toBe("https://rc.local/v1/responses/compact?x=1");
    expect(copy.method).toBe("POST");
    expect(copy.headers.get("x-trace")).toBe("abc");
    expect(copy.headers.get("content-type")).toBe("application/json");
    expect(copy.headers.get("content-length")).toBeNull();
    expect(await copy.json()).toEqual({ a: 1, nested: { b: "é" } });
    expect(original.headers.get("content-length")).toBe("9999");
  });
});

describe("readBoundedText / readBoundedBuffer", () => {
  it("return the exact text / bytes under the limit", async () => {
    const text = await readBoundedText(jsonRequest("hello wörld"));
    expect(text.text).toBe("hello wörld");

    const bytes = Uint8Array.from([0, 1, 2, 250, 251, 252]);
    const request = new Request("https://rc.local/x", { method: "POST", body: bytes });
    const buffer = await readBoundedBuffer(request);
    expect(Buffer.isBuffer(buffer.buffer)).toBe(true);
    expect([...buffer.buffer]).toEqual([...bytes]);
    expect(buffer.bytes).toBe(6);
  });

  it("text uses the JSON limit, buffer uses the upload limit", async () => {
    process.env.MAX_REQUEST_BODY_BYTES = "8";
    process.env.MAX_UPLOAD_BODY_BYTES = "1000";
    const big = "q".repeat(100);
    expect((await readBoundedText(jsonRequest(big))).error.status).toBe(413);
    const request = new Request("https://rc.local/x", { method: "POST", body: big });
    expect((await readBoundedBuffer(request)).buffer.byteLength).toBe(100);
    process.env.MAX_UPLOAD_BODY_BYTES = "50";
    const request2 = new Request("https://rc.local/x", { method: "POST", body: big });
    await expectTooLarge((await readBoundedBuffer(request2)).error, 50);
  });
});

// Encode through Response first: a Request built directly from FormData has an
// iterator-backed body that undici keeps pumping after a cancel, which is a test
// artifact and not how a socket-backed server request behaves.
async function multipartRequest(fileBytes, { fieldModel = "whisper-1" } = {}) {
  const form = new FormData();
  form.set("model", fieldModel);
  form.set("file", new File([fileBytes], "clip.wav", { type: "audio/wav" }));
  const encoded = new Response(form);
  return new Request("https://rc.local/v1/audio/transcriptions", {
    method: "POST",
    headers: { "content-type": encoded.headers.get("content-type") },
    body: await encoded.arrayBuffer(),
  });
}

describe("readBoundedFormData (multipart uploads)", () => {
  it("parses multipart bodies under the upload limit", async () => {
    const result = await readBoundedFormData(await multipartRequest(new Uint8Array(2048).fill(7)));
    expect(result.error).toBeUndefined();
    expect(result.formData.get("model")).toBe("whisper-1");
    const file = result.formData.get("file");
    expect(file.name).toBe("clip.wav");
    expect(file.size).toBe(2048);
  });

  it("uses the (larger) upload limit, not the JSON limit", async () => {
    process.env.MAX_REQUEST_BODY_BYTES = "100";
    const result = await readBoundedFormData(await multipartRequest(new Uint8Array(4096)));
    expect(result.error).toBeUndefined();
    expect(result.formData.get("file").size).toBe(4096);
  });

  it("returns 413 when the multipart body exceeds the upload limit (counted read)", async () => {
    process.env.MAX_UPLOAD_BODY_BYTES = "1024";
    const result = await readBoundedFormData(await multipartRequest(new Uint8Array(8192)));
    await expectTooLarge(result.error, 1024);
  });

  it("returns 413 from Content-Length alone, without reading", async () => {
    const { request, stats } = streamingRequest({
      chunks: [encoder.encode("--x--")],
      declaredLength: 5_000,
      contentType: "multipart/form-data; boundary=x",
    });
    const result = await readBoundedFormData(request, { limit: 1_000 });
    await expectTooLarge(result.error, 1_000);
    expect(stats.pulled).toBe(0);
  });

  it("returns 400 for a malformed multipart body", async () => {
    const request = new Request("https://rc.local/v1/audio/transcriptions", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=zzz" },
      body: "this is not multipart",
    });
    const result = await readBoundedFormData(request);
    expect(result.error.status).toBe(400);
    expect((await result.error.json()).error.message).toBe("Invalid multipart form data");
  });
});
