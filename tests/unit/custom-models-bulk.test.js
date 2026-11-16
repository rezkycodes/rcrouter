import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;

// Real SQLite in a throwaway DATA_DIR; only next/server is stubbed so the route can run as a plain function.
async function setup() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rcrouter-custom-models-"));
  process.env.DATA_DIR = tempDir;
  // The DB adapter is a process-wide singleton (global._dbAdapter) that vi.resetModules() does not clear;
  // drop it so every test opens a fresh database inside its own DATA_DIR.
  delete global._dbAdapter;
  vi.resetModules();
  vi.doMock("next/server", () => ({
    NextResponse: {
      json: (body, init = {}) =>
        new Response(JSON.stringify(body), {
          status: init.status || 200,
          headers: { "Content-Type": "application/json" },
        }),
    },
  }));

  const db = await import("@/lib/db/index.js");
  const route = await import("@/app/api/models/custom/route.js");
  return { db, route, cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }) };
}

const post = (route, body) =>
  route.POST(
    new Request("http://localhost/api/models/custom", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  );

describe("custom models bulk import", () => {
  let ctx;

  beforeEach(async () => {
    ctx = await setup();
  });

  afterEach(() => {
    try { global._dbAdapter?.instance?.close?.(); } catch {}
    delete global._dbAdapter;
    ctx.cleanup();
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    vi.doUnmock("next/server");
  });

  describe("addCustomModelsBulk", () => {
    it("adds every new model and reports how many were added", async () => {
      const count = await ctx.db.addCustomModelsBulk([
        { providerAlias: "ag", id: "gemini-3.8-flash-high", type: "llm" },
        { providerAlias: "ag", id: "gemini-3.8-flash-low", type: "llm" },
      ]);

      expect(count).toBe(2);
      const ids = (await ctx.db.getCustomModels()).map((m) => m.id).sort();
      expect(ids).toEqual(["gemini-3.8-flash-high", "gemini-3.8-flash-low"]);
    });

    it("defaults type to llm and the display name to the id", async () => {
      await ctx.db.addCustomModelsBulk([{ providerAlias: "ag", id: "plain" }]);

      const [row] = await ctx.db.getCustomModels();
      expect(row).toMatchObject({ providerAlias: "ag", id: "plain", type: "llm", name: "plain" });
    });

    it("skips models that already exist without overwriting them", async () => {
      await ctx.db.addCustomModel({ providerAlias: "ag", id: "kept", type: "llm", name: "My Label" });

      const count = await ctx.db.addCustomModelsBulk([
        { providerAlias: "ag", id: "kept", type: "llm", name: "Imported Label" },
        { providerAlias: "ag", id: "fresh", type: "llm" },
      ]);

      expect(count).toBe(1);
      const rows = await ctx.db.getCustomModels();
      expect(rows.find((m) => m.id === "kept").name).toBe("My Label");
    });

    it("keeps the same id separate across providers and types", async () => {
      const count = await ctx.db.addCustomModelsBulk([
        { providerAlias: "ag", id: "shared", type: "llm" },
        { providerAlias: "cc", id: "shared", type: "llm" },
        { providerAlias: "ag", id: "shared", type: "image" },
      ]);

      expect(count).toBe(3);
    });

    it("ignores entries whose providerAlias, id or type are not strings", async () => {
      const count = await ctx.db.addCustomModelsBulk([
        { providerAlias: { x: 1 }, id: "a" },
        { providerAlias: "ag", id: 42 },
        { providerAlias: "ag", id: ["arr"] },
        { providerAlias: "ag", id: "typed-wrong", type: {} },
        { providerAlias: "ag", id: "ok" },
      ]);

      expect(count).toBe(1);
      expect((await ctx.db.getCustomModels()).map((m) => m.id)).toEqual(["ok"]);
    });

    it("ignores entries missing providerAlias or id and tolerates bad input", async () => {
      expect(await ctx.db.addCustomModelsBulk([])).toBe(0);
      expect(await ctx.db.addCustomModelsBulk(undefined)).toBe(0);
      expect(await ctx.db.addCustomModelsBulk("nope")).toBe(0);

      const count = await ctx.db.addCustomModelsBulk([
        null,
        { id: "no-provider" },
        { providerAlias: "ag" },
        { providerAlias: "ag", id: "valid" },
      ]);

      expect(count).toBe(1);
      expect((await ctx.db.getCustomModels()).map((m) => m.id)).toEqual(["valid"]);
    });
  });

  describe("POST /api/models/custom", () => {
    it("accepts { models: [...] } and returns the added count", async () => {
      const response = await post(ctx.route, {
        models: [
          { providerAlias: "ag", id: "a", type: "llm" },
          { providerAlias: "ag", id: "b", type: "llm" },
          { providerAlias: "ag", id: "a", type: "llm" },
        ],
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ success: true, count: 2 });
    });

    it("still adds a single model from the flat body", async () => {
      const response = await post(ctx.route, { providerAlias: "ag", id: "solo", type: "llm" });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ success: true, added: true });
      expect((await ctx.db.getCustomModels()).map((m) => m.id)).toEqual(["solo"]);
    });

    it("still rejects a single-model body without providerAlias and id", async () => {
      const response = await post(ctx.route, { name: "orphan" });

      expect(response.status).toBe(400);
    });
  });
});
