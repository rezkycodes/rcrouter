// createProviderConnectionsBulk: many API-key connections in ONE transaction.
// The dashboard used to POST one key at a time (N requests, N cache flushes, a
// half-imported pool when a request failed midway). Ported from VansRouter, with
// two RcRouter invariants kept: a name collision never silently overwrites a
// stored key (#4311) and the pool keeps the paste order.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-bulk-conn-"));
  process.env.DATA_DIR = tempDir;
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const item = (name, extra = {}) => ({
  provider: "openrouter", name, apiKey: `sk-${name}`, authType: "apikey", testStatus: "unknown", ...extra,
});

// Reads past the 2 s connection cache so assertions see what is really stored.
async function names(provider = "openrouter") {
  db.invalidateConnectionCache();
  const rows = await db.getProviderConnections({ provider });
  return [...rows].sort((a, b) => a.priority - b.priority).map((c) => c.name);
}

describe("createProviderConnectionsBulk", () => {
  beforeEach(async () => {
    for (const c of await db.getProviderConnections()) await db.deleteProviderConnection(c.id);
  });

  it("stores every item and returns one ok result per item", async () => {
    const results = await db.createProviderConnectionsBulk([item("a"), item("b"), item("c")]);

    expect(results.map((r) => [r.name, r.ok, r.updated])).toEqual([
      ["a", true, false], ["b", true, false], ["c", true, false],
    ]);
    expect(new Set(results.map((r) => r.id)).size).toBe(3);
    const stored = await db.getProviderConnections({ provider: "openrouter" });
    expect(stored.map((c) => c.apiKey).sort()).toEqual(["sk-a", "sk-b", "sk-c"]);
    expect(stored.every((c) => c.authType === "apikey" && c.isActive === true)).toBe(true);
  });

  it("appends after the existing pool in paste order, ignoring a colliding explicit priority", async () => {
    await db.createProviderConnection({ provider: "openrouter", authType: "apikey", name: "old", apiKey: "sk-old" });

    await db.createProviderConnectionsBulk([item("a", { priority: 1 }), item("b", { priority: 1 }), item("c", { priority: 1 })]);

    expect(await names()).toEqual(["old", "a", "b", "c"]);
    const priorities = (await db.getProviderConnections({ provider: "openrouter" })).map((c) => c.priority).sort();
    expect(priorities).toEqual([1, 2, 3, 4]);
  });

  it("keeps the type authType a caller asked for (cookie providers)", async () => {
    await db.createProviderConnectionsBulk([item("cookie-1", { provider: "grok-web", authType: "cookie" })]);

    const [stored] = await db.getProviderConnections({ provider: "grok-web" });
    expect(stored.authType).toBe("cookie");
  });

  it("never overwrites a stored key on a name collision and still saves the rest", async () => {
    const [existing] = await db.createProviderConnectionsBulk([item("dup", { apiKey: "sk-original" })]);

    const results = await db.createProviderConnectionsBulk([item("dup", { apiKey: "sk-new" }), item("fresh")]);

    expect(results[0]).toMatchObject({ name: "dup", ok: false, code: "PROVIDER_NAME_CONFLICT", existingId: existing.id });
    expect(results[1]).toMatchObject({ name: "fresh", ok: true });
    const stored = await db.getProviderConnections({ provider: "openrouter" });
    expect(stored.find((c) => c.name === "dup").apiKey).toBe("sk-original");
  });

  it("treats a repeated name inside one batch as a collision, not a second row", async () => {
    const results = await db.createProviderConnectionsBulk([item("twin", { apiKey: "sk-1" }), item("twin", { apiKey: "sk-2" })]);

    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect((await db.getProviderConnections({ provider: "openrouter" })).length).toBe(1);
  });

  it("updates in place only when the item opts in with allowOverwrite", async () => {
    const [created] = await db.createProviderConnectionsBulk([item("same", { apiKey: "sk-old" })]);

    const [result] = await db.createProviderConnectionsBulk([item("same", { apiKey: "sk-rotated", allowOverwrite: true })]);

    expect(result).toMatchObject({ ok: true, updated: true, id: created.id });
    const stored = await db.getProviderConnections({ provider: "openrouter" });
    expect(stored).toHaveLength(1);
    expect(stored[0].apiKey).toBe("sk-rotated");
  });

  it("rejects an item missing provider, name or key without blocking the others", async () => {
    const results = await db.createProviderConnectionsBulk([
      item("good"), { provider: "openrouter", name: "no-key" }, { provider: "openrouter", apiKey: "sk-x" },
    ]);

    expect(results.map((r) => r.ok)).toEqual([true, false, false]);
    expect(await names()).toEqual(["good"]);
  });

  it("is all-or-nothing when the database write itself fails", async () => {
    await db.createProviderConnectionsBulk([item("keep")]);

    // BigInt cannot be serialised into the JSON column, so the second insert throws mid-batch.
    await expect(db.createProviderConnectionsBulk([
      item("lost-1"), item("lost-2", { providerSpecificData: { broken: 1n } }),
    ])).rejects.toThrow();

    expect(await names()).toEqual(["keep"]);
  });

  it("refuses an empty batch and a batch over 500 items", async () => {
    await expect(db.createProviderConnectionsBulk([])).rejects.toThrow(/1-500/);
    await expect(db.createProviderConnectionsBulk(Array.from({ length: 501 }, (_, i) => item(`k${i}`)))).rejects.toThrow(/1-500/);
  });

  it("makes the new rows visible immediately (connection cache invalidated)", async () => {
    expect(await db.getProviderConnections({ provider: "openrouter" })).toHaveLength(0);

    await db.createProviderConnectionsBulk([item("visible")]);

    expect(await db.getProviderConnections({ provider: "openrouter" })).toHaveLength(1);
  });
});
