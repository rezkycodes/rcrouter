// Proxy-pool fitness survives a restart: SQLite is the source of truth and the
// globalThis Map is a read-through cache. Real service + real temp database; a
// "restart" closes the adapter, drops the in-memory state and re-imports every
// module against the same DATA_DIR.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const FITNESS_KEYS = ["__9routerPoolFitness__", "__9routerPoolFitnessState__"];
const FUTURE = () => Date.now() + 60_000;

let tempDir;
let svc;
let db;

function dropProcessState() {
  global._dbAdapter = { instance: null, initPromise: null, logged: false };
  for (const key of FITNESS_KEYS) delete globalThis[key];
  vi.resetModules();
}

async function boot() {
  svc = await import("open-sse/services/proxyPoolFitness.js");
  db = await import("@/lib/db/index.js");
  await db.initDb();
}

async function restart() {
  const { getAdapter } = await import("@/lib/db/driver.js");
  (await getAdapter()).close();
  dropProcessState();
  await boot();
}

describe("durable proxy pool fitness", () => {
  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-fitness-durable-"));
    process.env.DATA_DIR = tempDir;
    dropProcessState();
    await boot();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      const { getAdapter } = await import("@/lib/db/driver.js");
      (await getAdapter()).close();
    } catch {
      // adapter already closed by a fault-injection test
    }
    dropProcessState();
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  describe("persistence", () => {
    it("writes the mark to the database", async () => {
      const until = FUTURE();
      expect(await svc.markPoolUnfit("p1", "freebuff::m1", until, "limited_ip")).toBe(true);

      expect(await db.listProxyPoolFitness("p1")).toEqual([
        expect.objectContaining({ poolId: "p1", scope: "freebuff::m1", until, reason: "limited_ip" }),
      ]);
    });

    it("keeps the pool unfit after a restart once it is loaded again", async () => {
      const until = FUTURE();
      await svc.markPoolUnfit("p1", "freebuff::m1", until, "limited_ip");
      await svc.markPoolUnfit("p1", "opencode::*", until, "ip-limit");

      await restart();
      // The cache is cold after a restart; loadPoolFitness is what warms it.
      expect(svc.isPoolFit("p1", "freebuff::m1")).toBe(true);
      await svc.loadPoolFitness("p1");

      expect(svc.isPoolFit("p1", "freebuff::m1")).toBe(false);
      expect(svc.isPoolFit("p1", "opencode::anything")).toBe(false);
      expect(svc.isPoolFit("p1", "other::m")).toBe(true);
      expect(svc.fitPoolIds(["p1", "p2"], "freebuff::m1")).toEqual(["p2"]);
      expect((await svc.poolFitnessSnapshot()).p1["freebuff::m1"]).toEqual({ until, reason: "limited_ip" });
    });

    it("clearing a scope removes it from the database too", async () => {
      await svc.markPoolUnfit("p1", "a::m", FUTURE());
      await svc.markPoolUnfit("p1", "b::m", FUTURE());

      expect(await svc.clearPoolUnfit("p1", "a::m")).toBe(true);
      await restart();
      await svc.loadPoolFitness("p1");

      expect(svc.isPoolFit("p1", "a::m")).toBe(true);
      expect(svc.isPoolFit("p1", "b::m")).toBe(false);
    });

    it("clearing one provider keeps the others, clearing all removes every row", async () => {
      await svc.markPoolUnfit("p1", "a::m", FUTURE());
      await svc.markPoolUnfit("p2", "a::*", FUTURE());
      await svc.markPoolUnfit("p1", "b::m", FUTURE());

      expect(await svc.clearAllPoolUnfit("a")).toBe(true);
      expect((await db.listProxyPoolFitness()).map((r) => `${r.poolId}|${r.scope}`)).toEqual(["p1|b::m"]);
      expect(svc.isPoolFit("p1", "a::m")).toBe(true);
      expect(svc.isPoolFit("p1", "b::m")).toBe(false);

      expect(await svc.clearAllPoolUnfit()).toBe(true);
      expect(await db.listProxyPoolFitness()).toEqual([]);
      expect(svc.isPoolFit("p1", "b::m")).toBe(true);
    });

    it("resetPoolFitness wipes the cache and the database", async () => {
      await svc.markPoolUnfit("p1", "a::m", FUTURE());

      expect(await svc.resetPoolFitness()).toBe(true);

      expect(await db.listProxyPoolFitness()).toEqual([]);
      expect(await svc.poolFitnessSnapshot()).toEqual({});
    });
  });

  describe("expiry", () => {
    it("drops expired rows on load: not cached, and deleted from the database", async () => {
      const live = FUTURE();
      await db.upsertProxyPoolFitness("p1", "a::m", Date.now() - 1_000, "old");
      await db.upsertProxyPoolFitness("p1", "b::m", live, "new");

      await svc.loadPoolFitness("p1");

      expect(svc.isPoolFit("p1", "a::m")).toBe(true);
      expect(svc.isPoolFit("p1", "b::m")).toBe(false);
      expect((await db.listProxyPoolFitness("p1")).map((r) => r.scope)).toEqual(["b::m"]);
    });

    it("pruneExpired deletes expired rows from the database and reports how many", async () => {
      await db.upsertProxyPoolFitness("p1", "a::m", Date.now() - 1_000);
      await db.upsertProxyPoolFitness("p2", "a::m", Date.now() - 2_000);
      await db.upsertProxyPoolFitness("p2", "b::m", FUTURE());

      expect(await svc.pruneExpired()).toBe(2);

      expect((await db.listProxyPoolFitness()).map((r) => `${r.poolId}|${r.scope}`)).toEqual(["p2|b::m"]);
    });

    it("snapshot omits expired rows and deletes them", async () => {
      await db.upsertProxyPoolFitness("p1", "a::m", Date.now() - 1_000);
      await db.upsertProxyPoolFitness("p1", "b::m", FUTURE(), "live");

      const snapshot = await svc.poolFitnessSnapshot();

      expect(Object.keys(snapshot.p1)).toEqual(["b::m"]);
      expect((await db.listProxyPoolFitness("p1")).map((r) => r.scope)).toEqual(["b::m"]);
    });
  });

  describe("legacy pool.fitness JSON", () => {
    async function poolWithLegacyFitness() {
      const pool = await db.createProxyPool({ name: "legacy", proxyUrl: "http://127.0.0.1:9" });
      await db.updateProxyPool(pool.id, {
        fitness: {
          "freebuff::m": { until: FUTURE(), reason: "legacy_reason" },
          "stale::m": { until: Date.now() - 1_000, reason: "expired" },
          "broken::m": { reason: "no until" },
        },
      });
      return pool.id;
    }

    it("moves live legacy entries into the table and honours them", async () => {
      const id = await poolWithLegacyFitness();

      await svc.loadPoolFitness(id);

      expect(svc.isPoolFit(id, "freebuff::m")).toBe(false);
      expect(svc.isPoolFit(id, "stale::m")).toBe(true);
      expect((await db.listProxyPoolFitness(id)).map((r) => [r.scope, r.reason])).toEqual([["freebuff::m", "legacy_reason"]]);
    });

    it("migrates only once: the legacy field is removed from the pool and cannot resurrect a cleared block", async () => {
      const id = await poolWithLegacyFitness();
      await svc.loadPoolFitness(id);
      expect((await db.getProxyPoolById(id)).fitness).toBeUndefined();
      expect(await db.getProxyPoolById(id)).toMatchObject({ name: "legacy", proxyUrl: "http://127.0.0.1:9" });

      await svc.clearPoolUnfit(id, "freebuff::m");
      await restart();
      await svc.loadPoolFitness(id);

      expect(svc.isPoolFit(id, "freebuff::m")).toBe(true);
      expect(await db.listProxyPoolFitness(id)).toEqual([]);
    });

    it("ignores legacy data when the table already has rows for the pool", async () => {
      const id = await poolWithLegacyFitness();
      await db.upsertProxyPoolFitness(id, "other::m", FUTURE(), "durable");

      await svc.loadPoolFitness(id);

      expect(svc.isPoolFit(id, "other::m")).toBe(false);
      expect(svc.isPoolFit(id, "freebuff::m")).toBe(true);
    });
  });

  describe("fail open when the database is unavailable", () => {
    async function breakDatabase() {
      const { getAdapter } = await import("@/lib/db/driver.js");
      (await getAdapter()).close();
    }

    it("never throws, blocks the pool in memory and logs a single warning", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await breakDatabase();

      await expect(svc.markPoolUnfit("p1", "a::m", FUTURE())).resolves.toBe(false);
      await expect(svc.markPoolUnfit("p1", "b::m", FUTURE())).resolves.toBe(false);
      await expect(svc.loadPoolFitness("p1")).resolves.toBeUndefined();
      await expect(svc.clearPoolUnfit("p1", "b::m")).resolves.toBe(false);
      await expect(svc.clearAllPoolUnfit("a")).resolves.toBe(false);
      await expect(svc.pruneExpired()).resolves.toBeTypeOf("number");

      // In-memory state still reflects what this process did, as before this change.
      expect(svc.isPoolFit("p1", "a::m")).toBe(true); // cleared by clearAllPoolUnfit("a")
      await svc.markPoolUnfit("p1", "c::m", FUTURE());
      expect(svc.isPoolFit("p1", "c::m")).toBe(false);
      expect((await svc.poolFitnessSnapshot()).p1["c::m"]).toBeDefined();

      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("proxyPoolFitness");
    });

    it("keeps the cache when a reload fails", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await svc.markPoolUnfit("p1", "a::m", FUTURE());
      await breakDatabase();

      await svc.loadPoolFitness("p1");

      expect(svc.isPoolFit("p1", "a::m")).toBe(false);
    });

    it("answers fit for a pool it has no data about", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await breakDatabase();

      await svc.loadPoolFitness("unknown");

      expect(svc.isPoolFit("unknown", "a::m")).toBe(true);
      expect(svc.fitPoolIds(["unknown"], "a::m")).toEqual(["unknown"]);
    });

    it("ignores invalid input without touching anything", async () => {
      expect(await svc.markPoolUnfit("", "a::m", FUTURE())).toBe(false);
      expect(await svc.markPoolUnfit("p1", "", FUTURE())).toBe(false);
      expect(await svc.markPoolUnfit("p1", "a::m", Number.NaN)).toBe(false);
      expect(await svc.clearPoolUnfit("", "a::m")).toBe(false);
      expect(await db.listProxyPoolFitness()).toEqual([]);
    });
  });
});
