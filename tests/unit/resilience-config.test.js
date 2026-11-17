import { describe, expect, it } from "vitest";

import { mergeWithDefaults } from "../../src/lib/db/repos/settingsRepo.js";
import {
  COOLDOWN_RETRY,
  MAX_FALLBACK_ATTEMPTS_CAP,
  RESILIENCE_SETTING_DEFAULTS,
  SSE_KEEPALIVE,
  STREAM_READINESS,
  resolveBoolean,
  resolveBoundedMs,
  resolveCooldownRetryConfig,
  resolveStreamReadinessTimeoutMs,
} from "../../open-sse/config/resilienceConfig.js";

describe("resolveBoundedMs", () => {
  const opts = { min: 10, max: 100, fallback: 50 };

  it("returns in-range numbers unchanged", () => {
    expect(resolveBoundedMs(70, opts)).toBe(70);
  });

  it("clamps out-of-range numbers to the bounds", () => {
    expect(resolveBoundedMs(5, opts)).toBe(10);
    expect(resolveBoundedMs(1_000, opts)).toBe(100);
  });

  it("accepts numeric strings (settings UIs often store strings)", () => {
    expect(resolveBoundedMs("70", opts)).toBe(70);
    expect(resolveBoundedMs(" 70 ", opts)).toBe(70);
  });

  it("falls back for anything that is not a finite number", () => {
    for (const bad of [undefined, null, NaN, Infinity, "abc", "", "  ", {}, [], true, false]) {
      expect(resolveBoundedMs(bad, opts)).toBe(50);
    }
  });

  it("floors fractional values", () => {
    expect(resolveBoundedMs(70.9, opts)).toBe(70);
  });
});

describe("resolveBoolean", () => {
  it("keeps booleans and recognises common string/number spellings", () => {
    expect(resolveBoolean(true, false)).toBe(true);
    expect(resolveBoolean(false, true)).toBe(false);
    expect(resolveBoolean("false", true)).toBe(false);
    expect(resolveBoolean("0", true)).toBe(false);
    expect(resolveBoolean(0, true)).toBe(false);
    expect(resolveBoolean("TRUE", false)).toBe(true);
    expect(resolveBoolean(1, false)).toBe(true);
  });

  it("falls back on anything unrecognised", () => {
    expect(resolveBoolean(undefined, true)).toBe(true);
    expect(resolveBoolean(null, false)).toBe(false);
    expect(resolveBoolean("maybe", true)).toBe(true);
  });
});

describe("resolveCooldownRetryConfig", () => {
  it("defaults to enabled with a 30s wait bound", () => {
    expect(resolveCooldownRetryConfig({})).toEqual({ enabled: true, maxWaitMs: 30_000 });
    expect(resolveCooldownRetryConfig(undefined)).toEqual({ enabled: true, maxWaitMs: 30_000 });
  });

  it("honours explicit settings", () => {
    expect(resolveCooldownRetryConfig({ cooldownRetryEnabled: false, cooldownRetryMaxWaitMs: 5_000 }))
      .toEqual({ enabled: false, maxWaitMs: 5_000 });
  });

  it("clamps the wait bound to 0..60000", () => {
    expect(resolveCooldownRetryConfig({ cooldownRetryMaxWaitMs: 999_999 }).maxWaitMs).toBe(60_000);
    expect(resolveCooldownRetryConfig({ cooldownRetryMaxWaitMs: -10 }).maxWaitMs).toBe(0);
    expect(resolveCooldownRetryConfig({ cooldownRetryMaxWaitMs: 0 }).maxWaitMs).toBe(0);
  });

  it("treats an invalid wait bound as the default", () => {
    expect(resolveCooldownRetryConfig({ cooldownRetryMaxWaitMs: "soon" }).maxWaitMs).toBe(30_000);
    expect(resolveCooldownRetryConfig({ cooldownRetryMaxWaitMs: null }).maxWaitMs).toBe(30_000);
  });
});

describe("resolveStreamReadinessTimeoutMs", () => {
  it("defaults to 25s", () => {
    expect(resolveStreamReadinessTimeoutMs(undefined)).toBe(25_000);
  });

  it("clamps to 1000..120000", () => {
    expect(resolveStreamReadinessTimeoutMs(10)).toBe(1_000);
    expect(resolveStreamReadinessTimeoutMs(10_000_000)).toBe(120_000);
    expect(resolveStreamReadinessTimeoutMs(40_000)).toBe(40_000);
  });

  it("treats invalid input as the default", () => {
    expect(resolveStreamReadinessTimeoutMs("nope")).toBe(25_000);
    expect(resolveStreamReadinessTimeoutMs(NaN)).toBe(25_000);
  });
});

describe("resilience constants", () => {
  it("pins the approved defaults", () => {
    expect(COOLDOWN_RETRY.DEFAULT_MAX_WAIT_MS).toBe(30_000);
    expect(COOLDOWN_RETRY.MAX_RETRIES).toBe(1);
    expect(STREAM_READINESS.DEFAULT_TIMEOUT_MS).toBe(25_000);
    expect(SSE_KEEPALIVE.INTERVAL_MS).toBe(15_000);
    expect(SSE_KEEPALIVE.COMMENT).toBe(": keep-alive\n\n");
    expect(MAX_FALLBACK_ATTEMPTS_CAP).toBe(6);
  });

  it("exposes setting defaults that the settings repo can merge", () => {
    expect(RESILIENCE_SETTING_DEFAULTS).toEqual({
      cooldownRetryEnabled: true,
      cooldownRetryMaxWaitMs: 30_000,
      streamReadinessTimeoutMs: 25_000,
    });
  });
});

describe("settings defaults", () => {
  it("merges the resilience defaults into fresh settings", () => {
    const merged = mergeWithDefaults({});
    expect(merged.cooldownRetryEnabled).toBe(true);
    expect(merged.cooldownRetryMaxWaitMs).toBe(30_000);
    expect(merged.streamReadinessTimeoutMs).toBe(25_000);
  });

  it("lets stored settings override the defaults", () => {
    const merged = mergeWithDefaults({ cooldownRetryEnabled: false, cooldownRetryMaxWaitMs: 1_000 });
    expect(merged.cooldownRetryEnabled).toBe(false);
    expect(merged.cooldownRetryMaxWaitMs).toBe(1_000);
  });
});
