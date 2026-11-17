import { describe, expect, it } from "vitest";

import { FORMATS } from "../../open-sse/translator/formats.js";
import { translateRequest } from "../../open-sse/translator/index.js";
import { fitToolNames, getFittedToolNames } from "../../open-sse/translator/concerns/toolNameFit.js";

const repeatTo = (seed, len) => (seed + "x".repeat(len)).slice(0, len);
const LONG_70 = repeatTo("mcp__github__create_pull_request_review_", 70);
const LONG_100 = repeatTo("mcp__github__create_pull_request_review_", 100);
const LONG_150 = repeatTo("mcp__github__create_pull_request_review_", 150);

const openaiBody = (name) => ({
  model: "gpt-4o",
  messages: [
    { role: "user", content: "go" },
    { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name, arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "ok" },
  ],
  tools: [{ type: "function", function: { name, description: "d", parameters: { type: "object", properties: {} } } }],
});

const clone = (value) => structuredClone(value);
const translate = (source, target, body, provider) =>
  translateRequest(source, target, "model-x", clone(body), true, null, provider);

describe("translateRequest tool-name fitting", () => {
  it("fits for a 64-char upstream and exposes the reverse map without leaking it into the body", () => {
    const out = translate(FORMATS.OPENAI, FORMATS.OPENAI, openaiBody(LONG_70), "openrouter");
    const fitted = out.tools[0].function.name;
    expect(fitted.length).toBeLessThanOrEqual(64);
    expect(out.messages[1].tool_calls[0].function.name).toBe(fitted);

    const map = getFittedToolNames(out);
    expect(map).toEqual(new Map([[fitted, LONG_70]]));
    expect(Object.keys(out)).not.toContain("_fittedToolNames");
    expect(JSON.stringify(out)).not.toContain("_fittedToolNames");
    expect({ ...out }._fittedToolNames).toBeUndefined();
  });

  it("is a no-op for names that already fit: no reverse map and no body change", () => {
    const body = openaiBody("get_weather");
    const out = translate(FORMATS.OPENAI, FORMATS.OPENAI, body, "openrouter");
    expect(getFittedToolNames(out)).toBeUndefined();
    expect(out.tools[0].function.name).toBe("get_weather");
    expect(fitToolNames(body, 64).body).toBe(body);
  });

  it("translating an over-long body equals translating the pre-fitted body (pipeline-equivalent)", () => {
    const body = openaiBody(LONG_100);
    const { body: prefitted } = fitToolNames(clone(body), 64);
    const viaPipeline = translate(FORMATS.OPENAI, FORMATS.GEMINI, body, "gemini");
    const viaPrefit = translate(FORMATS.OPENAI, FORMATS.GEMINI, prefitted, "gemini");
    expect(JSON.stringify(viaPipeline)).toBe(JSON.stringify(viaPrefit));
  });

  it("Gemini targets receive declarations and history calls with fitted names (<= 64)", () => {
    const out = translate(FORMATS.OPENAI, FORMATS.GEMINI, openaiBody(LONG_100), "gemini");
    const declared = out.tools[0].functionDeclarations[0].name;
    expect(declared.length).toBeLessThanOrEqual(64);
    const call = out.contents.flatMap((c) => c.parts).find((p) => p.functionCall)?.functionCall.name;
    expect(call).toBe(declared);
    expect(getFittedToolNames(out)?.get(declared)).toBe(LONG_100);
  });

  it("Claude targets keep 65-128 char names untouched and only fit beyond 128", () => {
    const mid = translate(FORMATS.OPENAI, FORMATS.CLAUDE, openaiBody(LONG_100), "claude");
    expect(mid.tools[0].name).toBe(LONG_100);
    expect(getFittedToolNames(mid)).toBeUndefined();

    const huge = translate(FORMATS.OPENAI, FORMATS.CLAUDE, openaiBody(LONG_150), "claude");
    expect(huge.tools[0].name.length).toBeLessThanOrEqual(128);
    expect(getFittedToolNames(huge)?.get(huge.tools[0].name)).toBe(LONG_150);
  });

  it("Responses targets keep 65-128 char names untouched", () => {
    const out = translate(FORMATS.OPENAI, FORMATS.OPENAI_RESPONSES, openaiBody(LONG_100), "codex");
    expect(out.tools[0].name).toBe(LONG_100);
    expect(getFittedToolNames(out)).toBeUndefined();
  });

  it("Claude client -> OpenAI target fits tools and tool_use history together", () => {
    const body = {
      model: "claude-x",
      max_tokens: 100,
      tools: [{ name: LONG_100, description: "d", input_schema: { type: "object", properties: {} } }],
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: LONG_100, input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
      ],
    };
    const out = translate(FORMATS.CLAUDE, FORMATS.OPENAI, body, "openrouter");
    const fitted = out.tools[0].function.name;
    expect(fitted.length).toBeLessThanOrEqual(64);
    expect(out.messages.find((m) => m.tool_calls)?.tool_calls[0].function.name).toBe(fitted);
    expect(getFittedToolNames(out)?.get(fitted)).toBe(LONG_100);
  });

  it("Responses client -> OpenAI target fits tools and function_call input items", () => {
    const body = {
      model: "gpt-x",
      tools: [{ type: "function", name: LONG_100, description: "d", parameters: { type: "object", properties: {} } }],
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
        { type: "function_call", call_id: "call_1", name: LONG_100, arguments: "{}" },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
      ],
    };
    const out = translate(FORMATS.OPENAI_RESPONSES, FORMATS.OPENAI, body, "openrouter");
    const fitted = out.tools[0].function.name;
    expect(fitted.length).toBeLessThanOrEqual(64);
    expect(out.messages.find((m) => m.tool_calls)?.tool_calls[0].function.name).toBe(fitted);
    expect(getFittedToolNames(out)?.get(fitted)).toBe(LONG_100);
  });

  it("does not mutate the caller's body when fitting is needed", () => {
    const body = openaiBody(LONG_100);
    const before = JSON.stringify(body);
    translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, "m", body, true, null, "openrouter");
    expect(body.tools[0].function.name).toBe(LONG_100);
    expect(JSON.stringify(body.tools)).toBe(JSON.stringify(JSON.parse(before).tools));
  });
});
