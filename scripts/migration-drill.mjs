#!/usr/bin/env node

// Keep the release drill on the same Vitest configuration as the normal suite.
// The test uses a temporary DATA_DIR and exercises the real migration/backup
// code, so no operator database or credentials are touched.
import { spawnSync } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const result = spawnSync(
  pnpm,
  ["exec", "vitest", "run", "--config", "tests/vitest.config.js", "tests/unit/db-release-drill.test.js"],
  { stdio: "inherit", cwd: new URL("..", import.meta.url) }
);

if (result.error) {
  console.error(`[release:migration-drill] unable to start Vitest: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
