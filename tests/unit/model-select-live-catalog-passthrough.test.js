import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { buildModelGroups, LIVE_CATALOG_PROVIDERS } from "@/shared/utils/selectableModels.js";
import { getProviderAlias } from "@/shared/constants/providers.js";
import { getModelsByProviderId } from "@/shared/constants/models.js";

// Command Code and Zed are `passthroughModels` providers. The picker handled that flag in a
// branch of its own that only read the static registry list, so the live catalog they publish
// (Command Code: 104 models, among them recursive/flint-v1.0:free) never reached the combo picker.
const FLINT = { id: "recursive/flint-v1.0:free", name: "Flint" };
const SONNET = { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" };

const commandcodeAlias = getProviderAlias("commandcode");
const zedAlias = getProviderAlias("zed");

const connection = (provider) => ({ id: `${provider}-conn`, provider, isActive: true });
const valuesOf = (groups, providerId) => (groups[providerId]?.models ?? []).map((m) => m.value);

describe("passthrough providers with a live catalog", () => {
  it("lists the live Command Code catalog, not only the static registry list", () => {
    const groups = buildModelGroups({
      connections: [connection("commandcode")],
      liveModels: { commandcode: [FLINT, SONNET] },
    });

    expect(valuesOf(groups, "commandcode")).toEqual(
      expect.arrayContaining([`${commandcodeAlias}/${FLINT.id}`, `${commandcodeAlias}/${SONNET.id}`]),
    );
  });

  it("shows the live catalog instead of the stale static list when both exist", () => {
    const staticIds = getModelsByProviderId("commandcode").map((m) => `${commandcodeAlias}/${m.id}`);
    const groups = buildModelGroups({
      connections: [connection("commandcode")],
      liveModels: { commandcode: [FLINT, SONNET] },
    });

    expect(staticIds.length).toBeGreaterThan(2);
    expect(valuesOf(groups, "commandcode").sort()).toEqual(
      [`${commandcodeAlias}/${FLINT.id}`, `${commandcodeAlias}/${SONNET.id}`].sort(),
    );
  });

  it("falls back to the static list when the live catalog is empty or missing", () => {
    const staticValues = getModelsByProviderId("commandcode").map((m) => `${commandcodeAlias}/${m.id}`);

    for (const liveModels of [{}, { commandcode: [] }]) {
      const groups = buildModelGroups({ connections: [connection("commandcode")], liveModels });

      expect(valuesOf(groups, "commandcode").sort()).toEqual([...staticValues].sort());
      expect(valuesOf(groups, "commandcode")).not.toContain(`${commandcodeAlias}/${FLINT.id}`);
    }
  });

  it("keeps user aliases and custom models next to the live catalog", () => {
    const groups = buildModelGroups({
      connections: [connection("commandcode")],
      modelAliases: { "my-pick": `${commandcodeAlias}/vendor/aliased-model` },
      customModels: [{ providerAlias: commandcodeAlias, id: "vendor/custom-model", name: "Custom" }],
      liveModels: { commandcode: [FLINT] },
    });

    expect(valuesOf(groups, "commandcode")).toEqual(
      expect.arrayContaining([
        `${commandcodeAlias}/${FLINT.id}`,
        `${commandcodeAlias}/vendor/aliased-model`,
        `${commandcodeAlias}/vendor/custom-model`,
      ]),
    );
  });

  it("lists the live Zed catalog (Zed is also a passthrough provider)", () => {
    const groups = buildModelGroups({
      connections: [connection("zed")],
      liveModels: { zed: [{ id: "zed-live-model", name: "Zed Live" }] },
    });

    expect(valuesOf(groups, "zed")).toContain(`${zedAlias}/zed-live-model`);
  });

  it("does not push the chat catalog into a typed (image) picker", () => {
    const groups = buildModelGroups({
      connections: [connection("commandcode")],
      kindFilter: "image",
      liveModels: { commandcode: [FLINT] },
    });

    expect(valuesOf(groups, "commandcode")).not.toContain(`${commandcodeAlias}/${FLINT.id}`);
  });
});

describe("the list of live-catalog providers", () => {
  it("includes Command Code", () => {
    expect(LIVE_CATALOG_PROVIDERS).toContain("commandcode");
  });

  it("is the same list the combo picker uses (the CLI tools builder fell out of step once)", () => {
    const modal = fs.readFileSync(new URL("../../src/shared/components/ModelSelectModal.js", import.meta.url), "utf8");
    const literal = modal.match(/const LIVE_CATALOG_PROVIDERS\s*=\s*\[([^\]]+)\]/);

    expect(literal).toBeTruthy();
    const inModal = [...literal[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect([...inModal].sort()).toEqual([...LIVE_CATALOG_PROVIDERS].sort());
  });
});

describe("the combo picker's passthrough branch", () => {
  it("reads the live catalog the same way the other providers do", () => {
    const modal = fs.readFileSync(new URL("../../src/shared/components/ModelSelectModal.js", import.meta.url), "utf8");
    const start = modal.indexOf("if (providerInfo.passthroughModels) {");
    const end = modal.indexOf("} else if (isCustomProvider)", start);
    const branch = modal.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(branch).toMatch(/catalogModelsFor\(providerId\)/);
    expect(branch).not.toMatch(/getModelsByProviderId\(providerId\)\s*\n?\s*\.filter\(\(m\) => !getModelKind\(m\)/);
  });
});
