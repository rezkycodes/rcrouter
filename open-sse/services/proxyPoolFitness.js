// Durable proxy-pool fitness registry.
// Scope format: `provider::model` (for example `freebuff::openai/gpt-5`).
// The map on globalThis is a read-through cache; SQLite is the source of truth.
//
// This runs while chat requests are being served, so it fails open: a database
// error is logged once and then behaves as "no fitness data" (nothing blocked,
// or whatever this process already holds in memory). It never throws into the
// request path. isPoolFit / fitPoolIds only read the in-memory cache.

import {
  getProxyPoolById,
  updateProxyPool,
  listProxyPoolFitness,
  upsertProxyPoolFitness,
  deleteProxyPoolFitness,
  clearProxyPoolFitness,
} from "@/models";

const FITNESS_STATE_KEY = "__9routerPoolFitness__";
const fitness = (globalThis[FITNESS_STATE_KEY] ??= new Map());

// Process-wide bookkeeping, kept on globalThis next to the cache so route
// handlers and the engine (separate bundles) share it.
const META_STATE_KEY = "__9routerPoolFitnessState__";
const meta = (globalThis[META_STATE_KEY] ??= { legacyChecked: new Set(), warned: false });

export const POOL_UNFIT_MS = 5 * 60 * 1000;

function warnOnce(action, error) {
  if (meta.warned) return;
  meta.warned = true;
  console.warn(`[proxyPoolFitness] ${action} failed, continuing without durable fitness: ${error?.message || error}`);
}

// Run a database step; on failure log once and return `fallback`.
async function guarded(action, fn, fallback) {
  try {
    return await fn();
  } catch (error) {
    warnOnce(action, error);
    return fallback;
  }
}

function setPoolFitness(poolId, entries) {
  if (entries.length) fitness.set(poolId, new Map(entries.map((entry) => [entry.scope, { until: entry.until, reason: entry.reason || "" }])));
  else fitness.delete(poolId);
}

function updateCachedFitness(poolId, scope, until, reason = "") {
  const byScope = fitness.get(poolId) || new Map();
  byScope.set(scope, { until, reason });
  fitness.set(poolId, byScope);
}

function removeCachedScope(poolId, scope) {
  const byScope = fitness.get(poolId);
  if (!byScope) return;
  byScope.delete(scope);
  if (byScope.size === 0) fitness.delete(poolId);
}

function removeCachedProvider(provider) {
  const prefix = `${provider}::`;
  for (const [poolId, byScope] of fitness) {
    for (const scope of [...byScope.keys()]) if (scope.startsWith(prefix)) byScope.delete(scope);
    if (!byScope.size) fitness.delete(poolId);
  }
}

function pruneCache(now) {
  let expired = 0;
  for (const [poolId, byScope] of fitness) {
    for (const [scope, entry] of byScope) {
      if (entry.until <= now) {
        byScope.delete(scope);
        expired++;
      }
    }
    if (byScope.size === 0) fitness.delete(poolId);
  }
  return expired;
}

function deleteRows(rows) {
  return Promise.all(rows.map((row) => deleteProxyPoolFitness(row.poolId, row.scope)));
}

// Older builds kept fitness inside the pool's JSON (`pool.fitness`). Move the
// live entries into the table once, then drop the field so a block the user
// later clears can never be resurrected from it. Returns true if rows moved.
async function migrateLegacyFitness(poolId, now) {
  if (meta.legacyChecked.has(poolId)) return false;
  const moved = await guarded("legacy fitness migration", async () => {
    const pool = await getProxyPoolById(poolId);
    const legacy = Object.entries(pool?.fitness || {});
    const live = legacy.filter(([, entry]) => Number.isFinite(entry?.until) && entry.until > now);
    for (const [scope, entry] of live) await upsertProxyPoolFitness(poolId, scope, entry.until, entry.reason || "");
    // `undefined` is dropped when the pool is serialised, which removes the key.
    if (legacy.length) await updateProxyPool(poolId, { fitness: undefined });
    meta.legacyChecked.add(poolId);
    return live.length > 0;
  }, false);
  return moved;
}

export async function loadPoolFitness(poolId) {
  if (!poolId) return;
  const now = Date.now();
  let entries = await guarded("load", () => listProxyPoolFitness(poolId), null);
  if (entries === null) return;
  if (!entries.length && await migrateLegacyFitness(poolId, now)) {
    entries = await guarded("load", () => listProxyPoolFitness(poolId), entries);
  }
  setPoolFitness(poolId, entries.filter((entry) => entry.until > now));
  const expired = entries.filter((entry) => entry.until <= now);
  if (expired.length) await guarded("delete expired", () => deleteRows(expired), null);
}

// The mark always lands in memory so this process stops using the pool; the
// return value says whether it was also persisted.
export async function markPoolUnfit(poolId, scope, until = Date.now() + POOL_UNFIT_MS, reason = "") {
  if (!poolId || !scope || !Number.isFinite(until)) return false;
  const persisted = await guarded("mark", async () => {
    await upsertProxyPoolFitness(poolId, scope, until, reason);
    return true;
  }, false);
  updateCachedFitness(poolId, scope, until, reason);
  return persisted;
}

export async function clearPoolUnfit(poolId, scope) {
  if (!poolId || !scope) return false;
  const persisted = await guarded("clear", async () => {
    await deleteProxyPoolFitness(poolId, scope);
    return true;
  }, false);
  removeCachedScope(poolId, scope);
  return persisted;
}

function providerWildcardScope(scope) {
  const sep = String(scope || "").indexOf("::");
  if (sep < 0) return null;
  return `${scope.slice(0, sep)}::*`;
}

export function isPoolFit(poolId, scope, now = Date.now()) {
  if (!poolId) return true;
  const byScope = fitness.get(poolId);
  if (!byScope) return true;
  for (const key of [scope, providerWildcardScope(scope)]) {
    if (!key) continue;
    const entry = byScope.get(key);
    if (!entry) continue;
    if (entry.until <= now) {
      byScope.delete(key);
      if (byScope.size === 0) fitness.delete(poolId);
      continue;
    }
    return false;
  }
  return true;
}

export function fitPoolIds(poolIds, scope, now = Date.now()) {
  return (poolIds || []).filter((id) => isPoolFit(id, scope, now));
}

export async function clearAllPoolUnfit(provider = null) {
  const persisted = await guarded("clear all", async () => {
    await clearProxyPoolFitness(provider);
    return true;
  }, false);
  if (!provider) fitness.clear();
  else removeCachedProvider(provider);
  return persisted;
}

// Wipes the database rows as well as the cache (used by tests and admin reset).
export async function resetPoolFitness() {
  const persisted = await guarded("reset", async () => {
    await clearProxyPoolFitness();
    return true;
  }, false);
  fitness.clear();
  meta.legacyChecked.clear();
  meta.warned = false;
  return persisted;
}

export async function pruneExpired(now = Date.now()) {
  const rows = await guarded("prune", () => listProxyPoolFitness(), null);
  if (rows === null) return pruneCache(now);
  const expired = rows.filter((row) => row.until <= now);
  if (expired.length) await guarded("prune", () => deleteRows(expired), null);
  pruneCache(now);
  return expired.length;
}

function snapshotOf(entries) {
  const out = {};
  for (const { poolId, scope, until, reason } of entries) {
    const poolOut = out[poolId] || (out[poolId] = {});
    poolOut[scope] = { until, reason: reason || "" };
  }
  return out;
}

function cacheEntries(now) {
  pruneCache(now);
  return [...fitness].flatMap(([poolId, byScope]) => [...byScope].map(([scope, entry]) => ({ poolId, scope, ...entry })));
}

export async function poolFitnessSnapshot(now = Date.now()) {
  const rows = await guarded("snapshot", () => listProxyPoolFitness(), null);
  if (rows === null) return snapshotOf(cacheEntries(now));
  const expired = rows.filter((row) => row.until <= now);
  if (expired.length) await guarded("delete expired", () => deleteRows(expired), null);
  pruneCache(now);
  return snapshotOf(rows.filter((row) => row.until > now));
}
