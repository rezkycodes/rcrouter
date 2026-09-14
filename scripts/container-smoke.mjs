#!/usr/bin/env node

// Build and boot the published container with an ephemeral /app/data mount,
// then verify the public liveness endpoint. Local machines without Docker or
// Podman report an explicit skip; CI is strict so publication cannot bypass
// the drill.
import { spawnSync } from "node:child_process";

const cwd = new URL("..", import.meta.url);
const image = `rcrouter-smoke:${process.pid}-${Date.now().toString(36)}`;
const container = `rcrouter-smoke-${process.pid}`;
const engines = ["docker", "podman"];
let engine = null;
for (const candidate of engines) {
  const ready = spawnSync(candidate, ["info"], { cwd, stdio: "ignore" });
  if (!ready.error && ready.status === 0) {
    engine = candidate;
    break;
  }
}
const containerArgs = (args, options = {}) => spawnSync(engine || engines[0], args, { cwd, ...options });

if (!engine) {
  const reason = "Docker/Podman container engine is unavailable";
  if (process.env.CI === "true" || process.env.REQUIRE_DOCKER_SMOKE === "1") {
    console.error(`[release:container-smoke] Container engine required but unavailable: ${reason}`);
    process.exit(1);
  }
  console.warn(`[release:container-smoke] SKIP: ${reason}`);
  process.exit(0);
}
console.log(`[release:container-smoke] using ${engine}`);

let started = false;
const cleanup = () => {
  if (started) containerArgs(["rm", "--force", container], { stdio: "ignore" });
  if (process.env.KEEP_RELEASE_SMOKE_IMAGE !== "1") {
    containerArgs(["rmi", "--force", image], { stdio: "ignore" });
  }
};
process.once("exit", cleanup);

const build = containerArgs(["build", "--pull=false", "--tag", image, "."], { stdio: "inherit" });
if (build.status !== 0) {
  console.error(`[release:container-smoke] ${engine} build failed`);
  process.exit(build.status ?? 1);
}

const run = containerArgs([
  "run", "--detach", "--name", container,
  "--tmpfs", "/app/data:rw,size=64m",
  "--env", "NODE_ENV=production",
  "--env", "DATA_DIR=/app/data",
  "--env", "PORT=20128",
  "--publish", "127.0.0.1::20128",
  image,
], { encoding: "utf8" });
if (run.status !== 0) {
  console.error(`[release:container-smoke] ${engine} run failed:\n${run.stderr || ""}`);
  process.exit(run.status ?? 1);
}
started = true;

const port = containerArgs(["port", container, "20128/tcp"], { encoding: "utf8" });
const portMatch = String(port.stdout || "").match(/:(\d+)\s*$/m);
if (port.status !== 0 || !portMatch) {
  console.error(`[release:container-smoke] unable to resolve mapped port:\n${port.stderr || port.stdout || ""}`);
  process.exit(1);
}

const url = `http://127.0.0.1:${portMatch[1]}/api/health`;
const deadline = Date.now() + 60_000;
let lastError = "not ready";
while (Date.now() < deadline) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
    const body = await response.json();
    if (response.status === 200 && body?.ok === true) {
      console.log(`[release:container-smoke] PASS: ${url}`);
      process.exit(0);
    }
    lastError = `HTTP ${response.status} ${JSON.stringify(body)}`;
  } catch (error) {
    lastError = error?.message || String(error);
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
}

console.error(`[release:container-smoke] health check timed out: ${lastError}`);
const logs = containerArgs(["logs", "--tail", "120", container], { encoding: "utf8" });
if (logs.stdout || logs.stderr) console.error(`${logs.stdout || ""}${logs.stderr || ""}`);
process.exit(1);
