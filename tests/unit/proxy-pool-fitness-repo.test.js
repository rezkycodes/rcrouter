// proxyPoolFitness repo: durable "pool is unfit for provider::model until T" rows.
// Real temp SQLite database (fresh DATA_DIR per file), no mocks, so the schema,
// the repo SQL and the pool-deletion hook are exercised together.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
let tempDir;
let db;

beforeAll(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-fitness-repo-"));
  process.env.DATA_DIR = tempDir;
  // The driver keeps its adapter on `global`, which survives vi.resetModules().
  global._dbAdapter = { instance: null, initPromise: null, logged: false };
  vi.resetModules();
  db = await import("@/lib/db/index.js");
  await db.initDb();
});

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  global._dbAdapter = { instance: null, initPromise: null, logged: false };
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

const FUTURE = Date.now() + 60_000;

describe("proxyPoolFitness repo", () => {
  beforeEach(async () => {
    await db.clearProxyPoolFitness();
  });

  it("starts empty", async () => {
    expect(await db.listProxyPoolFitness()).toEqual([]);
    expect(await db.listProxyPoolFitness("p1")).toEqual([]);
  });

  it("upserts a row and returns its public shape", async () => {
    const row = await db.upsertProxyPoolFitness("p1", "freebuff::m1", FUTURE, "limited_ip");

    expect(row).toMatchObject({ poolId: "p1", scope: "freebuff::m1", until: FUTURE, reason: "limited_ip" });
    expect(typeof row.createdAt).toBe("string");
    expect(typeof row.updatedAt).toBe("string");
  });

  it("defaults the reason to an empty string", async () => {
    const row = await db.upsertProxyPoolFitness("p1", "freebuff::m1", FUTURE);
    expect(row.reason).toBe("");
  });

  it("replaces the row for the same pool and scope instead of adding another", async () => {
    const first = await db.upsertProxyPoolFitness("p1", "freebuff::m1", FUTURE, "first");
    const second = await db.upsertProxyPoolFitness("p1", "freebuff::m1", FUTURE + 5_000, "second");

    expect(await db.listProxyPoolFitness("p1")).toHaveLength(1);
    expect(second).toMatchObject({ until: FUTURE + 5_000, reason: "second" });
    expect(second.createdAt).toBe(first.createdAt);
  });

  it("refuses invalid input without writing", async () => {
    expect(await db.upsertProxyPoolFitness("", "a::b", FUTURE)).toBeNull();
    expect(await db.upsertProxyPoolFitness("p1", "", FUTURE)).toBeNull();
    expect(await db.upsertProxyPoolFitness("p1", "a::b", Number.NaN)).toBeNull();
    expect(await db.upsertProxyPoolFitness("p1", "a::b", "soon")).toBeNull();
    expect(await db.listProxyPoolFitness()).toEqual([]);
  });

  it("lists by pool and across pools, ordered by pool then scope", async () => {
    await db.upsertProxyPoolFitness("p2", "b::m", FUTURE);
    await db.upsertProxyPoolFitness("p1", "z::m", FUTURE);
    await db.upsertProxyPoolFitness("p1", "a::m", FUTURE);

    expect((await db.listProxyPoolFitness("p1")).map((r) => r.scope)).toEqual(["a::m", "z::m"]);
    expect((await db.listProxyPoolFitness()).map((r) => `${r.poolId}|${r.scope}`)).toEqual(["p1|a::m", "p1|z::m", "p2|b::m"]);
  });

  it("deletes a single scope and leaves the rest", async () => {
    await db.upsertProxyPoolFitness("p1", "a::m", FUTURE);
    await db.upsertProxyPoolFitness("p1", "b::m", FUTURE);
    await db.upsertProxyPoolFitness("p2", "a::m", FUTURE);

    await db.deleteProxyPoolFitness("p1", "a::m");

    expect((await db.listProxyPoolFitness()).map((r) => `${r.poolId}|${r.scope}`)).toEqual(["p1|b::m", "p2|a::m"]);
  });

  it("clears everything", async () => {
    await db.upsertProxyPoolFitness("p1", "a::m", FUTURE);
    await db.upsertProxyPoolFitness("p2", "b::m", FUTURE);

    await db.clearProxyPoolFitness();

    expect(await db.listProxyPoolFitness()).toEqual([]);
  });

  it("clears one provider, including its wildcard scope, and nothing else", async () => {
    await db.upsertProxyPoolFitness("p1", "freebuff::m1", FUTURE);
    await db.upsertProxyPoolFitness("p1", "freebuff::*", FUTURE);
    await db.upsertProxyPoolFitness("p1", "freebuffer::m1", FUTURE);
    await db.upsertProxyPoolFitness("p2", "opencode::m1", FUTURE);

    await db.clearProxyPoolFitness("freebuff");

    expect((await db.listProxyPoolFitness()).map((r) => `${r.poolId}|${r.scope}`)).toEqual(["p1|freebuffer::m1", "p2|opencode::m1"]);
  });

  it("treats LIKE metacharacters in a provider name literally", async () => {
    await db.upsertProxyPoolFitness("p1", "my_prov::m", FUTURE);
    await db.upsertProxyPoolFitness("p1", "myXprov::m", FUTURE);

    await db.clearProxyPoolFitness("my_prov");

    expect((await db.listProxyPoolFitness()).map((r) => r.scope)).toEqual(["myXprov::m"]);
  });

  it("deletes every scope of one pool", async () => {
    await db.upsertProxyPoolFitness("p1", "a::m", FUTURE);
    await db.upsertProxyPoolFitness("p1", "b::m", FUTURE);
    await db.upsertProxyPoolFitness("p2", "a::m", FUTURE);

    await db.deleteProxyPoolFitnessByPool("p1");

    expect((await db.listProxyPoolFitness()).map((r) => r.poolId)).toEqual(["p2"]);
  });

  it("is exported from the legacy localDb shim and the models barrel", async () => {
    const shim = await import("@/lib/localDb.js");
    const models = await import("@/models/index.js");
    for (const name of ["listProxyPoolFitness", "upsertProxyPoolFitness", "deleteProxyPoolFitness", "clearProxyPoolFitness", "deleteProxyPoolFitnessByPool"]) {
      expect(typeof shim[name], `localDb.${name}`).toBe("function");
      expect(typeof models[name], `models.${name}`).toBe("function");
    }
  });
});

describe("proxy pool deletion", () => {
  beforeEach(async () => {
    await db.clearProxyPoolFitness();
  });

  it("removes the deleted pool's fitness rows and keeps other pools'", async () => {
    const doomed = await db.createProxyPool({ name: "doomed", proxyUrl: "http://127.0.0.1:1" });
    const kept = await db.createProxyPool({ name: "kept", proxyUrl: "http://127.0.0.1:2" });
    await db.upsertProxyPoolFitness(doomed.id, "freebuff::m", FUTURE);
    await db.upsertProxyPoolFitness(doomed.id, "opencode::*", FUTURE);
    await db.upsertProxyPoolFitness(kept.id, "freebuff::m", FUTURE);

    await db.deleteProxyPool(doomed.id);

    expect((await db.listProxyPoolFitness()).map((r) => r.poolId)).toEqual([kept.id]);
  });

  it("leaves fitness rows alone when the pool id does not exist", async () => {
    await db.upsertProxyPoolFitness("ghost", "freebuff::m", FUTURE);

    expect(await db.deleteProxyPool("no-such-pool")).toBeNull();

    expect(await db.listProxyPoolFitness()).toHaveLength(1);
  });
});

describe("database export / import", () => {
  beforeEach(async () => {
    await db.clearProxyPoolFitness();
  });

  it("exports fitness rows and restores them on import", async () => {
    await db.upsertProxyPoolFitness("p1", "freebuff::m", FUTURE, "limited_ip");
    const payload = await db.exportDb();
    expect(payload.proxyPoolFitness).toHaveLength(1);

    await db.clearProxyPoolFitness();
    await db.importDb(payload);

    expect(await db.listProxyPoolFitness()).toEqual([
      expect.objectContaining({ poolId: "p1", scope: "freebuff::m", until: FUTURE, reason: "limited_ip" }),
    ]);
  });

  it("drops stale fitness rows when an older backup without the key is imported", async () => {
    await db.upsertProxyPoolFitness("p1", "freebuff::m", FUTURE);
    const payload = await db.exportDb();
    delete payload.proxyPoolFitness;

    await db.importDb(payload);

    expect(await db.listProxyPoolFitness()).toEqual([]);
  });
});
