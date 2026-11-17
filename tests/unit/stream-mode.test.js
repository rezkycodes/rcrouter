// A client that omits `stream` follows its own API's default: OpenAI Chat
// Completions, Anthropic Messages and OpenAI Responses all default to a plain JSON
// reply. Streaming-by-default made the router ask the upstream for SSE (Accept
// header) without telling it `stream: true`, so OpenAI-compatible upstreams
// answered JSON that the router then served as an event stream.
import { describe, expect, it } from "vitest";
import { resolveStreamMode } from "../../open-sse/handlers/chatCore/streamMode.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

const base = { sourceFormat: FORMATS.OPENAI, acceptHeader: "", providerRequiresStreaming: false };

describe("resolveStreamMode", () => {
  describe("explicit stream field", () => {
    it("streams when stream is true", () => {
      expect(resolveStreamMode({ ...base, body: { stream: true } })).toBe(true);
    });

    it("does not stream when stream is false", () => {
      expect(resolveStreamMode({ ...base, body: { stream: false } })).toBe(false);
    });

    it("keeps treating any other non-null value as a streaming request", () => {
      expect(resolveStreamMode({ ...base, body: { stream: "true" } })).toBe(true);
      expect(resolveStreamMode({ ...base, body: { stream: 1 } })).toBe(true);
    });
  });

  describe("stream field omitted", () => {
    it.each([FORMATS.OPENAI, FORMATS.CLAUDE, FORMATS.OPENAI_RESPONSES])(
      "returns JSON for %s clients without an Accept preference",
      (sourceFormat) => {
        expect(resolveStreamMode({ ...base, sourceFormat, body: {} })).toBe(false);
      },
    );

    it("treats stream: null like an omitted field", () => {
      expect(resolveStreamMode({ ...base, body: { stream: null } })).toBe(false);
    });

    it("returns JSON for a wildcard or JSON Accept header", () => {
      expect(resolveStreamMode({ ...base, body: {}, acceptHeader: "*/*" })).toBe(false);
      expect(resolveStreamMode({ ...base, body: {}, acceptHeader: "application/json" })).toBe(false);
    });

    it("still streams for a client that asks for an event stream", () => {
      expect(resolveStreamMode({ ...base, body: {}, acceptHeader: "text/event-stream" })).toBe(true);
    });

    it("prefers JSON when the client accepts both", () => {
      expect(resolveStreamMode({
        ...base, body: {}, acceptHeader: "application/json, text/event-stream",
      })).toBe(false);
    });

    it.each([FORMATS.GEMINI, FORMATS.GEMINI_CLI, FORMATS.ANTIGRAVITY])(
      "keeps the legacy streaming default for the endpoint-driven %s format",
      (sourceFormat) => {
        expect(resolveStreamMode({ ...base, sourceFormat, body: {} })).toBe(true);
      },
    );
  });

  it("always streams for providers that require it, whatever the client sent", () => {
    for (const body of [{}, { stream: false }, { stream: true }]) {
      expect(resolveStreamMode({ ...base, body, providerRequiresStreaming: true })).toBe(true);
    }
  });
});
