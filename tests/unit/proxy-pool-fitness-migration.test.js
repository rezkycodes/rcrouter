// Migration 003 (proxyPoolFitness) on a database that is already at schema v2.
// The live data.sqlite is at v2 and runs this on its next boot, so the contract
// is strict: purely additive, never touches existing rows, safe to run twice.
//
// A v2 database is built with the real migrations 001 + 002, then the fitness
// table is dropped to put it in the exact shape code from before this change
// left behind (001 creates every table in TABLES, which now includes the new one).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const FITNESS_INDEXES = ["idx_ppf_pool", "idx_ppf_scope", "idx_ppf_until"];

let tempDir;

function freshAdapterState() {
  global._dbAdapter = { instance: null, initPromise: null, logged: false };
  vi.resetModules();
}

async function openAdapter() {
  const { getAdapter } = await import("@/lib/db/driver.js");
  return getAdapter();
}

function metaValue(adapter, key) {
  return adapter.get("SELECT value FROM _meta WHERE key = ?", [key])?.value ?? null;
}

function tableNames(adapter) {
  return adapter.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name);
}

function indexNames(adapter) {
  return adapter.all("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_ppf_%' ORDER BY name").map((r) => r.name);
}

// Every row of every user table except _meta and the new table, in a stable order.
function snapshotData(adapter) {
  const out = {};
  for (const name of tableNames(adapter)) {
    if (name === "_meta" || name === "proxyPoolFitness") continue;
    out[name] = adapter.all(`SELECT * FROM ${name} ORDER BY rowid`);
  }
  return out;
}

function seedExistingData(adapter) {
  const now = "2026-01-01T00:00:00.000Z";
  adapter.run("INSERT INTO settings(id, data) VALUES(1, ?)", [JSON.stringify({ requireLogin: true, marker: "keep-me" })]);
  adapter.run(
    "INSERT INTO providerConnections(id, provider, authType, name, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ["c1", "openrouter", "apikey", "main", 1, 1, JSON.stringify({ apiKey: "sk-fixture" }), now, now],
  );
  adapter.run(
    "INSERT INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)",
    ["pool-1", 1, "active", JSON.stringify({ name: "p", proxyUrl: "http://127.0.0.1:9" }), now, now],
  );
  adapter.run("INSERT INTO apiKeys(id, key, name, isActive, createdAt) VALUES(?, ?, ?, ?, ?)", ["k1", "key-fixture", "k", 1, now]);
  adapter.run("INSERT INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)", ["combo-1", "c", null, "[]", now, now]);
  adapter.run("INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)", ["modelAliases", "a", JSON.stringify("b")]);
}

// Rewind a fully migrated database to schema v2 as pre-change code left it.
function rewindToV2(adapter) {
  adapter.exec("DROP TABLE proxyPoolFitness");
  adapter.run("INSERT OR REPLACE INTO _meta(key, value) VALUES('schemaVersion', '2')");
  adapter.run("INSERT OR REPLACE INTO _meta(key, value) VALUES('backupSchemaVersion', '2')");
}

function backupDirs() {
  const dir = path.join(tempDir, "db", "backups");
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

describe("migration 003: add-proxy-pool-fitness", () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-fitness-migration-"));
    process.env.DATA_DIR = tempDir;
    freshAdapterState();
  });

  afterEach(() => {
    freshAdapterState();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("is registered after 002 as version 3 and the schema version constant matches", async () => {
    const { MIGRATIONS, latestVersion } = await import("@/lib/db/migrations/index.js");
    const { SCHEMA_VERSION } = await import("@/lib/db/schema.js");

    expect(MIGRATIONS.map((m) => m.version)).toEqual([1, 2, 3]);
    expect(MIGRATIONS[2].name).toBe("add-proxy-pool-fitness");
    expect(latestVersion()).toBe(3);
    expect(SCHEMA_VERSION).toBe(3);
  });

  it("a fresh database gets the table and indexes from the initial schema", async () => {
    const adapter = await openAdapter();

    expect(tableNames(adapter)).toContain("proxyPoolFitness");
    expect(indexNames(adapter)).toEqual(FITNESS_INDEXES);
    expect(metaValue(adapter, "schemaVersion")).toBe("3");
  });

  it("up() alone creates the table, its columns, primary key and indexes on a v2 database", async () => {
    const adapter = await openAdapter();
    rewindToV2(adapter);
    expect(tableNames(adapter)).not.toContain("proxyPoolFitness");
    expect(indexNames(adapter)).toEqual([]);

    const { default: m003 } = await import("@/lib/db/migrations/003-add-proxy-pool-fitness.js");
    expect(m003.version).toBe(3);
    m003.up(adapter);

    const columns = adapter.all("PRAGMA table_info(proxyPoolFitness)");
    expect(columns.map((c) => c.name)).toEqual(["poolId", "scope", "until", "reason", "createdAt", "updatedAt"]);
    expect(columns.filter((c) => c.pk > 0).map((c) => c.name)).toEqual(["poolId", "scope"]);
    expect(indexNames(adapter)).toEqual(FITNESS_INDEXES);
  });

  it("up() is idempotent and keeps fitness rows it finds", async () => {
    const adapter = await openAdapter();
    const { default: m003 } = await import("@/lib/db/migrations/003-add-proxy-pool-fitness.js");
    adapter.run(
      "INSERT INTO proxyPoolFitness(poolId, scope, until, reason, createdAt, updatedAt) VALUES('p', 'a::b', 123, 'r', 't', 't')",
    );

    m003.up(adapter);
    m003.up(adapter);

    expect(adapter.all("SELECT poolId, scope, until, reason FROM proxyPoolFitness")).toEqual([
      { poolId: "p", scope: "a::b", until: 123, reason: "r" },
    ]);
    expect(indexNames(adapter)).toEqual(FITNESS_INDEXES);
  });

  it("booting a v2 database applies only 003, leaves every existing row untouched and takes a safety backup", async () => {
    const first = await openAdapter();
    seedExistingData(first);
    rewindToV2(first);
    const before = snapshotData(first);
    const tablesBefore = tableNames(first).filter((n) => n !== "proxyPoolFitness");
    first.close();
    expect(backupDirs()).toEqual([]);

    freshAdapterState();
    const second = await openAdapter();

    expect(metaValue(second, "schemaVersion")).toBe("3");
    expect(metaValue(second, "backupSchemaVersion")).toBe("3");
    expect(tableNames(second)).toEqual([...tablesBefore, "proxyPoolFitness"].sort());
    expect(indexNames(second)).toEqual(FITNESS_INDEXES);
    expect(second.all("SELECT * FROM proxyPoolFitness")).toEqual([]);
    expect(snapshotData(second)).toEqual(before);
    expect(backupDirs()).toHaveLength(1);
    expect(backupDirs()[0]).toMatch(/^schema-2-to-3-/);
    second.close();
  });

  it("booting again after the upgrade is a no-op", async () => {
    const first = await openAdapter();
    seedExistingData(first);
    rewindToV2(first);
    first.close();

    freshAdapterState();
    const upgraded = await openAdapter();
    upgraded.run(
      "INSERT INTO proxyPoolFitness(poolId, scope, until, reason, createdAt, updatedAt) VALUES('pool-1', 'freebuff::m', 99, 'limited_ip', 't', 't')",
    );
    const dataAfterUpgrade = snapshotData(upgraded);
    const backupsAfterUpgrade = backupDirs();
    upgraded.close();

    freshAdapterState();
    const again = await openAdapter();

    expect(metaValue(again, "schemaVersion")).toBe("3");
    expect(snapshotData(again)).toEqual(dataAfterUpgrade);
    expect(again.all("SELECT poolId, scope, until, reason FROM proxyPoolFitness")).toEqual([
      { poolId: "pool-1", scope: "freebuff::m", until: 99, reason: "limited_ip" },
    ]);
    expect(indexNames(again)).toEqual(FITNESS_INDEXES);
    expect(backupDirs()).toEqual(backupsAfterUpgrade);
    again.close();
  });
});
