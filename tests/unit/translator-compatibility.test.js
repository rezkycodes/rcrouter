import { describe, expect, it } from "vitest";
import { FORMATS } from "../../open-sse/translator/formats.js";
import { getUnsupportedTranslation } from "../../open-sse/translator/compatibility.js";
import { buildErrorBody } from "../../open-sse/utils/error.js";

const messageWith = (block) => ({ messages: [{ role: "user", content: [block] }] });

describe("translator compatibility gate", () => {
  it("returns a typed C-01 failure for OpenAI audio to Claude", () => {
    expect(getUnsupportedTranslation(
      FORMATS.OPENAI,
      FORMATS.CLAUDE,
      messageWith({ type: "input_audio", input_audio: { data: "redacted", format: "wav" } }),
    )).toMatchObject({ caseId: "C-01", code: "audio_input_unsupported" });
  });

  it("rejects unresolved Kiro remote images only after prefetch", () => {
    const body = messageWith({ type: "image_url", image_url: { url: "https://example.invalid/image.png" } });
    expect(getUnsupportedTranslation(FORMATS.OPENAI, FORMATS.KIRO, body)).toBeNull();
    expect(getUnsupportedTranslation(FORMATS.OPENAI, FORMATS.KIRO, body, { includeRemoteImages: true }))
      .toMatchObject({ caseId: "C-02", code: "remote_image_unresolved" });
  });

  it.each([
    ["C-03", FORMATS.CURSOR],
    ["C-04", FORMATS.COMMANDCODE],
  ])("rejects image input for %s", (caseId, target) => {
    expect(getUnsupportedTranslation(
      FORMATS.OPENAI,
      target,
      messageWith({ type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }),
    )).toMatchObject({ caseId, code: "image_input_unsupported" });
  });

  it("rejects unresolved Responses file references", () => {
    const body = { input: [{ type: "message", role: "user", content: [{ type: "input_image", file_id: "file-redacted" }] }] };
    expect(getUnsupportedTranslation(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, body))
      .toMatchObject({ caseId: "C-05", code: "file_reference_unresolved" });
  });

  it("rejects Claude encrypted-thinking continuity for OpenAI Chat", () => {
    expect(getUnsupportedTranslation(
      FORMATS.CLAUDE,
      FORMATS.OPENAI,
      messageWith({ type: "redacted_thinking", data: "redacted" }),
    )).toMatchObject({ caseId: "C-06", code: "encrypted_thinking_unsupported" });
  });

  it("does not reject a same-format request", () => {
    expect(getUnsupportedTranslation(FORMATS.OPENAI, FORMATS.OPENAI, messageWith({ type: "input_audio" }))).toBeNull();
  });

  it("exposes a machine-readable unsupported capability code", () => {
    expect(buildErrorBody(422, "unsupported", "audio_input_unsupported")).toEqual({
      error: {
        message: "unsupported",
        type: "invalid_request_error",
        code: "audio_input_unsupported",
      },
    });
  });
});
