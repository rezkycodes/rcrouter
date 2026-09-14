import { describe, it, expect } from "vitest";
import zcodeProvider from "../../open-sse/providers/registry/zcode.js";
import { ZcodeExecutor } from "../../open-sse/executors/zcode.js";
import searxngProvider from "../../open-sse/providers/registry/searxng.js";
import { TTS_MODELS_CONFIG } from "../../open-sse/config/ttsModels.js";
import { getExecutor } from "../../open-sse/executors/index.js";
import { PROVIDERS, PROVIDER_MODELS } from "../../open-sse/providers/index.js";
import fs from "node:fs";
import path from "node:path";

describe("Ticket 06: Specialized Providers", () => {
  describe("ZCode provider and executor", () => {
    it("zcode provider has correct id, alias, category, and GLM-5.2 models", () => {
      expect(zcodeProvider.id).toBe("zcode");
      expect(zcodeProvider.alias).toBe("zc");
      expect(zcodeProvider.category).toBe("apikey");
      expect(zcodeProvider.hasOAuth).toBe(true);

      const modelIds = zcodeProvider.models.map((m) => m.id);
      expect(modelIds).toContain("GLM-5.2");
      expect(modelIds).toContain("GLM-5.2-Max");
      expect(modelIds).toContain("GLM-5-Turbo");
      expect(modelIds).toContain("GLM-5-Turbo-Max");
    });

    it("registers zcode and zc in open-sse PROVIDERS and PROVIDER_MODELS", () => {
      expect(PROVIDERS.zcode).toBeDefined();
      expect(PROVIDER_MODELS.zc).toBeDefined();
      const modelIds = PROVIDER_MODELS.zc.map((m) => m.id);
      expect(modelIds).toEqual(["GLM-5.2", "GLM-5.2-Max", "GLM-5-Turbo", "GLM-5-Turbo-Max"]);
    });

    it("registers ZcodeExecutor in open-sse executors registry under zcode and zc", () => {
      const zcodeExec = getExecutor("zcode");
      const zcExec = getExecutor("zc");
      expect(zcodeExec).toBeInstanceOf(ZcodeExecutor);
      expect(zcExec).toBeInstanceOf(ZcodeExecutor);
    });

    it("ZcodeExecutor constructs URLs and headers correctly with spoofing and captcha", () => {
      const exec = new ZcodeExecutor();
      expect(exec.resolveBaseUrl()).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic");
      expect(exec.buildUrl("GLM-5.2", true)).toBe("https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages");

      const credentials = {
        providerSpecificData: { zcodeJwtToken: "mock-jwt-token" }
      };
      const headers = exec.buildHeaders(credentials, true, "mock-captcha-param");
      expect(headers["Authorization"]).toBe("Bearer mock-jwt-token");
      expect(headers["X-Aliyun-Captcha-Verify-Param"]).toBe("mock-captcha-param");
      expect(headers["X-Aliyun-Captcha-Verify-Region"]).toBe("sgp");
      expect(headers["X-Title"]).toBe("Z Code@electron");
      expect(headers["User-Agent"]).toBe("ZCode/3.1.0");
      expect(headers["X-ZCode-Agent"]).toBe("glm");
      expect(headers["anthropic-version"]).toBe("2023-06-01");
      expect(headers["Accept"]).toBe("text/event-stream");
    });

    it("ZcodeExecutor transforms reasoning models by setting upstream model and thinking budget", () => {
      const exec = new ZcodeExecutor();
      const transformed = exec.transformRequest("GLM-5.2-Max", { max_tokens: 1000, messages: [] }, true, null);
      expect(transformed.model).toBe("GLM-5.2");
      expect(transformed.thinking).toEqual({ type: "enabled", budget_tokens: 4096 });
      expect(transformed.max_tokens).toBe(4096 + 4096);
    });
  });

  describe("SearXNG provider", () => {
    it("searxng has noAuth: true, category: freeTier, and local baseUrl 127.0.0.1:8888", () => {
      expect(searxngProvider.id).toBe("searxng");
      expect(searxngProvider.alias).toBe("searxng");
      expect(searxngProvider.noAuth).toBe(true);
      expect(searxngProvider.category).toBe("freeTier");
      expect(searxngProvider.searchConfig.baseUrl).toBe("http://127.0.0.1:8888/search");
      expect(searxngProvider.searchConfig.costPerQuery).toBe(0);
    });
  });

  describe("Indonesian and Southeast Asian TTS voices", () => {
    it("contains id-ID, th-TH, ms-MY, and tl-PH voices in edge-tts defaults", () => {
      const defaults = TTS_MODELS_CONFIG["edge-tts"].defaults;
      const voiceIds = defaults.map((d) => d.id);

      expect(voiceIds).toContain("id-ID-ArdiNeural");
      expect(voiceIds).toContain("id-ID-GadisNeural");
      expect(voiceIds).toContain("th-TH-PremwadeeNeural");
      expect(voiceIds).toContain("ms-MY-YasminNeural");
      expect(voiceIds).toContain("tl-PH-BlessicaNeural");

      const ardi = defaults.find((d) => d.id === "id-ID-ArdiNeural");
      expect(ardi.name).toBe("Ardi (id-ID)");
      expect(ardi.type).toBe("tts");

      const gadis = defaults.find((d) => d.id === "id-ID-GadisNeural");
      expect(gadis.name).toBe("Gadis (id-ID)");

      const premwadee = defaults.find((d) => d.id === "th-TH-PremwadeeNeural");
      expect(premwadee.name).toBe("Premwadee (th-TH)");

      const yasmin = defaults.find((d) => d.id === "ms-MY-YasminNeural");
      expect(yasmin.name).toBe("Yasmin (ms-MY)");

      const blessica = defaults.find((d) => d.id === "tl-PH-BlessicaNeural");
      expect(blessica.name).toBe("Blessica (tl-PH)");
    });
  });

  describe("Package.json dependencies", () => {
    it("has playwright-core in dependencies", () => {
      const pkgPath = path.resolve(process.cwd(), "package.json");
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      expect(pkg.dependencies["playwright-core"]).toBe("^1.60.0");
    });
  });
});
