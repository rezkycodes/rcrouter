import { describe, expect, it } from "vitest";

import { __test__, __testPayload__ } from "../../open-sse/utils/requestLogger.js";

describe("request logger header redaction", () => {
  it("redacts bearer, API-key, cookie, and session headers", () => {
    const headers = __test__.maskSensitiveHeaders({
      Authorization: "Bearer upstream-secret-token",
      "x-api-key": "router-client-key",
      Cookie: "session=private-cookie",
      "x-session-id": "private-session-id",
      "user-agent": "test-client",
    });

    expect(headers).toEqual({
      Authorization: "Bearer <redacted>",
      "x-api-key": "<redacted>",
      Cookie: "<redacted>",
      "x-session-id": "<redacted>",
      "user-agent": "test-client",
    });
    expect(JSON.stringify(headers)).not.toContain("upstream-secret-token");
    expect(JSON.stringify(headers)).not.toContain("private-session-id");
  });

  it("normalizes Headers instances before redaction", () => {
    const headers = __test__.maskSensitiveHeaders(new Headers({
      Authorization: "Token secret",
      "content-type": "application/json",
    }));
    expect(headers).toEqual({
      authorization: "Token <redacted>",
      "content-type": "application/json",
    });
  });

  it("redacts session and media payloads while preserving ordinary text", () => {
    const sanitized = __testPayload__.sanitizeLogPayload({
      metadata: { user_id: "private-session" },
      user: "private-session-user",
      messages: [{ role: "user", content: [
        { type: "text", text: "keep this prompt" },
        { type: "image_url", image_url: { url: "https://private.test/image.png" } },
      ] }],
      options: { api_key: "private-key", max_tokens: 50 },
    });

    expect(sanitized.metadata.user_id).toBe("<redacted>");
    expect(sanitized.user).toBe("<redacted>");
    expect(sanitized.messages[0].content).toEqual([
      { type: "text", text: "keep this prompt" },
      { type: "image_url", redacted: true },
    ]);
    expect(sanitized.options).toEqual({ api_key: "<redacted>", max_tokens: 50 });
    expect(JSON.stringify(sanitized)).not.toContain("private-session");
    expect(JSON.stringify(sanitized)).not.toContain("private.test");
  });

  it("redacts credential query parameters and inline auth text", () => {
    expect(__testPayload__.sanitizeLogUrl("https://provider.test/v1?key=private&model=test"))
      .toBe("https://provider.test/v1?key=%3Credacted%3E&model=test");
    expect(__testPayload__.sanitizeLogText("upstream returned Bearer private-token"))
      .toBe("upstream returned Bearer <redacted>");
  });
});
