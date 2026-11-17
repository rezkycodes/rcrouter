// Durable proxy-pool fitness rows. One row per (poolId, scope): the pool is
// unfit for that `provider::model` (or `provider::*`) scope until `until`
// (epoch ms). The in-memory read-through cache lives in
// open-sse/services/proxyPoolFitness.js; SQLite is the source of truth.
import { getAdapter } from "../driver.js";

function rowToFitness(row) {
  return {
    poolId: row.poolId,
    scope: row.scope,
    until: row.until,
    reason: row.reason || "",
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listProxyPoolFitness(poolId) {
  const db = await getAdapter();
  const rows = poolId === undefined || poolId === null
    ? db.all("SELECT * FROM proxyPoolFitness ORDER BY poolId, scope")
    : db.all("SELECT * FROM proxyPoolFitness WHERE poolId = ? ORDER BY scope", [poolId]);
  return rows.map(rowToFitness);
}

export async function upsertProxyPoolFitness(poolId, scope, until, reason = "") {
  if (!poolId || !scope || !Number.isFinite(until)) return null;
  const db = await getAdapter();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO proxyPoolFitness(poolId, scope, until, reason, createdAt, updatedAt)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(poolId, scope) DO UPDATE SET
       until = excluded.until, reason = excluded.reason, updatedAt = excluded.updatedAt`,
    [poolId, scope, until, reason || "", now, now]
  );
  return rowToFitness(db.get("SELECT * FROM proxyPoolFitness WHERE poolId = ? AND scope = ?", [poolId, scope]));
}

export async function deleteProxyPoolFitness(poolId, scope) {
  const db = await getAdapter();
  return db.run("DELETE FROM proxyPoolFitness WHERE poolId = ? AND scope = ?", [poolId, scope]);
}

// Clear every row, or every scope of one provider (`provider::model` and
// `provider::*`). The prefix is compared with substr(), not LIKE, so `_` and `%`
// in a provider name are literal characters.
export async function clearProxyPoolFitness(provider = null) {
  const db = await getAdapter();
  if (provider) {
    const prefix = `${provider}::`;
    return db.run("DELETE FROM proxyPoolFitness WHERE substr(scope, 1, ?) = ?", [prefix.length, prefix]);
  }
  return db.run("DELETE FROM proxyPoolFitness");
}

export async function deleteProxyPoolFitnessByPool(poolId) {
  const db = await getAdapter();
  return db.run("DELETE FROM proxyPoolFitness WHERE poolId = ?", [poolId]);
}
