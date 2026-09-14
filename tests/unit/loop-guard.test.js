import { describe, expect, it } from "vitest";

import { detectLoop } from "../../open-sse/utils/loopGuard.js";

function tc(name, args) {
  return { type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function assistantWith(...toolCalls) {
  return { role: "assistant", content: "", tool_calls: toolCalls };
}

describe("detectLoop", () => {
  it("returns no detection for empty or ordinary history", () => {
    expect(detectLoop({ messages: [] })).toEqual({ detected: false, hint: null });
    expect(detectLoop({ messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ] })).toEqual({ detected: false, hint: null });
  });

  it("detects three identical tool calls", () => {
    expect(detectLoop({ messages: [
      assistantWith(tc("bash", { cmd: "ls" })),
      assistantWith(tc("bash", { cmd: "ls" })),
      assistantWith(tc("bash", { cmd: "ls" })),
    ] }).detected).toBe(true);
  });

  it("detects a repeated two-call sequence", () => {
    expect(detectLoop({ messages: [
      assistantWith(tc("fetchA", { url: "x" })),
      assistantWith(tc("fetchB", { url: "y" })),
      assistantWith(tc("fetchA", { url: "x" })),
      assistantWith(tc("fetchB", { url: "y" })),
    ] }).detected).toBe(true);
  });

  it("sorts nested arguments without collapsing distinct calls", () => {
    const body = { messages: [
      assistantWith({ function: { name: "read", arguments: { path: { file: "a" }, depth: 1 } } }),
      assistantWith({ function: { name: "read", arguments: { depth: 1, path: { file: "b" } } } }),
      assistantWith({ function: { name: "read", arguments: { path: { file: "c" }, depth: 1 } } }),
    ] };
    expect(detectLoop(body).detected).toBe(false);
  });

  it("does not treat multimodal assistant turns as text loops", () => {
    const body = { messages: [
      { role: "assistant", content: [
        { type: "text", text: "I will inspect the image" },
        { type: "image_url", image_url: { url: "data:image/png;base64,one" } },
      ] },
      { role: "assistant", content: [
        { type: "text", text: "I will inspect the image" },
        { type: "image_url", image_url: { url: "data:image/png;base64,two" } },
      ] },
      { role: "assistant", content: [
        { type: "text", text: "I will inspect the image" },
        { type: "image_url", image_url: { url: "data:image/png;base64,three" } },
      ] },
    ] };
    expect(detectLoop(body).detected).toBe(false);
  });

  it("detects repeated planning text but ignores varied progress", () => {
    const repeated = "I need to inspect the key files before answering.";
    expect(detectLoop({ messages: [
      { role: "assistant", content: repeated },
      { role: "assistant", content: repeated },
      { role: "assistant", content: repeated },
    ] }).detected).toBe(true);
    expect(detectLoop({ messages: [
      { role: "assistant", content: "I will inspect the package first." },
      { role: "assistant", content: "The package uses a streaming adapter." },
      { role: "assistant", content: "The adapter forwards tool results." },
    ] }).detected).toBe(false);
  });
});
