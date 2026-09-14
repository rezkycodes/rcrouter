import { describe, expect, it } from "vitest";

import { __test__ } from "../../open-sse/utils/requestLogger.js";

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
});
