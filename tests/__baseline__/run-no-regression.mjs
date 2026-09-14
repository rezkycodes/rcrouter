import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const baselineDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(baselineDir, "../..");
const reportDir = mkdtempSync(join(tmpdir(), "rcrouter-vitest-"));
const reportPath = join(reportDir, "results.json");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const extraArgs = process.argv.slice(2);

try {
  const testRun = spawnSync(
    pnpm,
    ["exec", "vitest", "run", "--config", "tests/vitest.config.js", "--reporter=json", "--outputFile", reportPath, ...extraArgs],
    { cwd: repoRoot, stdio: "inherit" },
  );

  if (testRun.error || !existsSync(reportPath)) {
    console.error("Vitest did not produce a JSON report; the baseline gate cannot evaluate this run.");
    process.exit(testRun.status || 2);
  }

  const gate = spawnSync(process.execPath, [join(baselineDir, "verify-no-regression.mjs"), reportPath], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  if (gate.status !== 0) process.exit(gate.status || 1);
  if (testRun.status !== 0) console.log("Vitest reported only reviewed baseline failures.");
} finally {
  rmSync(reportDir, { recursive: true, force: true });
}
