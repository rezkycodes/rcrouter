import { describe, expect, it, vi } from "vitest";

import {
  createToolNameRestoreStream,
  restoreFittedToolNamesInResult,
  restoreToolNamesInPayload,
} from "../../open-sse/utils/toolNameRestore.js";

const ORIGINAL = `mcp__github__create_pull_request_review_${"x".repeat(40)}`;
const FITTED = "mcp__github__create_pull_request_rev_k3j9a1b2";
const OTHER_ORIGINAL = `mcp__jira__transition_issue_${"y".repeat(50)}`;
const OTHER_FITTED = "mcp__jira__transition_issue_yyyyyyyyyyyyy_z9z9z9z9";
const MAP = new Map([[FITTED, ORIGINAL], [OTHER_FITTED, OTHER_ORIGINAL]]);

const snapshot = (value) => JSON.parse(JSON.stringify(value));

describe("restoreToolNamesInPayload", () => {
  it("returns the same reference when there is nothing to restore", () => {
    const chunk = { choices: [{ delta: { content: `mentions ${FITTED} in prose` } }] };
    expect(restoreToolNamesInPayload(chunk, MAP)).toBe(chunk);
    expect(restoreToolNamesInPayload(chunk, null)).toBe(chunk);
    expect(restoreToolNamesInPayload(chunk, new Map())).toBe(chunk);
    expect(restoreToolNamesInPayload("str", MAP)).toBe("str");
    expect(restoreToolNamesInPayload(null, MAP)).toBeNull();
  });

  it("restores OpenAI streaming deltas and non-stream messages without mutating the input", () => {
    const chunk = {
      id: "c1",
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: FITTED, arguments: "" } }] } }],
    };
    const before = snapshot(chunk);
    const out = restoreToolNamesInPayload(chunk, MAP);
    expect(out.choices[0].delta.tool_calls[0].function.name).toBe(ORIGINAL);
    expect(out.choices[0].delta.tool_calls[0].id).toBe("call_1");
    expect(snapshot(chunk)).toEqual(before);

    const full = {
      choices: [{ message: { role: "assistant", content: null, tool_calls: [
        { id: "a", type: "function", function: { name: FITTED, arguments: "{}" } },
        { id: "b", type: "function", function: { name: "short", arguments: "{}" } },
      ] } }],
    };
    const restored = restoreToolNamesInPayload(full, MAP);
    expect(restored.choices[0].message.tool_calls.map((c) => c.function.name)).toEqual([ORIGINAL, "short"]);
  });

  it("restores Claude content_block_start, message content and non-stream bodies", () => {
    const start = { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "tu", name: FITTED, input: {} } };
    expect(restoreToolNamesInPayload(start, MAP).content_block.name).toBe(ORIGINAL);

    const message = { type: "message", role: "assistant", content: [
      { type: "text", text: "ok" },
      { type: "tool_use", id: "tu", name: OTHER_FITTED, input: {} },
    ] };
    const out = restoreToolNamesInPayload(message, MAP);
    expect(out.content[1].name).toBe(OTHER_ORIGINAL);
    expect(out.content[0]).toBe(message.content[0]);

    const started = { type: "message_start", message: { content: [{ type: "tool_use", name: FITTED }] } };
    expect(restoreToolNamesInPayload(started, MAP).message.content[0].name).toBe(ORIGINAL);
  });

  it("restores Responses API items, argument events and completed responses", () => {
    const added = { type: "response.output_item.added", item: { type: "function_call", call_id: "c", name: FITTED, arguments: "" } };
    expect(restoreToolNamesInPayload(added, MAP).item.name).toBe(ORIGINAL);

    const done = { type: "response.function_call_arguments.done", item_id: "i", name: FITTED, arguments: "{}" };
    expect(restoreToolNamesInPayload(done, MAP).name).toBe(ORIGINAL);

    const custom = { type: "response.output_item.done", item: { type: "custom_tool_call", name: OTHER_FITTED, input: "x" } };
    expect(restoreToolNamesInPayload(custom, MAP).item.name).toBe(OTHER_ORIGINAL);

    const completed = { type: "response.completed", response: { output: [
      { type: "message", role: "assistant", content: [] },
      { type: "function_call", call_id: "c", name: FITTED, arguments: "{}" },
    ] } };
    const restored = restoreToolNamesInPayload(completed, MAP);
    expect(restored.response.output[1].name).toBe(ORIGINAL);
    expect(restored.response.output[0]).toBe(completed.response.output[0]);

    const body = { object: "response", output: [{ type: "function_call", name: FITTED }] };
    expect(restoreToolNamesInPayload(body, MAP).output[0].name).toBe(ORIGINAL);

    const textEvent = { type: "response.output_text.delta", name: FITTED, delta: "hi" };
    expect(restoreToolNamesInPayload({ ...textEvent, type: "other.event" }, MAP).name).toBe(FITTED);
  });

  it("restores Gemini functionCall parts (plain and enveloped)", () => {
    const gemini = { candidates: [{ content: { role: "model", parts: [
      { text: "hi" }, { functionCall: { name: FITTED, args: {} } },
    ] } }] };
    const out = restoreToolNamesInPayload(gemini, MAP);
    expect(out.candidates[0].content.parts[1].functionCall.name).toBe(ORIGINAL);
    expect(out.candidates[0].content.parts[0]).toBe(gemini.candidates[0].content.parts[0]);

    const enveloped = { response: gemini };
    expect(restoreToolNamesInPayload(enveloped, MAP).response.candidates[0].content.parts[1].functionCall.name).toBe(ORIGINAL);
  });
});

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function pipeThrough(chunks, map = MAP, options) {
  const input = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
      controller.close();
    },
  });
  const reader = input.pipeThrough(createToolNameRestoreStream(map, options)).getReader();
  let out = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

const sse = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
const openaiChunk = (name) => sse({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: "" } }] } }] });

describe("createToolNameRestoreStream", () => {
  it("restores the original name in a streamed OpenAI response", async () => {
    const out = await pipeThrough([
      sse({ choices: [{ delta: { role: "assistant", content: "" } }] }),
      openaiChunk(FITTED),
      sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "{\"a\":1}" } }] } }] }),
      "data: [DONE]\n\n",
    ]);
    expect(out).toContain(ORIGINAL);
    expect(out).not.toContain(FITTED);
    expect(out.endsWith("data: [DONE]\n\n")).toBe(true);
  });

  it("is byte-identical for lines that carry no fitted name (events, keep-alives, [DONE])", async () => {
    const plain = [
      "event: message_start\n",
      `data: ${JSON.stringify({ type: "message_start", message: { id: "m" } })}\n\n`,
      ": keep-alive\n\n",
      `data: {"choices":[{"delta":{"content":"${FITTED} is just text"}}]}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    expect(await pipeThrough([plain])).toBe(plain);
  });

  it("handles chunk boundaries anywhere, including inside multibyte characters", async () => {
    const full = openaiChunk(FITTED) + sse({ choices: [{ delta: { content: "héllo 世界" } }] }) + "data: [DONE]\n\n";
    const bytes = encoder.encode(full);
    for (const size of [1, 2, 3, 7, 50]) {
      const chunks = [];
      for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.slice(i, i + size));
      const out = await pipeThrough(chunks);
      expect(out).toContain(ORIGINAL);
      expect(out).not.toContain(FITTED);
      expect(out).toContain("héllo 世界");
      expect(out.endsWith("data: [DONE]\n\n")).toBe(true);
    }
  });

  it("restores Claude and Responses SSE framing while keeping event lines intact", async () => {
    const claude = `event: content_block_start\n${sse({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "t", name: FITTED, input: {} } })}`;
    const responses = `event: response.output_item.added\n${sse({ type: "response.output_item.added", item: { type: "function_call", name: OTHER_FITTED } })}`;
    const out = await pipeThrough([claude, responses]);
    expect(out).toContain("event: content_block_start\n");
    expect(out).toContain("event: response.output_item.added\n");
    expect(out).toContain(ORIGINAL);
    expect(out).toContain(OTHER_ORIGINAL);
    expect(out).not.toContain(FITTED);
    expect(out).not.toContain(OTHER_FITTED);
  });

  it("flushes a trailing line that has no newline and preserves CRLF framing", async () => {
    const crlf = `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { name: FITTED } }] } }] })}\r\n\r\n`;
    const out = await pipeThrough([crlf]);
    expect(out).toContain(ORIGINAL);
    expect(out.endsWith("\r\n\r\n")).toBe(true);

    const tail = await pipeThrough([`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { name: FITTED } }] } }] })}`]);
    expect(tail).toContain(ORIGINAL);
  });

  it("fails open on a malformed JSON line that mentions a fitted name and reports it", async () => {
    const onError = vi.fn();
    const broken = `data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"${FITTED}"\n\n`;
    expect(await pipeThrough([broken], MAP, { onError })).toBe(broken);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

function jsonResult(payload, headers = { "Content-Type": "application/json" }) {
  return { success: true, response: new Response(JSON.stringify(payload), { status: 200, headers }) };
}

describe("restoreFittedToolNamesInResult", () => {
  it("returns the same result when there is no map, no response or an error result", async () => {
    const result = jsonResult({ ok: true });
    expect(await restoreFittedToolNamesInResult(result, null)).toBe(result);
    expect(await restoreFittedToolNamesInResult(result, new Map())).toBe(result);
    const failure = { success: false, status: 502, error: "x" };
    expect(await restoreFittedToolNamesInResult(failure, MAP)).toBe(failure);
    expect(await restoreFittedToolNamesInResult(undefined, MAP)).toBeUndefined();
  });

  it("restores a non-stream JSON body and keeps status and headers", async () => {
    const result = jsonResult({ choices: [{ message: { tool_calls: [{ function: { name: FITTED, arguments: "{}" } }] } }] },
      { "Content-Type": "application/json", "X-Test": "1" });
    const out = await restoreFittedToolNamesInResult(result, MAP);
    expect(out.success).toBe(true);
    expect(out.response.status).toBe(200);
    expect(out.response.headers.get("x-test")).toBe("1");
    const body = await out.response.json();
    expect(body.choices[0].message.tool_calls[0].function.name).toBe(ORIGINAL);
  });

  it("passes JSON through untouched (same text) when no tool name needs restoring", async () => {
    const text = JSON.stringify({ choices: [{ message: { content: "hi" } }] });
    const out = await restoreFittedToolNamesInResult({ success: true, response: new Response(text, { headers: { "Content-Type": "application/json" } }) }, MAP);
    expect(await out.response.text()).toBe(text);
  });

  it("keeps an unparseable JSON body intact and reports the problem", async () => {
    const onError = vi.fn();
    const result = { success: true, response: new Response("not json", { headers: { "Content-Type": "application/json" } }) };
    const out = await restoreFittedToolNamesInResult(result, MAP, { onError });
    expect(await out.response.text()).toBe("not json");
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it("restores an SSE response end to end (round trip with request fitting)", async () => {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(openaiChunk(FITTED)));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const result = { success: true, response: new Response(body, { headers: { "Content-Type": "text/event-stream" } }) };
    const out = await restoreFittedToolNamesInResult(result, MAP);
    expect(out.response.headers.get("content-type")).toBe("text/event-stream");
    const text = await out.response.text();
    expect(text).toContain(ORIGINAL);
    expect(text).not.toContain(FITTED);
  });

  it("ignores other content types", async () => {
    const result = { success: true, response: new Response("hello", { headers: { "Content-Type": "text/plain" } }) };
    expect(await restoreFittedToolNamesInResult(result, MAP)).toBe(result);
  });
});
