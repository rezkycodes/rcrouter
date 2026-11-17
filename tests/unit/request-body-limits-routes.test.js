import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Routes that wrap handleChat (compact, Ollama, Gemini) must bound the socket read exactly
// once at the route and hand handleChat a ready body: no clone()/tee, no unbounded read.
const { handleChatMock } = vi.hoisted(() => ({ handleChatMock: vi.fn() }));
vi.mock("@/sse/handlers/chat.js", () => ({ handleChat: handleChatMock }));
vi.mock("@/lib/localDb", () => ({ getSettings: vi.fn(async () => ({ requireApiKey: false })) }));

const { POST: compactPost } = await import("../../src/app/api/v1/responses/compact/route.js");
const { POST: ollamaPost } = await import("../../src/app/api/v1/api/chat/route.js");
const { POST: geminiPost } = await import("../../src/app/api/v1beta/models/[...path]/route.js");

const JSON_LIMIT = 512;

beforeEach(() => {
  process.env.MAX_REQUEST_BODY_BYTES = String(JSON_LIMIT);
  handleChatMock.mockReset();
  handleChatMock.mockImplementation(async (request) => new Response(
    JSON.stringify({ seen: await request.json() }),
    { headers: { "content-type": "application/json" } },
  ));
});

afterEach(() => {
  delete process.env.MAX_REQUEST_BODY_BYTES;
});

const post = (path, payload) => new Request(`https://rc.local${path}`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: typeof payload === "string" ? payload : JSON.stringify(payload),
});

const big = { model: "m", pad: "p".repeat(JSON_LIMIT * 2) };

async function expect413(response) {
  expect(response.status).toBe(413);
  expect((await response.json()).error.code).toBe("request_entity_too_large");
  expect(handleChatMock).not.toHaveBeenCalled();
}

describe("/v1/responses/compact", () => {
  it("rejects oversized bodies with 413 before handleChat", async () => {
    await expect413(await compactPost(post("/v1/responses/compact", big)));
  });

  it("tags the body for handleChat and keeps every original field", async () => {
    const response = await compactPost(post("/v1/responses/compact", { model: "m", input: "héllo" }));
    const { seen } = await response.json();
    expect(seen).toEqual({ model: "m", input: "héllo", _compact: true });
  });

  it("keeps answering malformed JSON with 400", async () => {
    const response = await compactPost(post("/v1/responses/compact", "{nope"));
    expect(response.status).toBe(400);
    expect(handleChatMock).not.toHaveBeenCalled();
  });
});

describe("/v1/api/chat (Ollama)", () => {
  it("rejects oversized bodies with 413 before handleChat", async () => {
    await expect413(await ollamaPost(post("/v1/api/chat", big)));
  });

  it("passes the original bytes through to handleChat (no clone, no re-serialization drift)", async () => {
    const raw = '{ "model" : "llama3.2" ,  "messages":[{"role":"user","content":"héllo"}] }';
    let forwardedText = null;
    handleChatMock.mockImplementation(async (request) => {
      forwardedText = await request.text();
      return new Response(JSON.stringify({ choices: [] }), { headers: { "content-type": "application/json" } });
    });
    const response = await ollamaPost(post("/v1/api/chat", raw));
    expect(response.status).toBe(200);
    expect(forwardedText).toBe(raw);
    const request = handleChatMock.mock.calls[0][0];
    expect(request.method).toBe("POST");
    expect(request.url).toBe("https://rc.local/v1/api/chat");
    expect(handleChatMock).toHaveBeenCalledTimes(1);
  });

  it("still hands a body whose model it cannot read to handleChat (which owns the 400)", async () => {
    let forwardedText = null;
    handleChatMock.mockImplementation(async (request) => {
      forwardedText = await request.text();
      return new Response(JSON.stringify({ error: { message: "Invalid JSON body" } }), { status: 400 });
    });
    await ollamaPost(post("/v1/api/chat", "{nope"));
    expect(handleChatMock).toHaveBeenCalledTimes(1);
    expect(forwardedText).toBe("{nope");
  });
});

describe("/v1beta/models/*:generateContent", () => {
  const params = { params: Promise.resolve({ path: ["gemini-2.5-pro:generateContent"] }) };

  it("rejects oversized bodies with 413 before handleChat", async () => {
    const response = await geminiPost(post("/v1beta/models/gemini-2.5-pro:generateContent", {
      contents: [{ role: "user", parts: [{ text: "x".repeat(JSON_LIMIT * 2) }] }],
    }), params);
    await expect413(response);
  });
});
