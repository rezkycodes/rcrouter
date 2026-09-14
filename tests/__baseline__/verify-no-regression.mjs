// Gate the current result against the reviewed baseline snapshot.
// New tests are allowed; an existing test that starts failing is not.
// Usage: node tests/__baseline__/verify-no-regression.mjs <current-results.json>
import { readFileSync } from "fs";

const resultsPath = process.argv[2];
if (!resultsPath) { console.error("Missing results.json path"); process.exit(2); }

const normalizeTestPath = (name) => {
  const normalized = String(name).replaceAll("\\", "/");
  const marker = "/tests/";
  const index = normalized.lastIndexOf(marker);
  return index === -1 ? normalized : `tests/${normalized.slice(index + marker.length)}`;
};

const failuresFrom = (result) => (result.testResults || []).flatMap((file) =>
  (file.assertionResults || [])
    .filter((assertion) => assertion.status === "failed")
    .map((assertion) => `${normalizeTestPath(file.name)} :: ${assertion.fullName}`)
);

const baseline = JSON.parse(readFileSync(new URL("./current.json", import.meta.url), "utf8"));
const current = JSON.parse(readFileSync(resultsPath, "utf8"));
const baselineFails = new Set(failuresFrom(baseline));
const nowFails = failuresFrom(current);

const regressions = nowFails.filter((failure) => !baselineFails.has(failure));
const resolved = [...baselineFails].filter((failure) => !nowFails.includes(failure));

if (regressions.length) {
  console.error(`\n❌ REGRESSION: ${regressions.length} newly failing test(s):\n`);
  regressions.forEach((failure) => console.error("  - " + failure));
  process.exit(1);
}
console.log(`✅ No regression. (current failures=${nowFails.length}, baseline failures=${baselineFails.size}, resolved=${resolved.length})`);
