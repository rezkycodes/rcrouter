import { describe, expect, it } from "vitest";

import {
  detectLoop,
  detectSequenceRepeat,
  LOOP_GUARD_LIMITS,
} from "../../open-sse/utils/loopGuard.js";

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

describe("detectLoop hardening (bounded work)", () => {
  const distinctCalls = (size, prefix = "tool") =>
    Array.from({ length: size }, (_, i) => assistantWith(tc(`${prefix}${i}`, { n: i })));

  it("caps the detected repeat-sequence length at MAX_SEQUENCE_LENGTH", () => {
    expect(LOOP_GUARD_LIMITS.MAX_SEQUENCE_LENGTH).toBe(6);
    const seq = Array.from({ length: 20 }, (_, i) => `t${i % 10}::{}`);
    const pattern = detectSequenceRepeat(seq);
    expect(pattern).not.toBeNull();
    expect(pattern.split("|").length).toBeLessThanOrEqual(LOOP_GUARD_LIMITS.MAX_SEQUENCE_LENGTH);
  });

  it("still detects a real loop whose cycle is longer than the cap", () => {
    const cycle = distinctCalls(9);
    expect(detectLoop({ messages: [...cycle, ...cycle] }).detected).toBe(true);
  });

  it("does not flag a sequence that never repeats", () => {
    expect(detectSequenceRepeat(Array.from({ length: 12 }, (_, i) => `t${i}::{}`))).toBeNull();
  });

  it("only inspects the most recent tool calls", () => {
    const stale = Array.from({ length: 3 }, () => assistantWith(tc("old", { a: 1 })));
    const recent = distinctCalls(LOOP_GUARD_LIMITS.RECENT_TOOL_WINDOW + 5, "fresh");
    expect(detectLoop({ messages: [...stale, ...recent] }).detected).toBe(false);
  });

  it("de-duplicates sentences within a single message", () => {
    const sentence = "I need to inspect the key files before answering.";
    const stuttering = `${sentence} ${sentence} ${sentence} ${sentence}`;
    expect(detectLoop({ messages: [
      { role: "assistant", content: stuttering },
      { role: "assistant", content: "Second turn has different, genuinely new content." },
    ] }).detected).toBe(false);
    expect(detectLoop({ messages: [
      { role: "assistant", content: stuttering },
      { role: "assistant", content: `${sentence} Extra context one.` },
      { role: "assistant", content: `${sentence} Extra context two.` },
    ] }).detected).toBe(true);
  });

  it("skips sentence analysis for assistant texts larger than 4 KB", () => {
    expect(LOOP_GUARD_LIMITS.MAX_TEXT_SCAN_CHARS).toBe(4096);
    const sentence = "I need to inspect the key files before answering.";
    const padded = (tag) => `${sentence} ${`${tag} filler words `.repeat(300)}`;
    const big = (tag) => ({ role: "assistant", content: padded(tag) });
    expect(padded("a").length).toBeGreaterThan(LOOP_GUARD_LIMITS.MAX_TEXT_SCAN_CHARS);
    expect(detectLoop({ messages: [big("a"), big("b"), big("c")] }).detected).toBe(false);

    const small = (tag) => ({ role: "assistant", content: `${sentence} ${tag} short tail.` });
    expect(detectLoop({ messages: [small("a"), small("b"), small("c")] }).detected).toBe(true);
  });

  it("finishes in bounded time on very large histories", () => {
    const toolHeavy = distinctCalls(6000);
    const textHeavy = Array.from({ length: 300 }, (_, i) => ({
      role: "assistant",
      content: `unique block ${i} ${"x".repeat(200_000)}`,
    }));
    const started = Date.now();
    const result = detectLoop({ messages: [...textHeavy, ...toolHeavy] });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.detected).toBe(false);
  });

  it("fails open: internal errors never throw and are reported", () => {
    const hostile = { role: "assistant", get content() { throw new Error("boom"); } };
    const result = detectLoop({ messages: [hostile, hostile, hostile] });
    expect(result.detected).toBe(false);
    expect(result.hint).toBeNull();
    expect(result.error).toBe("boom");
  });
});
