import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: () => ({ noAuth: true, execute: executeMock }),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logProviderResponse: vi.fn(),
    logConvertedResponse: vi.fn(),
    logError: vi.fn(),
  }),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(async () => {}),
  saveRequestDetail: vi.fn(async () => {}),
  saveRequestUsage: vi.fn(async () => {}),
  saveUsageStats: vi.fn(async () => {}),
}));

const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");

const LONG_NAME = `mcp__github__create_pull_request_review_${"z".repeat(50)}`;
const UPSTREAM_LIMIT = 64;
const encoder = new TextEncoder();

function clientBody(stream) {
  return {
    model: "gpt-4o",
    stream,
    messages: [
      { role: "user", content: "review it" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_0", type: "function", function: { name: LONG_NAME, arguments: "{}" } }] },
      { role: "tool", tool_call_id: "call_0", content: "ok" },
      { role: "user", content: "again" },
    ],
    tools: [{ type: "function", function: { name: LONG_NAME, description: "x", parameters: { type: "object", properties: {} } } }],
    tool_choice: { type: "function", function: { name: LONG_NAME } },
  };
}

function run(body, provider = "openrouter", sourceFormatOverride = undefined) {
  return handleChatCore({
    body,
    sourceFormatOverride,
    modelInfo: { provider, model: "gpt-4o" },
    credentials: { apiKey: "test-key", providerSpecificData: {} },
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn() },
    connectionId: "conn-1",
    rtkEnabled: false,
    cavemanEnabled: false,
    ponytailEnabled: false,
    loopGuardEnabled: false,
    clientRawRequest: { endpoint: "/v1/chat/completions", body: {}, headers: { accept: "application/json" } },
  });
}

function sseResponse(lines) {
  const body = new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

const upstream = (response) => ({ response, url: "https://api.openai.com/v1/chat/completions", headers: {}, transformedBody: null });

describe("tool-name fitting through handleChatCore (OpenAI client -> OpenAI-compatible upstream)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends only fitted names upstream and restores the original in a JSON response", async () => {
    let sent;
    executeMock.mockImplementation(async ({ body }) => {
      sent = structuredClone(body);
      const fitted = body.tools[0].function.name;
      return upstream(new Response(JSON.stringify({
        id: "c1", object: "chat.completion",
        choices: [{ index: 0, finish_reason: "tool_calls", message: { role: "assistant", content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: fitted, arguments: "{}" } }] } }],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    });

    const result = await run(clientBody(false));
    expect(result.success).toBe(true);

    const fitted = sent.tools[0].function.name;
    expect(fitted).not.toBe(LONG_NAME);
    expect(fitted.length).toBeLessThanOrEqual(UPSTREAM_LIMIT);
    expect(sent.tool_choice.function.name).toBe(fitted);
    expect(sent.messages[1].tool_calls[0].function.name).toBe(fitted);
    expect(JSON.stringify(sent)).not.toContain(LONG_NAME);
    expect(Object.keys(sent)).not.toContain("_fittedToolNames");

    const json = await result.response.json();
    expect(json.choices[0].message.tool_calls[0].function.name).toBe(LONG_NAME);
  });

  it("restores the original name in a streamed response", async () => {
    executeMock.mockImplementation(async ({ body }) => {
      const fitted = body.tools[0].function.name;
      const chunk = (delta, finish = null) => `data: ${JSON.stringify({
        id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt-4o",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
      return upstream(sseResponse([
        chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: fitted, arguments: "" } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: "{\"pr\":1}" } }] }),
        chunk({}, "tool_calls"),
        "data: [DONE]\n\n",
      ]));
    });

    const result = await run(clientBody(true));
    expect(result.success).toBe(true);
    const text = await result.response.text();
    expect(text).toContain(LONG_NAME);
    expect(text).toContain("{\\\"pr\\\":1}");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    const names = [...text.matchAll(/"name":"([^"]+)"/g)].map((m) => m[1]);
    expect(names).toEqual([LONG_NAME]);
  });

  it("leaves requests with short names completely untouched", async () => {
    let sent;
    executeMock.mockImplementation(async ({ body }) => {
      sent = structuredClone(body);
      return upstream(new Response(JSON.stringify({ id: "c", object: "chat.completion",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "hi" } }] }),
      { status: 200, headers: { "content-type": "application/json" } }));
    });
    const body = clientBody(false);
    body.tools[0].function.name = "short_tool";
    body.tool_choice.function.name = "short_tool";
    body.messages[1].tool_calls[0].function.name = "short_tool";
    const result = await run(body);
    expect(sent.tools[0].function.name).toBe("short_tool");
    expect(sent.messages[1].tool_calls[0].function.name).toBe("short_tool");
    expect((await result.response.json()).choices[0].message.content).toBe("hi");
  });

  it("restores the original name when a force-stream provider is collapsed to JSON for the client", async () => {
    executeMock.mockImplementation(async ({ body }) => {
      const fitted = body.tools[0].function.name;
      const chunk = (delta, finish = null) => `data: ${JSON.stringify({
        id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt-4o",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
      return upstream(sseResponse([
        chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: fitted, arguments: "{}" } }] }),
        chunk({}, "tool_calls"),
        "data: [DONE]\n\n",
      ]));
    });

    const result = await run(clientBody(false), "openai");
    expect(result.success).toBe(true);
    const json = await result.response.json();
    expect(json.choices[0].message.tool_calls[0].function.name).toBe(LONG_NAME);
  });
});

const openaiToolStream = (fitted) => {
  const chunk = (delta, finish = null) => `data: ${JSON.stringify({
    id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt-4o",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;
  return sseResponse([
    chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: fitted, arguments: "" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: "{\"pr\":1}" } }] }),
    chunk({}, "tool_calls"),
    "data: [DONE]\n\n",
  ]);
};

describe("tool-name fitting for other client formats", () => {
  beforeEach(() => vi.clearAllMocks());

  it("Claude client -> OpenAI upstream: fits tool_use history and restores names in Claude SSE", async () => {
    let sent;
    executeMock.mockImplementation(async ({ body }) => {
      sent = structuredClone(body);
      return upstream(openaiToolStream(body.tools[0].function.name));
    });
    const body = {
      model: "gpt-4o",
      stream: true,
      max_tokens: 64,
      tools: [{ name: LONG_NAME, description: "x", input_schema: { type: "object", properties: {} } }],
      messages: [
        { role: "user", content: "review it" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: LONG_NAME, input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "ok" }] },
      ],
    };
    const result = await run(body, "openrouter", "claude");
    expect(result.success).toBe(true);

    const fitted = sent.tools[0].function.name;
    expect(fitted).not.toBe(LONG_NAME);
    expect(fitted.length).toBeLessThanOrEqual(UPSTREAM_LIMIT);
    expect(JSON.stringify(sent)).not.toContain(LONG_NAME);

    const text = await result.response.text();
    expect(text).toContain("content_block_start");
    expect(text).toContain(`"name":"${LONG_NAME}"`);
    expect(text).not.toContain(fitted);
  });

  it("Responses client -> OpenAI upstream: fits function_call history and restores names in Responses SSE", async () => {
    let sent;
    executeMock.mockImplementation(async ({ body }) => {
      sent = structuredClone(body);
      return upstream(openaiToolStream(body.tools[0].function.name));
    });
    const body = {
      model: "gpt-4o",
      stream: true,
      tools: [{ type: "function", name: LONG_NAME, description: "x", parameters: { type: "object", properties: {} } }],
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "review it" }] },
        { type: "function_call", call_id: "call_0", name: LONG_NAME, arguments: "{}" },
        { type: "function_call_output", call_id: "call_0", output: "ok" },
      ],
    };
    const result = await run(body, "openrouter", "openai-responses");
    expect(result.success).toBe(true);

    const fitted = sent.tools[0].function.name;
    expect(fitted).not.toBe(LONG_NAME);
    expect(fitted.length).toBeLessThanOrEqual(UPSTREAM_LIMIT);
    expect(JSON.stringify(sent)).not.toContain(LONG_NAME);

    const text = await result.response.text();
    expect(text).toContain("response.output_item.added");
    expect(text).toContain(LONG_NAME);
    expect(text).not.toContain(fitted);
  });
});
