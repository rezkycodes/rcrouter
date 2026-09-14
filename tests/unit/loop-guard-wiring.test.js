import { describe, expect, it } from "vitest";

import { applyLoopGuard } from "../../open-sse/handlers/chatCore.js";
import { FORMATS } from "../../open-sse/translator/formats.js";

function makeLoopingBody() {
  const call = { function: { name: "bash", arguments: '{"cmd":"ls"}' } };
  return {
    messages: [
      { role: "user", content: "list" },
      { role: "assistant", content: "", tool_calls: [call] },
      { role: "tool", content: "file1" },
      { role: "assistant", content: "", tool_calls: [call] },
      { role: "tool", content: "file1" },
      { role: "assistant", content: "", tool_calls: [call] },
      { role: "tool", content: "file1" },
    ],
  };
}

describe("applyLoopGuard wiring", () => {
  it("injects a termination prompt and an idempotent router note", () => {
    const body = makeLoopingBody();
    expect(applyLoopGuard(body, FORMATS.OPENAI, "kimchi", "kimi-k2.6")).toBe(true);
    const first = body.messages.at(-1).content;
    expect(first).toContain("[ROUTER NOTE:");
    expect(first).toContain("STOP repeating");
    expect(body.messages.find((message) => message.role === "system")?.content)
      .toContain("STOP calling tools");

    expect(applyLoopGuard(body, FORMATS.OPENAI, "kimchi", "kimi-k2.6")).toBe(true);
    expect(body.messages.at(-1).content).toBe(first);
  });

  it("does not mutate a clean multimodal conversation", () => {
    const body = {
      messages: [
        { role: "user", content: [
          { type: "text", text: "describe this" },
          { type: "image_url", image_url: { url: "https://example.test/image.png" } },
        ] },
        { role: "assistant", content: [
          { type: "text", text: "The image shows a blue square." },
          { type: "image_url", image_url: { url: "https://example.test/image.png" } },
        ] },
      ],
    };
    expect(applyLoopGuard(body, FORMATS.OPENAI, "openai", "vision-model")).toBe(false);
    expect(JSON.stringify(body.messages)).not.toContain("[ROUTER NOTE:");
  });
});
