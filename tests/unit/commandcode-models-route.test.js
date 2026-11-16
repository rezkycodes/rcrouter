import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getProviderConnectionById: vi.fn(),
  resolveCommandCodeModels: vi.fn(),
}));

vi.mock("@/models", () => ({ getProviderConnectionById: mocks.getProviderConnectionById }));
vi.mock("@/sse/services/tokenRefresh", () => ({
  refreshGoogleToken: vi.fn(),
  refreshCodexToken: vi.fn(),
  updateProviderCredentials: vi.fn(),
}));
vi.mock("open-sse/services/commandcodeModels.js", () => ({
  resolveCommandCodeModels: mocks.resolveCommandCodeModels,
}));

const { GET } = await import("../../src/app/api/providers/[id]/models/route.js");

const connection = { id: "cc-1", provider: "commandcode", apiKey: "user_test" };
const params = { params: Promise.resolve({ id: "cc-1" }) };

describe("GET /api/providers/[id]/models for commandcode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProviderConnectionById.mockResolvedValue(connection);
  });

  it("returns the live catalog when the resolver has models", async () => {
    const live = [
      { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
      { id: "gpt-6.1-sol", name: "GPT 6.1 Sol" },
    ];
    mocks.resolveCommandCodeModels.mockResolvedValue({ models: live });

    const response = await GET(new Request("http://localhost/api/providers/cc-1/models"), params);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ provider: "commandcode", connectionId: "cc-1", models: live });
  });

  it("falls back to the static catalog with a warning when live returns nothing", async () => {
    mocks.resolveCommandCodeModels.mockResolvedValue(null);

    const response = await GET(new Request("http://localhost/api/providers/cc-1/models"), params);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.models.map((m) => m.id)).toContain("deepseek/deepseek-v4-pro");
    expect(body.warning).toMatch(/falling back to static catalog/i);
  });
});
