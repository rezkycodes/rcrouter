import { describe, expect, it } from "vitest";

import { resolveAutoCombo } from "../../open-sse/services/autoCombo.js";

describe("auto-combo candidate resolution", () => {
  it("returns a typed no-eligible-target result when no active connection exists", async () => {
    await expect(resolveAutoCombo({ modelStr: "auto", connections: [] })).resolves.toMatchObject({
      models: [],
      noEligibleTargets: true,
      reason: "no-active-connections",
      variant: "auto",
      isAuto: true,
    });
  });

  it("ignores disabled and incomplete connections without creating a placeholder model", async () => {
    const result = await resolveAutoCombo({
      modelStr: "auto",
      connections: [
        { provider: "openai", defaultModel: "gpt-4o", isActive: false },
        { provider: "", defaultModel: "gpt-4o", isActive: true },
        null,
      ],
    });

    expect(result.models).toEqual([]);
    expect(result.noEligibleTargets).toBe(true);
    expect(result.models).not.toContain("auto/fallback");
  });

  it("normalizes provider-qualified and provider-local defaults", async () => {
    const result = await resolveAutoCombo({
      modelStr: "auto/coding",
      connections: [
        { provider: "anthropic", defaultModel: "claude-sonnet-4", isActive: true },
        { provider: "openai", defaultModel: "openai/gpt-4o", isActive: true },
      ],
    });

    expect(result.models).toEqual(["anthropic/claude-sonnet-4", "openai/gpt-4o"]);
    expect(result.noEligibleTargets).toBeUndefined();
  });

  it("falls back to active candidates when a policy has no matching model", async () => {
    const result = await resolveAutoCombo({
      modelStr: "auto/reasoning",
      connections: [{ provider: "openai", defaultModel: "gpt-4o-mini", isActive: true }],
    });

    expect(result.models).toEqual(["openai/gpt-4o-mini"]);
    expect(result.noEligibleTargets).toBeUndefined();
  });
});
