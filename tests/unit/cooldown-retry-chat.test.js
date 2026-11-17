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
import { getAccountSemaphoreStats } from "open-sse/services/accountSemaphore.js";
import { COOLDOWN_RETRY } from "open-sse/config/resilienceConfig.js";

const MARGIN = COOLDOWN_RETRY.SETTLE_MARGIN_MS;
const MODELS = {
  "a/m1": { provider: "a", model: "m1" },
  "b/m2": { provider: "b", model: "m2" },
};

function makeRequest(model = "a/m1", { signal, stream = false } = {}) {
  return new Request("http://localhost/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, stream, messages: [{ role: "user", content: "hi" }] }),
    signal,
  });
}

function liveCredentials(connectionId = "conn-a") {
  return { connectionId, connectionName: "acct", apiKey: "sk-test-secret", providerSpecificData: {} };
}

function allLocked(msFromNow, extra = {}) {
  return {
    allRateLimited: true,
    retryAfter: new Date(Date.now() + msFromNow).toISOString(),
    retryAfterHuman: `reset after ${Math.ceil(msFromNow / 1000)}s`,
    lastError: "Rate limit exceeded",
    lastErrorCode: 429,
    ...extra,
  };
}

const okResult = () => ({ success: true, response: new Response("ok", { status: 200 }) });
const rateLimitedResult = () => ({
  success: false,
  status: 429,
  error: "Rate limit exceeded",
  response: new Response("rate limited", { status: 429 }),
});

describe("handleChat cooldown-aware retry", () => {
  let settings;

  beforeEach(() => {
    vi.useFakeTimers();
    settings = { requireApiKey: false, circuitBreakerEnabled: false, comboStrategies: {} };
    mocks.getSettings.mockImplementation(async () => settings);
    mocks.getModelInfo.mockImplementation(async (model) => MODELS[model] || { provider: null, model });
    mocks.getComboModels.mockResolvedValue(null);
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true, cooldownMs: 4_000 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mocks.getProviderCredentials.mockReset();
    mocks.handleChatCore.mockReset();
  });

  it("waits for the earliest cooldown, retries selection once and succeeds", async () => {
    mocks.getProviderCredentials
      .mockResolvedValueOnce(allLocked(5_000))
      .mockResolvedValueOnce(liveCredentials());
    mocks.handleChatCore.mockResolvedValue(okResult());

    const pending = handleChat(makeRequest());
    await vi.advanceTimersByTimeAsync(4_000);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000 + MARGIN);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(2);
    expect(mocks.handleChatCore).toHaveBeenCalledTimes(1);
  });

  it("applies to streaming requests too", async () => {
    mocks.getProviderCredentials
      .mockResolvedValueOnce(allLocked(1_000))
      .mockResolvedValueOnce(liveCredentials());
    mocks.handleChatCore.mockResolvedValue(okResult());

    const pending = handleChat(makeRequest("a/m1", { stream: true }));
    await vi.advanceTimersByTimeAsync(1_000 + MARGIN);
    expect((await pending).status).toBe(200);
  });

  it("clears the exclusion list so the account that just cooled down is selectable again", async () => {
    mocks.markAccountUnavailable.mockResolvedValue({ shouldFallback: true, cooldownMs: 3_000 });
    const script = [liveCredentials("conn-a"), allLocked(3_000), liveCredentials("conn-a")];
    const excludedAtCall = [];
    mocks.getProviderCredentials.mockImplementation(async (_provider, exclude) => {
      excludedAtCall.push([...exclude]); // the Set is mutated in place, so snapshot it
      return script[excludedAtCall.length - 1];
    });
    mocks.handleChatCore
      .mockResolvedValueOnce(rateLimitedResult())
      .mockResolvedValueOnce(okResult());

    const pending = handleChat(makeRequest());
    await vi.advanceTimersByTimeAsync(3_000 + MARGIN);
    expect((await pending).status).toBe(200);

    expect(excludedAtCall).toEqual([[], ["conn-a"], []]);
  });

  it("does not hold an account-semaphore slot while waiting", async () => {
    mocks.getProviderCredentials
      .mockResolvedValueOnce(liveCredentials("conn-sem"))
      .mockResolvedValueOnce(allLocked(4_000))
      .mockResolvedValueOnce(liveCredentials("conn-sem"));
    mocks.handleChatCore
      .mockResolvedValueOnce(rateLimitedResult())
      .mockResolvedValueOnce(okResult());

    const pending = handleChat(makeRequest());
    await vi.advanceTimersByTimeAsync(1_000);

    // Mid-wait: the first attempt's slot is released and nothing is queued.
    const stats = getAccountSemaphoreStats().filter((stat) => stat.key.includes("conn-sem"));
    expect(stats.every((stat) => stat.running === 0 && stat.queued === 0)).toBe(true);

    await vi.advanceTimersByTimeAsync(3_000 + MARGIN);
    expect((await pending).status).toBe(200);
    expect(getAccountSemaphoreStats().filter((stat) => stat.key.includes("conn-sem") && stat.running > 0)).toEqual([]);
  });

  it("skips the wait when the cooldown exceeds the bound and returns 503 + Retry-After at once", async () => {
    mocks.getProviderCredentials.mockResolvedValue(allLocked(45_000));

    const response = await handleChat(makeRequest());
    expect(response.status).toBe(503);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("honours cooldownRetryMaxWaitMs from settings", async () => {
    settings = { ...settings, cooldownRetryMaxWaitMs: 1_000 };
    mocks.getProviderCredentials.mockResolvedValue(allLocked(5_000));

    const response = await handleChat(makeRequest());
    expect(response.status).toBe(503);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
  });

  it("does nothing when cooldownRetryEnabled is false", async () => {
    settings = { ...settings, cooldownRetryEnabled: false };
    mocks.getProviderCredentials.mockResolvedValue(allLocked(1_000));

    const response = await handleChat(makeRequest());
    expect(response.status).toBe(503);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
  });

  it("retries only once, then returns the usual 503 with Retry-After", async () => {
    mocks.getProviderCredentials.mockImplementation(async () => allLocked(2_000));

    const pending = handleChat(makeRequest());
    await vi.advanceTimersByTimeAsync(2_000 + MARGIN);
    const response = await pending;

    expect(response.status).toBe(503);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the wait immediately when the client disconnects", async () => {
    const controller = new AbortController();
    mocks.getProviderCredentials.mockImplementation(async () => allLocked(20_000));

    const pending = handleChat(makeRequest("a/m1", { signal: controller.signal }));
    await vi.advanceTimersByTimeAsync(2_000);
    controller.abort();
    const response = await pending;

    expect(response.status).toBe(499);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.handleChatCore).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not wait on a transient (non rate-limit) lock", async () => {
    mocks.getProviderCredentials.mockResolvedValue(allLocked(5_000, { lastErrorCode: 504, lastError: "stream readiness timeout" }));

    const response = await handleChat(makeRequest());
    expect(response.status).toBe(503);
    expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(1);
  });

  describe("inside a combo", () => {
    beforeEach(() => {
      mocks.getComboModels.mockImplementation(async (name) => (
        name === "two-way" ? ["a/m1", "b/m2"] : name === "solo" ? ["a/m1"] : null
      ));
    });

    it("falls through to the next member instead of waiting", async () => {
      mocks.getProviderCredentials.mockImplementation(async (provider) => (
        provider === "a" ? allLocked(5_000) : liveCredentials("conn-b")
      ));
      mocks.handleChatCore.mockResolvedValue(okResult());

      // Member "a" is locked for 5s. Combos already pause up to 2s on a rate-limit
      // 503 before falling through (pre-existing, unrelated to this feature); the
      // cooldown gate would need 5s+ here, so success after 2.1s proves it never waited.
      const pending = handleChat(makeRequest("two-way"));
      await vi.advanceTimersByTimeAsync(2_100);
      const response = await pending;

      expect(response.status).toBe(200);
      expect(mocks.getProviderCredentials.mock.calls.map(([provider]) => provider)).toEqual(["a", "b"]);
    });

    it("waits when the cooling-down candidate is the last one", async () => {
      mocks.getProviderCredentials
        .mockResolvedValueOnce(allLocked(5_000))
        .mockResolvedValueOnce(liveCredentials("conn-a"));
      mocks.handleChatCore.mockResolvedValue(okResult());

      const pending = handleChat(makeRequest("solo"));
      await vi.advanceTimersByTimeAsync(5_000 + MARGIN);
      expect((await pending).status).toBe(200);
      expect(mocks.getProviderCredentials).toHaveBeenCalledTimes(2);
    });
  });
});
