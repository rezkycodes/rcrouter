import { describe, expect, it } from "vitest";
import { getModelsToImport } from "@/shared/utils/providerCustomModels.js";

const base = { providerId: "antigravity", providerAlias: "ag" };
const entry = (id) => ({ providerAlias: "ag", id, type: "llm" });

describe("getModelsToImport", () => {
  it("returns chat models from the live catalog as llm entries for the storage alias", () => {
    const result = getModelsToImport({
      ...base,
      fetchedModels: [{ id: "gemini-3.8-flash-high" }, { id: "gemini-3.8-flash-low" }],
    });

    expect(result).toEqual([entry("gemini-3.8-flash-high"), entry("gemini-3.8-flash-low")]);
  });

  it("strips a leading provider id or storage alias from catalog ids", () => {
    const result = getModelsToImport({
      ...base,
      fetchedModels: [{ id: "antigravity/one" }, { id: "ag/two" }, { id: "three" }],
    });

    expect(result.map((m) => m.id)).toEqual(["one", "two", "three"]);
  });

  it("strips only one prefix and leaves other slashes in the id alone", () => {
    const result = getModelsToImport({
      ...base,
      fetchedModels: [{ id: "ag/vendor/model-x" }],
    });

    expect(result.map((m) => m.id)).toEqual(["vendor/model-x"]);
  });

  it("falls back to name or model when a catalog entry has no id", () => {
    const result = getModelsToImport({
      ...base,
      fetchedModels: [{ name: "by-name" }, { model: "by-model" }],
    });

    expect(result.map((m) => m.id)).toEqual(["by-name", "by-model"]);
  });

  it("skips non-chat models by declared kind or type", () => {
    const result = getModelsToImport({
      ...base,
      fetchedModels: [
        { id: "chat-ok", kind: "llm" },
        { id: "pic", kind: "image" },
        { id: "vec", type: "embedding" },
        { id: "untyped" },
      ],
    });

    expect(result.map((m) => m.id)).toEqual(["chat-ok", "untyped"]);
  });

  it("keeps chat models whose raw catalog item carries a provider-specific type", () => {
    // Anthropic /v1/models items are { type: "model" }, Together's are { type: "chat" }.
    const result = getModelsToImport({
      ...base,
      fetchedModels: [
        { type: "model", id: "claude-opus-5", display_name: "Claude Opus 5" },
        { type: "chat", id: "together-chat" },
        { object: "model", id: "plain-openai-shape" },
      ],
    });

    expect(result.map((m) => m.id)).toEqual(["claude-opus-5", "together-chat", "plain-openai-shape"]);
  });

  it.each(["embedding", "image", "imageToText", "tts", "stt", "webSearch", "webFetch", "video", "music"])(
    "skips a %s model",
    (kind) => {
      expect(getModelsToImport({ ...base, fetchedModels: [{ id: "m", kind }] })).toEqual([]);
      expect(getModelsToImport({ ...base, fetchedModels: [{ id: "m", type: kind }] })).toEqual([]);
    }
  );

  it("normalizes Gemini catalog names (models/<id>, no id field) so built-ins are not duplicated", () => {
    const result = getModelsToImport({
      providerId: "gemini",
      providerAlias: "gemini",
      existingModels: [{ id: "gemini-2.5-pro" }],
      fetchedModels: [
        { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" },
        { name: "models/gemini-3-new", displayName: "Gemini 3 New" },
      ],
    });

    expect(result).toEqual([{ providerAlias: "gemini", id: "gemini-3-new", type: "llm" }]);
  });

  it("skips ids that look like embedding, speech, image or moderation models", () => {
    const result = getModelsToImport({
      ...base,
      fetchedModels: [
        { id: "text-embedding-3-small" },
        { id: "whisper-1" },
        { id: "tts-1-hd" },
        { id: "dall-e-3" },
        { id: "omni-moderation-latest" },
        { id: "rerank-v3" },
        { id: "gpt-6" },
      ],
    });

    expect(result.map((m) => m.id)).toEqual(["gpt-6"]);
  });

  it("skips models that are already built in", () => {
    const result = getModelsToImport({
      ...base,
      existingModels: [{ id: "built-in" }],
      fetchedModels: [{ id: "built-in" }, { id: "fresh" }],
    });

    expect(result.map((m) => m.id)).toEqual(["fresh"]);
  });

  it("skips models already saved as llm custom models for the same alias only", () => {
    const result = getModelsToImport({
      ...base,
      customModels: [
        { providerAlias: "ag", id: "saved", type: "llm" },
        { providerAlias: "other", id: "elsewhere", type: "llm" },
        { providerAlias: "ag", id: "imagey", type: "image" },
      ],
      fetchedModels: [{ id: "saved" }, { id: "elsewhere" }, { id: "imagey" }],
    });

    expect(result.map((m) => m.id)).toEqual(["elsewhere", "imagey"]);
  });

  it("skips models that already exist as legacy aliases under the alias or provider id", () => {
    const result = getModelsToImport({
      ...base,
      modelAliases: {
        a: "ag/via-alias",
        b: "antigravity/via-provider",
        c: "someone-else/other",
        d: 42,
      },
      fetchedModels: [{ id: "via-alias" }, { id: "via-provider" }, { id: "other" }],
    });

    expect(result.map((m) => m.id)).toEqual(["other"]);
  });

  it("does not let another provider's alias block a catalog id that merely looks the same", () => {
    const result = getModelsToImport({
      providerId: "openrouter",
      providerAlias: "or",
      modelAliases: { mine: "anthropic/claude-x" },
      fetchedModels: [{ id: "anthropic/claude-x" }],
    });

    expect(result).toEqual([{ providerAlias: "or", id: "anthropic/claude-x", type: "llm" }]);
  });

  it("lists each model once even if the catalog repeats it or its prefixed form", () => {
    const result = getModelsToImport({
      ...base,
      fetchedModels: [{ id: "dup" }, { id: "ag/dup" }, { id: "dup" }],
    });

    expect(result.map((m) => m.id)).toEqual(["dup"]);
  });

  it("ignores unusable catalog entries and empty results", () => {
    expect(getModelsToImport({ ...base, fetchedModels: [null, undefined, "str", 7, {}, { id: "" }, { id: 5 }] })).toEqual([]);
    expect(getModelsToImport({ ...base })).toEqual([]);
    expect(getModelsToImport({ ...base, fetchedModels: [{ id: "ag/" }] })).toEqual([]);
  });

  it("does not treat regex characters in provider ids as patterns", () => {
    const result = getModelsToImport({
      providerId: "a.b",
      providerAlias: "a.b",
      fetchedModels: [{ id: "axb/model" }, { id: "a.b/model" }],
    });

    expect(result.map((m) => m.id)).toEqual(["axb/model", "model"]);
  });
});
