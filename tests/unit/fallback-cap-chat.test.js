import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderCredentials: vi.fn(),
  markAccountUnavailable: vi.fn(),
  clearAccountError: vi.fn(async () => {}),
  handleChatCore: vi.fn(),
  getSettings: vi.fn(),
  getModelInfo: vi.fn(),
  getComboModels: vi.fn(),
}));

vi.mock("open-sse/index.js", () => ({}));
vi.mock("@/sse/services/auth.js", () => ({
  getProviderCredentials: mocks.getProviderCredentials,
  markAccountUnavailable: mocks.markAccountUnavailable,
  clearAccountError: mocks.clearAccountError,
  extractApiKey: () => null,
  isValidApiKey: async () => null,
  isProviderAllowed: async () => true,
  isComboAllowed: () => true,
  isKindAllowed: () => true,
  isTrustedInternalRequest: async () => true,
}));
vi.mock("@/sse/services/allowedModels.js", () => ({ isModelAllowed: async () => true }));
vi.mock("@/sse/services/antigravityQuota.js", () => ({
  handleAntigravityQuotaError: vi.fn(),
  clearAntigravityStrikes: vi.fn(),
  getAntigravityQuotaCache: () => new Map(),
}));
vi.mock("@/lib/localDb", () => ({ getSettings: mocks.getSettings }));
vi.mock("@/sse/services/model.js", () => ({
  getModelInfo: mocks.getModelInfo,
  getComboModels: mocks.getComboModels,
}));
vi.mock("open-sse/handlers/chatCore.js", () => ({ handleChatCore: mocks.handleChatCore }));
vi.mock("@/lib/headroom/detect", () => ({ DEFAULT_HEADROOM_URL: "http://localhost:8787" }));
vi.mock("@/lib/pxpipe/loader.js", () => ({ getTransform: async () => null }));
vi.mock("@/lib/pxpipe/events.js", () => ({ appendPxpipeEvent: vi.fn() }));
vi.mock("open-sse/utils/bypassHandler.js", () => ({ handleBypassRequest: () => null }));
vi.mock("@/sse/services/tokenRefresh.js", () => ({
  updateProviderCredentials: vi.fn(async () => {}),
  checkAndRefreshToken: async (_provider, credentials) => credentials,
}));
vi.mock("open-sse/services/projectId.js", () => ({ getProjectIdForConnection: async () => null }));
vi.mock("@/lib/network/connectionProxy.js", () => ({ getProxyHash: () => "direct" }));
vi.mock("@/sse/utils/logger.js", () => ({
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  maskKey: (key) => key,
}));

import { handleChat } from "@/sse/handlers/chat.js";
import { COOLDOWN_RETRY } from "open-sse/config/resilienceConfig.js";

const MODELS = {
  "a/m1": { provider: "a", model: "m1" },
  "b/m2": { provider: "b", model: "m2" },
};

function makeRequest(model = "a/m1") {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] }),
  });
}

function liveCredentials(connectionId, accountCount) {
  return { connectionId, connectionName: "acct", accountCount, providerSpecificData: {} };
}

// Failing upstream whose error text numbers each attempt, so "last real error" is checkable.
function failingUpstream(status = 500) {
  let attempt = 0;
  return async () => {
    attempt += 1;
    const message = `upstream failure #${attempt}`;
    return { success: false, status, error: message, response: new Response(message, { status }) };
  };
}

// A provider whose accounts are handed out one by one (excluded ones are skipped).
function providerWithAccounts(count) {
  return async (_provider, exclude) => (
    exclude.size >= count ? null : liveCredentials(`conn-${exclude.size}`, count)
  );
}

describe("handleChat bounded account-fallback loop", () => {
  beforeEach(() => {
    mocks.getSettings.mockResolvedValue({ requireApiKey: false, circuitBreakerEnabled: false, comboStrategies: {} });
    mocks.getModelInfo.mockImplementation(async (model) => MODELS[model] || { provider: null, model });
    mocks.getComboModels.mockResolvedValue(null);
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true, cooldownMs: 0 });
  });

  afterEach(() => {
    vi.clearAllMocks();
    mocks.getProviderCredentials.mockReset();
    mocks.handleChatCore.mockReset();
    mocks.getComboModels.mockReset();
  });

  it("stops after 6 attempts for a provider with many accounts and returns the last real upstream error", async () => {
    mocks.getProviderCredentials.mockImplementation(providerWithAccounts(40));
    mocks.handleChatCore.mockImplementation(failingUpstream(500));

    const response = await handleChat(makeRequest());
    const body = await response.json();

    expect(mocks.handleChatCore).toHaveBeenCalledTimes(6);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(6);
    expect(response.status).toBe(500);
    expect(body.error.message).toBe("upstream failure #6");
  });

  it("lets natural exhaustion end the loop for small providers, with the same final error", async () => {
    mocks.getProviderCredentials.mockImplementation(providerWithAccounts(3));
    mocks.handleChatCore.mockImplementation(failingUpstream(502));

    const response = await handleChat(makeRequest());

    expect(mocks.handleChatCore).toHaveBeenCalledTimes(3);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(4); // the 4th lookup finds no account left
    expect(response.status).toBe(502);
    expect((await response.json()).error.message).toBe("upstream failure #3");
  });

  it("does not change combo behaviour: every member gets its own budget", async () => {
    mocks.getComboModels.mockImplementation(async (name) => (name === "pair" ? ["a/m1", "b/m2"] : null));
    mocks.getProviderCredentials.mockImplementation(providerWithAccounts(40));
    mocks.handleChatCore.mockImplementation(failingUpstream(500));

    const response = await handleChat(makeRequest("pair"));

    expect(mocks.handleChatCore).toHaveBeenCalledTimes(12);
    expect(response.status).toBe(500);
  });

  it("a successful later attempt is unaffected by the cap", async () => {
    mocks.getProviderCredentials.mockImplementation(providerWithAccounts(40));
    let attempt = 0;
    mocks.handleChatCore.mockImplementation(async () => {
      attempt += 1;
      if (attempt < 5) return { success: false, status: 500, error: "boom", response: new Response("boom", { status: 500 }) };
      return { success: true, response: new Response("ok", { status: 200 }) };
    });

    const response = await handleChat(makeRequest());
    expect(response.status).toBe(200);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(5);
  });

  describe("with the cooldown-aware retry", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it("a cooldown retry starts a fresh pass instead of inheriting the spent budget", async () => {
      mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true, cooldownMs: 1_000 });
      const script = [
        liveCredentials("conn-0", 2),
        liveCredentials("conn-1", 2),
        {
          allRateLimited: true,
          retryAfter: new Date(Date.now() + 1_000).toISOString(),
          lastError: "Rate limit exceeded",
          lastErrorCode: 429,
          retryAfterHuman: "reset after 1s",
        },
        liveCredentials("conn-0", 2),
      ];
      let call = 0;
      mocks.getProviderCredentials.mockImplementation(async () => script[call++]);
      let attempt = 0;
      mocks.handleChatCore.mockImplementation(async () => {
        attempt += 1;
        if (attempt <= 2) return { success: false, status: 429, error: "Rate limit exceeded", response: new Response("rl", { status: 429 }) };
        return { success: true, response: new Response("ok", { status: 200 }) };
      });

      const pending = handleChat(makeRequest());
      await vi.advanceTimersByTimeAsync(1_000 + COOLDOWN_RETRY.SETTLE_MARGIN_MS);
      const response = await pending;

      expect(response.status).toBe(200);
      expect(mocks.handleChatCore).toHaveBeenCalledTimes(3); // 2 attempts (cap 2) + 1 after the wait
    });
  });
});
