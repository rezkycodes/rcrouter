import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const baselineDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(baselineDir, "../..");
const reportDir = mkdtempSync(join(tmpdir(), "rcrouter-eslint-"));
const reportPath = join(reportDir, "results.json");
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

const lintErrors = (report) => report.flatMap((file) =>
  file.messages
    .filter((message) => message.severity === 2)
    .map((message) => `${normalizeLintPath(file.filePath)} :: ${message.ruleId} :: ${message.message}`)
);

// Baseline reports were captured on a developer workstation and therefore
// contain absolute paths. Normalize both historical and current reports to
// repository-relative paths so the comparator remains portable in CI clones.
const normalizeLintPath = (filePath) => {
  const normalized = String(filePath).replaceAll("\\\\", "/");
  const repoRelative = relative(repoRoot, normalized).replaceAll("\\\\", "/");
  if (!repoRelative.startsWith("../") && repoRelative !== "..") return repoRelative;

  const rootMarkers = [
    "/bin/", "/cli/", "/cloud/", "/docs/", "/gitbook/", "/open-sse/",
    "/scripts/", "/skills/", "/src/", "/tests/", "/public/",
  ];
  for (const marker of rootMarkers) {
    const index = normalized.lastIndexOf(marker);
    if (index !== -1) return normalized.slice(index + 1);
  }

  const rootFile = normalized.match(/\/[^/]+\/(?:package|server|custom-server|next\.config|middleware|instrumentation)[^/]*$/);
  return rootFile ? rootFile[0].slice(1) : normalized;
};

try {
  const lintRun = spawnSync(
    pnpm,
    ["exec", "eslint", ".", "--format", "json", "--output-file", reportPath],
    { cwd: repoRoot, stdio: "inherit" },
  );

  if (lintRun.error || !existsSync(reportPath)) {
    console.error("ESLint did not produce a JSON report; the baseline gate cannot evaluate this run.");
    process.exit(lintRun.status || 2);
  }

  const baseline = new Set(lintErrors(JSON.parse(readFileSync(join(baselineDir, "lint-current.json"), "utf8"))));
  const current = lintErrors(JSON.parse(readFileSync(reportPath, "utf8")));
  const regressions = current.filter((error) => !baseline.has(error));

  if (regressions.length) {
    console.error(`\n❌ LINT REGRESSION: ${regressions.length} new error(s):\n`);
    regressions.forEach((error) => console.error(`  - ${error}`));
    process.exit(1);
  }

  console.log(`✅ No lint regression. (current errors=${current.length}, baseline errors=${baseline.size})`);
  if (lintRun.status !== 0) console.log("ESLint reported only reviewed baseline errors.");
} finally {
  rmSync(reportDir, { recursive: true, force: true });
}
