import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnections: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getProviderConnections: mocks.getProviderConnections,
  getCombos: vi.fn(async () => []),
  getCustomModels: vi.fn(async () => []),
  getModelAliases: vi.fn(async () => ({})),
}));
vi.mock("@/lib/disabledModelsDb", () => ({ getDisabledModels: vi.fn(async () => ({})) }));
vi.mock("@/sse/services/tokenRefresh", () => ({ updateProviderCredentials: vi.fn() }));
vi.mock("@/lib/network/connectionProxy", () => ({ resolveConnectionProxyConfig: vi.fn(async () => ({})) }));

const { buildModelsList, isModelAllowed, invalidateAllowedModelsCache } =
  await import("../../src/sse/services/allowedModels.js");

const MODELS_URL = "https://api.commandcode.ai/provider/v1/models?view=client";
const liveCatalog = {
  data: [
    { id: "deepseek/deepseek-v4-pro", display: { label: "DeepSeek V4 Pro" }, inputModalities: ["text"], reasoningEfforts: [] },
    { id: "claude-opus-5-5", display: { label: "Claude Opus 5.5" }, inputModalities: ["text", "image"], reasoningEfforts: ["high"] },
    { id: "gpt-6.1-sol", display: { label: "GPT 6.1 Sol" }, inputModalities: ["text"], reasoningEfforts: [] },
  ],
};

const apiKeyInfo = { id: "key-1" };

function stubCatalogFetch({ ok }) {
  vi.stubGlobal("fetch", vi.fn(async (url) => {
    if (String(url) === MODELS_URL && ok) {
      return { ok: true, status: 200, json: async () => liveCatalog };
    }
    return { ok: false, status: 503, json: async () => ({}), text: async () => "" };
  }));
}

// The live-catalog fallback cache in allowedModels is module-global and keyed by
// connection id, so each test connects under its own id to stay independent.
function connectCommandcode(id) {
  mocks.getProviderConnections.mockResolvedValue([
    { id, provider: "commandcode", isActive: true, apiKey: "user_test", providerSpecificData: {} },
  ]);
}

describe("commandcode live catalog in allowedModels", () => {
  beforeEach(() => {
    invalidateAllowedModelsCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("lists live-only models next to the static ones under the cmc alias", async () => {
    connectCommandcode("cc-list");
    stubCatalogFetch({ ok: true });

    const ids = (await buildModelsList(["llm"])).map((m) => m.id);

    expect(ids).toContain("cmc/claude-opus-5-5");
    expect(ids).toContain("cmc/gpt-6.1-sol");
    expect(ids).toContain("cmc/deepseek/deepseek-v4-pro");
  });

  it("allows an API-key request for a live-only model", async () => {
    connectCommandcode("cc-acl");
    stubCatalogFetch({ ok: true });

    expect(await isModelAllowed("cmc/claude-opus-5-5", apiKeyInfo)).toBe(true);
  });

  it("keeps the static catalog when the live fetch fails and nothing was cached", async () => {
    connectCommandcode("cc-cold");
    stubCatalogFetch({ ok: false });

    const ids = (await buildModelsList(["llm"])).map((m) => m.id);

    expect(ids).toContain("cmc/deepseek/deepseek-v4-pro");
    expect(ids).not.toContain("cmc/claude-opus-5-5");
  });

  it("keeps live-only models allowed through a transient upstream failure", async () => {
    connectCommandcode("cc-transient");
    stubCatalogFetch({ ok: true });
    expect(await isModelAllowed("cmc/claude-opus-5-5", apiKeyInfo)).toBe(true);

    // ACL/list caches expire while api.commandcode.ai is down.
    invalidateAllowedModelsCache();
    stubCatalogFetch({ ok: false });

    expect(await isModelAllowed("cmc/claude-opus-5-5", apiKeyInfo)).toBe(true);
    expect((await buildModelsList(["llm"])).map((m) => m.id)).toContain("cmc/claude-opus-5-5");
  });
});
