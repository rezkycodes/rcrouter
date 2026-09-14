#!/usr/bin/env node

// Exercise the optional Worker fixture through the same Vitest aliases used by
// the release suite. Sanitized checkouts without cloud sources remain explicit
// skips; restored checkouts must keep this fixture green.
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

if (!existsSync("cloud/src/handlers/embeddings.js")) {
  console.log("[release:cloud-smoke] SKIP: cloud Worker sources are not present");
  process.exit(0);
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const result = spawnSync(
  pnpm,
  [
    "exec",
    "vitest",
    "run",
    "--config",
    "tests/vitest.config.js",
    "tests/unit/embeddings.cloud.test.js",
    "tests/unit/cloud-worker-runtime.test.js",
  ],
  { stdio: "inherit" },
);

if (result.error) {
  console.error(`[release:cloud-smoke] unable to start Vitest: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
