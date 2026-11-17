// Migration 003: persist proxy-pool fitness by pool and scope.
// Purely additive and idempotent (CREATE ... IF NOT EXISTS): it never reads,
// rewrites or drops existing data, so it is safe on a live v2 database and when
// re-run. Fresh databases already get the table from 001 (it builds every table
// in TABLES); this migration is what upgrades databases created before it existed.
import { TABLES, buildCreateTableSql } from "../schema.js";

const migration = {
  version: 3,
  name: "add-proxy-pool-fitness",
  up(db) {
    const def = TABLES.proxyPoolFitness;
    db.exec(buildCreateTableSql("proxyPoolFitness", def));
    for (const idx of def.indexes || []) db.exec(idx);
  },
};

export default migration;
