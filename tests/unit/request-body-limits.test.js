import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every handler reads its body before anything else it does. Settings (the first thing
// auth touches) are mocked to throw, so "reached auth" is observable and an oversized
// body that wrongly proceeds fails loudly instead of silently passing.
const { getSettingsMock } = vi.hoisted(() => ({ getSettingsMock: vi.fn() }));
vi.mock("@/lib/localDb", () => ({
  getSettings: getSettingsMock,
  getProviderConnectionById: vi.fn(async () => null),
}));

const { handleChat } = await import("../../src/sse/handlers/chat.js");
const { handleEmbeddings } = await import("../../src/sse/handlers/embeddings.js");
const { handleSearch } = await import("../../src/sse/handlers/search.js");
const { handleFetch } = await import("../../src/sse/handlers/fetch.js");
const { handleTts } = await import("../../src/sse/handlers/tts.js");
const { handleImageGeneration } = await import("../../src/sse/handlers/imageGeneration.js");
const { handleStt } = await import("../../src/sse/handlers/stt.js");
const { handleVideoCreate } = await import("../../src/sse/handlers/videoGeneration.js");
const { POST: countTokensPost } = await import("../../src/app/api/v1/messages/count_tokens/route.js");

const JSON_LIMIT = 256;
const UPLOAD_LIMIT = 2048;
const REACHED_AUTH = "reached auth";
const oversizedJson = JSON.stringify({ model: "x", input: "a".repeat(JSON_LIMIT * 4) });

beforeEach(() => {
  process.env.MAX_REQUEST_BODY_BYTES = String(JSON_LIMIT);
  process.env.MAX_UPLOAD_BODY_BYTES = String(UPLOAD_LIMIT);
  getSettingsMock.mockReset();
  getSettingsMock.mockRejectedValue(new Error(REACHED_AUTH));
});

afterEach(() => {
  delete process.env.MAX_REQUEST_BODY_BYTES;
  delete process.env.MAX_UPLOAD_BODY_BYTES;
});

const postJson = (path, text = oversizedJson, headers = {}) =>
  new Request(`https://rc.local${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: text,
  });

async function expect413(response, limit) {
  expect(response.status).toBe(413);
  const json = await response.json();
  expect(json.error.code).toBe("request_entity_too_large");
  expect(json.error.type).toBe("invalid_request_error");
  expect(json.error.message).toContain(String(limit));
}

const jsonEntryPoints = [
  ["POST /v1/chat/completions", handleChat, "/v1/chat/completions"],
  ["POST /v1/messages", handleChat, "/v1/messages"],
  ["POST /v1/responses", handleChat, "/v1/responses"],
  ["POST /v1/embeddings", handleEmbeddings, "/v1/embeddings"],
  ["POST /v1/search", handleSearch, "/v1/search"],
  ["POST /v1/web/fetch", handleFetch, "/v1/web/fetch"],
  ["POST /v1/audio/speech", handleTts, "/v1/audio/speech"],
  ["POST /v1/images/generations", handleImageGeneration, "/v1/images/generations"],
  ["POST /v1/messages/count_tokens", countTokensPost, "/v1/messages/count_tokens"],
];

describe("every /v1 JSON entry point enforces the body ceiling before parsing", () => {
  it.each(jsonEntryPoints)("%s -> 413 when the body is over the limit", async (_name, handler, path) => {
    await expect413(await handler(postJson(path)), JSON_LIMIT);
  });

  it.each(jsonEntryPoints)("%s -> 413 when Content-Length announces an oversize body", async (_name, handler, path) => {
    const announced = postJson(path, "{}", { "content-length": String(JSON_LIMIT * 10) });
    await expect413(await handler(announced), JSON_LIMIT);
  });

  it("POST /v1/videos/generations (JSON) -> 413 over the limit", async () => {
    getSettingsMock.mockResolvedValue({ requireApiKey: false });
    await expect413(await handleVideoCreate(postJson("/v1/videos/generations"), "generations"), JSON_LIMIT);
  });
});

describe("normal bodies keep their existing behavior", () => {
  it("count_tokens counts a small body", async () => {
    const small = JSON.stringify({ messages: [{ role: "user", content: "hi there" }] });
    const response = await countTokensPost(postJson("/v1/messages/count_tokens", small));
    expect(response.status).toBe(200);
    expect((await response.json()).input_tokens).toBe(2);
  });

  it("count_tokens still answers malformed JSON with 400", async () => {
    const response = await countTokensPost(postJson("/v1/messages/count_tokens", "{nope"));
    expect(response.status).toBe(400);
  });

  it("handleChat parses a small body and proceeds to auth; malformed JSON is still 400", async () => {
    await expect(handleChat(postJson("/v1/chat/completions", JSON.stringify({ model: "x" })))).rejects.toThrow(REACHED_AUTH);
    expect((await handleChat(postJson("/v1/chat/completions", "{nope"))).status).toBe(400);
  });

  it("embeddings / search / fetch / tts / images parse a small body and proceed", async () => {
    const small = JSON.stringify({ model: "x" });
    for (const [handler, path] of [
      [handleEmbeddings, "/v1/embeddings"], [handleSearch, "/v1/search"], [handleFetch, "/v1/web/fetch"],
      [handleTts, "/v1/audio/speech"], [handleImageGeneration, "/v1/images/generations"],
    ]) {
      let outcome;
      try { outcome = await handler(postJson(path, small)); } catch (err) { outcome = err; }
      const reachedLogic = outcome instanceof Error ? outcome.message === REACHED_AUTH : outcome.status !== 413;
      expect(reachedLogic).toBe(true);
    }
  });
});

describe("multipart / binary entry points use the upload ceiling", () => {
  async function multipart(size) {
    const form = new FormData();
    form.set("model", "whisper-1");
    form.set("file", new File([new Uint8Array(size)], "a.wav", { type: "audio/wav" }));
    const encoded = new Response(form);
    return new Request("https://rc.local/v1/audio/transcriptions", {
      method: "POST",
      headers: { "content-type": encoded.headers.get("content-type") },
      body: await encoded.arrayBuffer(),
    });
  }

  it("POST /v1/audio/transcriptions -> 413 above MAX_UPLOAD_BODY_BYTES", async () => {
    await expect413(await handleStt(await multipart(UPLOAD_LIMIT * 4)), UPLOAD_LIMIT);
  });

  it("POST /v1/audio/transcriptions is not capped by the smaller JSON limit", async () => {
    // Above the 256-byte JSON limit, under the 2 KiB upload limit: parsed, then the
    // handler proceeds to settings/auth (the mock turns that into a recognizable error).
    await expect(handleStt(await multipart(1000))).rejects.toThrow(REACHED_AUTH);
  });

  it("POST /v1/videos/edits (multipart) -> 413 above MAX_UPLOAD_BODY_BYTES, forwarded below it", async () => {
    getSettingsMock.mockResolvedValue({ requireApiKey: false });
    const big = new Request("https://rc.local/v1/videos/edits", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body: new Uint8Array(UPLOAD_LIMIT * 2),
    });
    await expect413(await handleVideoCreate(big, "edits"), UPLOAD_LIMIT);

    // Same content type, under the upload limit but over the JSON limit: accepted by the reader,
    // so the handler moves on to provider/credential resolution (which needs real DB state).
    const ok = new Request("https://rc.local/v1/videos/edits", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=x" },
      body: new Uint8Array(UPLOAD_LIMIT / 2),
    });
    let outcome;
    try { outcome = await handleVideoCreate(ok, "edits"); } catch (err) { outcome = err; }
    expect(outcome instanceof Response ? outcome.status : 0).not.toBe(413);
  });
});
