// Release drill: prove schema backup + rollback can be performed on a copy.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir;
const originalDataDir = process.env.DATA_DIR;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rcrouter-release-migration-"));
  process.env.DATA_DIR = tempDir;
  delete global._dbAdapter;
  vi.resetModules();
});

afterEach(() => {
  try { global._dbAdapter?.instance?.close?.(); } catch {}
  delete global._dbAdapter;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
});

describe("release migration/rollback drill", () => {
  it("backs up before schema work and restores the critical settings row", async () => {
    const { getAdapter } = await import("@/lib/db/driver.js");
    const db = await getAdapter();
    db.run(
      `INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      [JSON.stringify({ releaseDrill: "before-migration" })]
    );
    // Force the next boot down the pre-schema-backup path.
    db.run(`UPDATE _meta SET value = '0' WHERE key = 'backupSchemaVersion'`);
    db.close?.();

    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: getAdapterAfterMigration } = await import("@/lib/db/driver.js");
    const migrated = await getAdapterAfterMigration();
    const backupRoot = path.join(tempDir, "db", "backups");
    const backupDirs = fs.readdirSync(backupRoot).filter((name) => name.startsWith("schema-0-to-1-"));
    expect(backupDirs.length).toBeGreaterThan(0);
    const backupFile = path.join(backupRoot, backupDirs.sort().at(-1), "data.sqlite");
    expect(fs.existsSync(backupFile)).toBe(true);

    const { createSqlJsAdapter } = await import("@/lib/db/adapters/sqljsAdapter.js");
    const backup = await createSqlJsAdapter(backupFile);
    expect(JSON.parse(backup.get(`SELECT data FROM settings WHERE id = 1`).data)).toEqual({ releaseDrill: "before-migration" });
    backup.close();

    // Restore the copy, restart the adapter, and prove the application can read it.
    migrated.close?.();
    fs.copyFileSync(backupFile, path.join(tempDir, "db", "data.sqlite"));
    delete global._dbAdapter;
    vi.resetModules();
    const { getAdapter: getAdapterAfterRollback } = await import("@/lib/db/driver.js");
    const restored = await getAdapterAfterRollback();
    expect(JSON.parse(restored.get(`SELECT data FROM settings WHERE id = 1`).data)).toEqual({ releaseDrill: "before-migration" });
  });
});
