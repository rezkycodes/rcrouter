#!/usr/bin/env node

const baseUrl = (process.env.RCROUTER_BASE_URL || "http://127.0.0.1:20128").replace(/\/$/, "");
const healthPath = process.env.RCROUTER_HEALTH_PATH || "/api/health";
const versionPath = process.env.RCROUTER_VERSION_PATH || "/api/version";
const metricsUrl = process.env.RCROUTER_METRICS_URL || "";
const expectedVersion = process.env.RCROUTER_EXPECTED_VERSION || "";
const rolloutSeconds = Number.parseInt(process.env.RCROUTER_ROLLOUT_SECONDS || "60", 10);
const intervalMs = Math.max(1000, Number.parseInt(process.env.RCROUTER_ROLLOUT_INTERVAL_MS || "5000", 10));

if (!Number.isInteger(rolloutSeconds) || rolloutSeconds < 1 || rolloutSeconds > 3600) {
  console.error("[release:staged-check] RCROUTER_ROLLOUT_SECONDS must be an integer between 1 and 3600");
  process.exit(2);
}

const headers = {};
if (process.env.RCROUTER_HEALTH_TOKEN) headers.Authorization = `Bearer ${process.env.RCROUTER_HEALTH_TOKEN}`;

async function getJson(url, label) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

async function probe() {
  const health = await getJson(`${baseUrl}${healthPath}`, "health endpoint");
  if (health?.ok !== true) throw new Error("health endpoint did not report ok=true");

  if (expectedVersion) {
    const version = await getJson(`${baseUrl}${versionPath}`, "version endpoint");
    if (version?.currentVersion !== expectedVersion) {
      throw new Error(`expected version ${expectedVersion}, got ${version?.currentVersion || "unknown"}`);
    }
  }

  if (metricsUrl) await getJson(metricsUrl, "metrics endpoint");
}

const deadline = Date.now() + rolloutSeconds * 1000;
let probes = 0;
console.log(`[release:staged-check] observing ${baseUrl} for ${rolloutSeconds}s`);

while (Date.now() < deadline) {
  try {
    await probe();
    probes++;
    const remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    console.log(`[release:staged-check] probe ${probes} passed (${remaining}s remaining)`);
  } catch (error) {
    console.error(`[release:staged-check] FAILED: ${error.message}`);
    process.exit(1);
  }

  const sleepMs = Math.min(intervalMs, Math.max(0, deadline - Date.now()));
  if (sleepMs > 0) await new Promise((resolve) => setTimeout(resolve, sleepMs));
}

console.log(`[release:staged-check] PASS: ${probes} health probe(s) completed`);
