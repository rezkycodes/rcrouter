import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import {
  DEFAULT_TOOL_NAME_MAX_LENGTH,
  MIN_TOOL_NAME_MAX_LENGTH,
  resolveToolNameMaxLength,
} from "../../open-sse/config/toolNameLimits.js";
import { fitToolNames } from "../../open-sse/translator/concerns/toolNameFit.js";

const LIMIT = DEFAULT_TOOL_NAME_MAX_LENGTH;
// Built to length so cases cannot silently stop being over the limit.
const repeatTo = (seed, len) => (seed + "x".repeat(len)).slice(0, len);
const LONG_A = repeatTo("mcp__github__create_pull_request_review_alpha_", 80);
const LONG_B = repeatTo("mcp__github__create_pull_request_review_alpha_", 90);
const VALID_NAME = /^[a-zA-Z0-9_-]+$/;

const snapshot = (value) => JSON.parse(JSON.stringify(value));

function openaiBody(names = [LONG_A]) {
  return {
    model: "x",
    messages: [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: null,
        tool_calls: names.map((name, i) => ({
          id: `call_${i}`, type: "function", function: { name, arguments: "{}" },
        })),
      },
      ...names.map((name, i) => ({ role: "tool", tool_call_id: `call_${i}`, name, content: "ok" })),
    ],
    tools: names.map((name) => ({ type: "function", function: { name, parameters: {} } })),
    tool_choice: { type: "function", function: { name: names[0] } },
  };
}

describe("resolveToolNameMaxLength", () => {
  it("defaults to 64 and is wider for Claude / Responses / Codex targets", () => {
    expect(resolveToolNameMaxLength(FORMATS.OPENAI)).toBe(64);
    expect(resolveToolNameMaxLength(FORMATS.GEMINI)).toBe(64);
    expect(resolveToolNameMaxLength(FORMATS.KIRO)).toBe(64);
    expect(resolveToolNameMaxLength(FORMATS.CLAUDE)).toBe(128);
    expect(resolveToolNameMaxLength(FORMATS.OPENAI_RESPONSES)).toBe(128);
    expect(resolveToolNameMaxLength(FORMATS.CODEX)).toBe(128);
    expect(resolveToolNameMaxLength(null)).toBe(64);
  });

  it("honors a valid provider quirk override and ignores unusable ones", () => {
    expect(resolveToolNameMaxLength(FORMATS.OPENAI, { toolNameMaxLength: 48 })).toBe(48);
    expect(resolveToolNameMaxLength(FORMATS.CLAUDE, { toolNameMaxLength: 64 })).toBe(64);
    for (const bad of [0, -5, 3, MIN_TOOL_NAME_MAX_LENGTH - 1, 12.5, "64", null, NaN]) {
      expect(resolveToolNameMaxLength(FORMATS.OPENAI, { toolNameMaxLength: bad })).toBe(64);
    }
  });
});

describe("fitToolNames - no-op", () => {
  it("returns the very same body when every name already fits", () => {
    const body = openaiBody(["get_weather", repeatTo("a", LIMIT)]);
    const before = JSON.stringify(body);
    const { body: out, restoreMap } = fitToolNames(body, LIMIT);
    expect(out).toBe(body);
    expect(restoreMap).toBeNull();
    expect(JSON.stringify(out)).toBe(before);
  });

  it("tolerates bodies without tools, non-objects and malformed fields", () => {
    for (const value of [null, undefined, "str", 42, {}, { tools: "nope", messages: 5, input: {} }]) {
      const { body, restoreMap } = fitToolNames(value, LIMIT);
      expect(body).toBe(value);
      expect(restoreMap).toBeNull();
    }
    const odd = { tools: [null, 3, {}, { function: null }], messages: [null, "x", { role: "tool", name: 5 }] };
    expect(fitToolNames(odd, LIMIT).body).toBe(odd);
  });
});

describe("fitToolNames - OpenAI chat shape", () => {
  it("shortens tools, tool_choice, history tool_calls and tool-message names consistently", () => {
    const body = openaiBody([LONG_A]);
    const before = snapshot(body);
    const { body: out, restoreMap } = fitToolNames(body, LIMIT);

    const fitted = out.tools[0].function.name;
    expect(fitted).not.toBe(LONG_A);
    expect(fitted.length).toBeLessThanOrEqual(LIMIT);
    expect(fitted).toMatch(VALID_NAME);
    expect(LONG_A.startsWith(fitted.slice(0, 20))).toBe(true);

    expect(out.tool_choice.function.name).toBe(fitted);
    expect(out.messages[1].tool_calls[0].function.name).toBe(fitted);
    expect(out.messages[2].name).toBe(fitted);

    expect(restoreMap).toEqual(new Map([[fitted, LONG_A]]));
    // Input is never mutated and untouched branches are shared, not copied.
    expect(snapshot(body)).toEqual(before);
    expect(out).not.toBe(body);
    expect(out.messages[0]).toBe(body.messages[0]);
  });

  it("is deterministic across calls and independent of tool order", () => {
    const one = fitToolNames(openaiBody([LONG_A, LONG_B]), LIMIT);
    const two = fitToolNames(openaiBody([LONG_A, LONG_B]), LIMIT);
    expect(two.body).toEqual(one.body);

    const reordered = fitToolNames(openaiBody([LONG_B, LONG_A]), LIMIT);
    const originalToFitted = (map) => new Map([...map].map(([fitted, original]) => [original, fitted]));
    expect(originalToFitted(reordered.restoreMap)).toEqual(originalToFitted(one.restoreMap));
  });

  it("keeps two long names sharing a 64-char prefix distinct (no plain truncation)", () => {
    const shared = repeatTo("mcp__server__a_very_long_shared_prefix_", LIMIT);
    const a = `${shared}alpha`;
    const b = `${shared}beta`;
    expect(a.slice(0, LIMIT)).toBe(b.slice(0, LIMIT));

    const { body, restoreMap } = fitToolNames(openaiBody([a, b]), LIMIT);
    const [fa, fb] = body.tools.map((t) => t.function.name);
    expect(fa).not.toBe(fb);
    expect(fa.length).toBeLessThanOrEqual(LIMIT);
    expect(fb.length).toBeLessThanOrEqual(LIMIT);
    expect(restoreMap.get(fa)).toBe(a);
    expect(restoreMap.get(fb)).toBe(b);
  });

  it("never reuses the name of an existing short tool (collision with a declared name)", () => {
    const first = fitToolNames(openaiBody([LONG_A]), LIMIT).body.tools[0].function.name;
    // A client that happens to declare a tool literally named like our fitted name.
    const body = openaiBody([LONG_A, first]);
    const { body: out, restoreMap } = fitToolNames(body, LIMIT);
    const names = out.tools.map((t) => t.function.name);
    expect(new Set(names).size).toBe(2);
    expect(names[1]).toBe(first);
    expect(names[0]).not.toBe(first);
    expect(names[0].length).toBeLessThanOrEqual(LIMIT);
    expect(restoreMap.get(names[0])).toBe(LONG_A);
    expect(restoreMap.has(first)).toBe(false);
  });

  it("fits a long name that appears only in history (tool no longer declared)", () => {
    const declared = fitToolNames(openaiBody([LONG_A]), LIMIT).body.tools[0].function.name;
    const body = openaiBody([LONG_A]);
    body.tools = [];
    const { body: out } = fitToolNames(body, LIMIT);
    expect(out.messages[1].tool_calls[0].function.name).toBe(declared);
  });

  it("does not cut a surrogate pair in half", () => {
    const name = `${"a".repeat(LIMIT - 10)}😀😀😀😀😀😀`;
    const { restoreMap } = fitToolNames(openaiBody([name]), LIMIT);
    const [fitted] = restoreMap.keys();
    expect(fitted.length).toBeLessThanOrEqual(LIMIT);
    expect(fitted).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(fitted).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
});

describe("fitToolNames - Claude shape", () => {
  it("shortens tools[].name, tool_choice and tool_use history blocks", () => {
    const body = {
      model: "x",
      tools: [{ name: LONG_A, input_schema: { type: "object" } }, { name: "short", input_schema: { type: "object" } }],
      tool_choice: { type: "tool", name: LONG_A },
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "tu_1", name: LONG_A, input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: "done" }] },
      ],
    };
    const before = snapshot(body);
    const { body: out, restoreMap } = fitToolNames(body, LIMIT);
    const fitted = out.tools[0].name;
    expect(fitted.length).toBeLessThanOrEqual(LIMIT);
    expect(out.tools[1].name).toBe("short");
    expect(out.tool_choice).toEqual({ type: "tool", name: fitted });
    expect(out.messages[1].content[1].name).toBe(fitted);
    expect(out.messages[1].content[0]).toBe(body.messages[1].content[0]);
    expect(out.messages[2]).toBe(body.messages[2]);
    expect(restoreMap.get(fitted)).toBe(LONG_A);
    expect(snapshot(body)).toEqual(before);
  });

  it("leaves 65-128 char names alone when the limit is 128 (Claude target)", () => {
    const mid = repeatTo("mcp__mid_", 100);
    const body = { tools: [{ name: mid, input_schema: { type: "object" } }] };
    const { body: out, restoreMap } = fitToolNames(body, resolveToolNameMaxLength(FORMATS.CLAUDE));
    expect(out).toBe(body);
    expect(restoreMap).toBeNull();
  });
});

describe("fitToolNames - Responses shape", () => {
  it("shortens flat tools, tool_choice, allowed_tools and function_call / custom_tool_call input items", () => {
    const body = {
      model: "x",
      tools: [
        { type: "function", name: LONG_A, parameters: {} },
        { type: "custom", name: LONG_B },
        { type: "web_search" },
      ],
      tool_choice: { type: "function", name: LONG_A },
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
        { type: "function_call", call_id: "c1", name: LONG_A, arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "ok" },
        { type: "custom_tool_call", call_id: "c2", name: LONG_B, input: "x" },
      ],
    };
    const before = snapshot(body);
    const { body: out, restoreMap } = fitToolNames(body, LIMIT);
    const fa = out.tools[0].name;
    const fb = out.tools[1].name;
    expect(fa).not.toBe(fb);
    expect(out.tools[2]).toEqual({ type: "web_search" });
    expect(out.tool_choice).toEqual({ type: "function", name: fa });
    expect(out.input[1].name).toBe(fa);
    expect(out.input[2]).toBe(body.input[2]);
    expect(out.input[3].name).toBe(fb);
    expect(restoreMap.size).toBe(2);
    expect(snapshot(body)).toEqual(before);

    const allowed = fitToolNames(
      { tools: body.tools, tool_choice: { type: "allowed_tools", mode: "auto", tools: [{ type: "function", name: LONG_B }] } },
      LIMIT,
    ).body;
    expect(allowed.tool_choice.tools[0].name).toBe(fb);
  });
});
