import { describe, it, expect, vi } from "vitest";
import { resolveCommandcodeModels } from "../../open-sse/services/commandcodeModels.js";
import { PROVIDERS } from "../../open-sse/config/providers.js";

const MODELS_URL = "https://api.commandcode.ai/provider/v1/models?view=client";

const jsonResponse = (body, ok = true) => ({
  ok,
  status: ok ? 200 : 500,
  json: async () => body,
});

const catalog = {
  data: [
    {
      id: "claude-sonnet-5-5",
      name: "raw-name",
      display: { label: "Claude Sonnet 5.5", description: "best combo of speed & intelligence" },
      context_length: 1_000_000,
      maxOutputTokens: null,
      inputModalities: ["text", "image"],
      reasoningEfforts: ["low", "high"],
    },
    {
      id: "deepseek/deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      context_length: 128_000,
      maxOutputTokens: 8192,
      inputModalities: ["text"],
      reasoningEfforts: [],
    },
    { id: "hidden-model", hidden: true },
    { name: "entry-without-id" },
  ],
};

describe("resolveCommandcodeModels", () => {
  it("maps the public catalog, skipping hidden and id-less entries", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(catalog));

    const result = await resolveCommandcodeModels(fetchImpl);

    expect(result.models).toHaveLength(2);
    expect(result.models[0]).toEqual({
      id: "claude-sonnet-5-5",
      name: "Claude Sonnet 5.5",
      description: "best combo of speed & intelligence",
      contextLength: 1_000_000,
      maxOutputTokens: undefined,
      isVL: true,
      isReasoning: true,
    });
    expect(result.models[1]).toEqual({
      id: "deepseek/deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      description: null,
      contextLength: 128_000,
      maxOutputTokens: 8192,
      isVL: false,
      isReasoning: false,
    });
  });

  it("calls the catalog endpoint with provider transport headers and no credentials", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(catalog));

    await resolveCommandcodeModels(fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(MODELS_URL);
    expect(init.method).toBe("GET");
    expect(init.headers).toMatchObject(PROVIDERS.commandcode.headers);
    expect(Object.keys(init.headers).map((k) => k.toLowerCase())).not.toContain("authorization");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns null when upstream answers with a non-OK status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, false));
    expect(await resolveCommandcodeModels(fetchImpl)).toBeNull();
  });

  it("returns null when the request throws", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("network down"));
    expect(await resolveCommandcodeModels(fetchImpl)).toBeNull();
  });

  it("returns null when the payload has no usable models", async () => {
    const hiddenOnly = { data: [{ id: "hidden-model", hidden: true }] };
    expect(await resolveCommandcodeModels(vi.fn().mockResolvedValue(jsonResponse(hiddenOnly)))).toBeNull();
    expect(await resolveCommandcodeModels(vi.fn().mockResolvedValue(jsonResponse({ data: "nope" })))).toBeNull();
    expect(await resolveCommandcodeModels(vi.fn().mockResolvedValue(jsonResponse(null)))).toBeNull();
  });
});
