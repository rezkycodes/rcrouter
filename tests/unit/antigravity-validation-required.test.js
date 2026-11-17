// Antigravity 403 VALIDATION_REQUIRED (Google asks the account owner to verify
// in a browser) used to fall through to the generic 403 rule: a 2-minute
// cooldown. The account re-entered rotation while still unverified, burned
// another fallback slot, and the request died on the attempt limit. Ported from
// VansRouter, which saw this live: "fallback attempt limit reached (6)".
import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock("../../open-sse/services/usage/shared.js", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchWithTimeout: fetchMock,
}));

import { checkFallbackError } from "../../open-sse/services/accountFallback.js";
import { getAntigravityUsage } from "../../open-sse/services/usage/google.js";

const googleBody = JSON.stringify({
  error: {
    code: 403,
    status: "PERMISSION_DENIED",
    details: [{
      "@type": "type.googleapis.com/google.rpc.ErrorInfo",
      reason: "VALIDATION_REQUIRED",
      domain: "cloudcode-pa.googleapis.com",
      metadata: { validation_url: "https://accounts.google.com/signin/continue?..." },
    }],
  },
});

const TWO_MINUTES = 2 * 60 * 1000;
const ONE_DAY = 24 * 60 * 60 * 1000;

describe("antigravity VALIDATION_REQUIRED cooldown", () => {
  it("holds the account out for a day, far beyond the generic 403 rule", () => {
    const { shouldFallback, cooldownMs } = checkFallbackError(403, googleBody, 0);
    expect(shouldFallback).toBe(true);
    expect(cooldownMs).toBe(ONE_DAY);
  });

  it("also recognises the plain-text 'verify your account' wording", () => {
    const { shouldFallback, cooldownMs } = checkFallbackError(403, "Please verify your account to continue", 0);
    expect(shouldFallback).toBe(true);
    expect(cooldownMs).toBe(ONE_DAY);
  });

  it("does not change a plain 403 with no validation reason", () => {
    expect(checkFallbackError(403, '{"error":{"code":403}}', 0).cooldownMs).toBe(TWO_MINUTES);
  });

  it("does not change 429 quota handling", () => {
    const quota = checkFallbackError(429, '{"error":{"message":"quota exceeded"}}', 0);
    expect(quota.shouldFallback).toBe(true);
    expect(quota.cooldownMs).toBeLessThanOrEqual(4 * 60 * 1000);
  });
});

describe("antigravity quota probe on 403", () => {
  beforeEach(() => fetchMock.mockReset());

  // The probe makes a subscription lookup first and the quota call second.
  const answerQuotaWith = (quotaResponse) => {
    fetchMock.mockImplementation(async (url) => (String(url).includes("loadCodeAssist")
      ? new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } })
      : quotaResponse()));
  };

  it("reports an account Google marked ineligible instead of claiming chat may still work", async () => {
    answerQuotaWith(() => new Response(googleBody, { status: 403 }));

    const usage = await getAntigravityUsage("token", {});

    expect(usage.ineligible).toBe(true);
    expect(usage.message).toMatch(/VALIDATION_REQUIRED/);
    expect(usage.message).not.toMatch(/may still work/i);
    expect(usage.quotas).toEqual({});
  });

  it("keeps the old wording for a plain 403 on the quota endpoint", async () => {
    answerQuotaWith(() => new Response('{"error":{"code":403}}', { status: 403 }));

    const usage = await getAntigravityUsage("token", {});

    expect(usage.ineligible).toBe(false);
    expect(usage.message).toMatch(/Chat may still work/);
  });
});
