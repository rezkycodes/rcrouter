// `/v1/models` publishes combos as "combo/<name>"; the endpoints must accept that
// exact id (not only the bare name), and per-combo settings, rotation state and
// per-key access must all key on the bare name.
import { describe, it, expect, vi, beforeEach } from "vitest";

const fx = vi.hoisted(() => ({
  combos: [
    { id: "c1", name: "Main", models: ["openai/model-a", "openai/model-b"] },
    { id: "c2", name: "search-stack", models: ["tavily", "exa"] },
  ],
  keys: {},
  settings: {},
}));
const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  handleChatCore: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: async () => fx.settings,
  getModelAliases: async () => ({}),
  getComboByName: async (name) => fx.combos.find((c) => c.name === name) || null,
  getProviderNodes: async () => [],
  getCombos: async () => fx.combos,
  getProviderConnections: async () => [{ id: "cn1", provider: "openai", authType: "apikey", isActive: true, apiKey: "k" }],
  getProviderConnectionById: async () => null,
  getCustomModels: async () => [],
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: async () => ({}) }));
vi.mock("@/lib/db/repos/combosRepo.js", () => ({ getCombos: async () => fx.combos }));
vi.mock("@/lib/db/repos/apiKeysRepo.js", () => ({ getApiKeyByKey: async (k) => fx.keys[k] || null }));
vi.mock("@/lib/usageDb.js", () => ({ saveRequestUsage: vi.fn() }));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: vi.fn(async () => ({ shouldFallback: false })),
  clearAccountError: vi.fn(),
  extractApiKey: (request) => {
    const a = request.headers.get("Authorization");
    return a?.startsWith("Bearer ") ? a.slice(7) : request.headers.get("x-api-key");
  },
  isValidApiKey: async () => true,
  isProviderAllowed: async () => true,
  isComboAllowed: () => true,
  isKindAllowed: () => true,
  isTrustedInternalRequest: async () => false,
}));
vi.mock("@/sse/services/allowedModels.js", async (importOriginal) => ({
  ...(await importOriginal()),
  isModelAllowed: async () => true,
}));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  checkAndRefreshToken: async (_p, c) => c,
  updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));

const { handleChat } = await import("../../src/sse/handlers/chat.js");
const { handleSearch } = await import("../../src/sse/handlers/search.js");
const { handleFetch } = await import("../../src/sse/handlers/fetch.js");
const { handleTts } = await import("../../src/sse/handlers/tts.js");
const { handleImageGeneration } = await import("../../src/sse/handlers/imageGeneration.js");
const { getComboModels } = await import("../../src/sse/services/model.js");
const { getComboModelsFromData, resetComboRotation, stripComboPrefix } = await import("../../open-sse/services/combo.js");
const { buildModelsList } = await import("../../src/sse/services/allowedModels.js");
const { COMBO_ID_PREFIX, comboModelId } = await import("../../open-sse/services/comboPrefix.js");

const enc = new TextEncoder();
const sse = (frames) => new Response(new ReadableStream({
  start(c) { for (const f of frames) c.enqueue(enc.encode(f)); c.close(); },
}), { status: 200, headers: { "Content-Type": "text/event-stream" } });
const ROLE = `data: {"id":"x","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n`;
const CONTENT = (t) => `data: {"id":"x","choices":[{"index":0,"delta":{"content":"${t}"},"finish_reason":null}]}\n\n`;
const DONE = `data: [DONE]\n\n`;

const post = (path, body, k) => new Request(`http://localhost${path}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", ...(k ? { Authorization: `Bearer ${k}` } : {}) },
  body: JSON.stringify(body),
});
const chat = (model, k) => handleChat(post("/v1/chat/completions", { model, stream: true, messages: [{ role: "user", content: "hi" }] }, k));
const tried = () => mocks.handleChatCore.mock.calls.map(([a]) => `${a.modelInfo.provider}/${a.modelInfo.model}`);

beforeEach(() => {
  vi.clearAllMocks();
  resetComboRotation();
  fx.settings = { requireApiKey: false, comboStrategy: "fallback", comboStrategies: {} };
  fx.keys = {
    "sk-open": { id: "o", name: "open", isActive: true, access: { restricted: false, allow: [] } },
    "sk-combo": { id: "c", name: "combo", isActive: true, access: { restricted: true, allow: ["Main"] } },
    "sk-b": { id: "b", name: "b", isActive: true, access: { restricted: true, allow: ["openai/model-b"] } },
    "sk-empty": { id: "e", name: "empty", isActive: true, access: { restricted: true, allow: [] } },
  };
  mocks.getProviderCredentials.mockResolvedValue({ connectionId: "conn", connectionName: "mock" });
  // model-a always fails upstream, so a combo only succeeds by failing over to model-b.
  mocks.handleChatCore.mockImplementation(async ({ modelInfo }) => (modelInfo.model === "model-a"
    ? {
      success: false, status: 500, error: "upstream error",
      response: new Response(JSON.stringify({ error: { message: "upstream error" } }), { status: 500, headers: { "Content-Type": "application/json" } }),
    }
    : { success: true, response: sse([ROLE, CONTENT(`from-${modelInfo.model}`), DONE]) }));
});

describe("combo id helpers", () => {
  it("strips only a leading combo/ prefix and leaves everything else alone", () => {
    expect(stripComboPrefix("combo/Main")).toBe("Main");
    expect(stripComboPrefix("Main")).toBe("Main");
    expect(stripComboPrefix("openai/combo/x")).toBe("openai/combo/x");
    expect(stripComboPrefix(undefined)).toBeUndefined();
  });
  it("the published id is exactly what the resolver strips", () => {
    expect(COMBO_ID_PREFIX).toBe("combo/");
    expect(comboModelId("Main")).toBe("combo/Main");
    expect(stripComboPrefix(comboModelId("Main"))).toBe("Main");
  });
  it("/v1/models publishes combos with comboModelId(), and getComboModels accepts every published id", async () => {
    const published = (await buildModelsList(["llm"])).filter((m) => m.owned_by === "combo").map((m) => m.id);
    expect(published).toContain(comboModelId("Main"));
    for (const id of published) expect(await getComboModels(id)).not.toBeNull();
  });
});

describe("combo lookup by the id published in /v1/models", () => {
  it("getComboModels resolves combo/<name> and the bare name to the same members", async () => {
    const bare = await getComboModels("Main");
    expect(bare).toEqual(["openai/model-a", "openai/model-b"]);
    expect(await getComboModels("combo/Main")).toEqual(bare);
  });
  it("getComboModels still rejects provider/model pairs and unknown combos", async () => {
    expect(await getComboModels("openai/model-a")).toBeNull();
    expect(await getComboModels("combo/Nope")).toBeNull();
    expect(await getComboModels("combo/")).toBeNull();
    expect(await getComboModels("combo/openai/model-a")).toBeNull();
  });
  it("getComboModelsFromData (search/fetch) resolves combo/<name> too", () => {
    expect(getComboModelsFromData("combo/search-stack", fx.combos)).toEqual(["tavily", "exa"]);
    expect(getComboModelsFromData("search-stack", fx.combos)).toEqual(["tavily", "exa"]);
    expect(getComboModelsFromData("tavily/x", fx.combos)).toBeNull();
    expect(getComboModelsFromData("combo/nope", fx.combos)).toBeNull();
  });
});

describe("chat with a combo/<name> model", () => {
  it("routes as the combo (fails over model-a -> model-b), never as provider \"combo\"", async () => {
    const r = await chat("combo/Main", "sk-open");
    expect(r.status).toBe(200);
    expect(await r.text()).toContain("from-model-b");
    expect(tried()).toEqual(["openai/model-a", "openai/model-b"]);
  });
  it("bare name keeps working exactly as before", async () => {
    const r = await chat("Main", "sk-open");
    expect(r.status).toBe(200);
    expect(tried()).toEqual(["openai/model-a", "openai/model-b"]);
  });
  it("per-combo settings are looked up under the bare name (rotation shares state with the bare name)", async () => {
    fx.settings = { requireApiKey: false, comboStrategy: "fallback", comboStrategies: { Main: { fallbackStrategy: "round-robin" } } };
    expect((await chat("combo/Main", "sk-open")).status).toBe(200);
    expect(tried()).toEqual(["openai/model-a", "openai/model-b"]); // 1st request starts at model-a (fails) then model-b
    mocks.handleChatCore.mockClear();
    // 2nd request rotates to start at model-b. Keyed on the prefixed id it would miss the
    // "Main" strategy and stay on the global "fallback" order.
    expect((await chat("Main", "sk-open")).status).toBe(200);
    expect(tried()).toEqual(["openai/model-b"]);
  });
  it("a combo/<name> that is not a combo is NOT expanded as one (falls through as provider/model like before)", async () => {
    await chat("combo/Nope", "sk-open");
    expect(tried()).toEqual(["combo/Nope"]);
  });

  describe("per-key access uses the bare combo name", () => {
    it("restricted-to-combo key may call combo/Main", async () => {
      const r = await chat("combo/Main", "sk-combo");
      expect(r.status).toBe(200);
      expect(tried()).toEqual(["openai/model-a", "openai/model-b"]);
    });
    it("restricted-to-model-B key is denied combo/Main (403) before any credential lookup", async () => {
      const r = await chat("combo/Main", "sk-b");
      expect(r.status).toBe(403);
      expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
      expect(mocks.handleChatCore).not.toHaveBeenCalled();
    });
    it("empty-list key is denied combo/Main", async () => {
      expect((await chat("combo/Main", "sk-empty")).status).toBe(403);
      expect(mocks.handleChatCore).not.toHaveBeenCalled();
    });
    it("a combo/<unlisted> id is denied for a combo-restricted key", async () => {
      fx.combos.push({ id: "c3", name: "Other", models: ["openai/model-b"] });
      try {
        expect((await chat("combo/Other", "sk-combo")).status).toBe(403);
        expect(mocks.handleChatCore).not.toHaveBeenCalled();
      } finally {
        fx.combos.pop();
      }
    });
  });
});

describe("search with a combo/<name> provider", () => {
  it("is denied for a key that lacks the combo, allowed for a key that lists the bare name", async () => {
    fx.keys["sk-search"] = { id: "s", name: "search", isActive: true, access: { restricted: true, allow: ["search-stack"] } };
    const denied = await handleSearch(post("/v1/search", { model: "combo/search-stack", query: "x" }, "sk-b"));
    expect(denied.status).toBe(403);
    const allowed = await handleSearch(post("/v1/search", { model: "combo/search-stack", query: "x" }, "sk-search"));
    expect(allowed.status).not.toBe(403); // reaches the combo (providers themselves are not configured here)
  });
});

// The same expansion exists in the other combo-aware handlers. With no credentials
// configured, a request that expands the combo reaches the per-member credential
// lookup, whereas one treated as a plain "combo/<x>" provider/model does not get
// there with the combo's members. Prefixed and bare ids must behave identically.
describe.each([
  ["tts", (m, k) => handleTts(post("/v1/audio/speech", { model: m, input: "x" }, k)), "Main"],
  ["image", (m, k) => handleImageGeneration(post("/v1/images/generations", { model: m, prompt: "x" }, k)), "Main"],
  ["fetch", (m, k) => handleFetch(post("/v1/web/fetch", { model: m, url: "https://example.com" }, k)), "search-stack"],
  ["search", (m, k) => handleSearch(post("/v1/search", { model: m, query: "x" }, k)), "search-stack"],
])("%s handler expands combo/<name> like the bare name", (_name, call, comboName) => {
  const providersTried = () => mocks.getProviderCredentials.mock.calls.map(([provider]) => provider);

  it("tries the combo members for the prefixed id, same as for the bare name", async () => {
    mocks.getProviderCredentials.mockResolvedValue(null);
    await call(comboName, "sk-open");
    const bare = providersTried();
    expect(bare.length).toBeGreaterThan(0);

    mocks.getProviderCredentials.mockClear();
    await call(`combo/${comboName}`, "sk-open");
    expect(providersTried()).toEqual(bare);
  });
  it("applies the per-key combo allow-list to the prefixed id", async () => {
    mocks.getProviderCredentials.mockResolvedValue(null);
    expect((await call(`combo/${comboName}`, "sk-empty")).status).toBe(403);
    expect(mocks.getProviderCredentials).not.toHaveBeenCalled();
  });
});
