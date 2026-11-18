#!/usr/bin/env node
"use strict";

// Starts the PACKED app the way `rcrouter` does and checks that it answers HTTP.
//
// `npm publish` ships whatever build-cli.js produced, and nothing used to start it: 1.1.1-1.1.3
// went out with a server that died on boot (pnpm's symlinked node_modules were copied as detached
// directories, so `next` could not find `@swc/helpers`). Run this on the packed tarball before
// publishing. It uses a throwaway HOME/DATA_DIR and a spare port; it never touches ~/.rcrouter,
// the default port (20128) or an installed copy of the launcher.
//
//   node scripts/smokeStart.js <package.tgz | unpacked package dir> [--port 20991] [--timeout 90]
//
// Exit code 0 = the app started and served /login and /favicon.svg; 1 = it did not.
//
// Pass the tarball, not a folder inside a checkout: Node resolves modules by walking up from the
// app, so a folder under a repo that has its own node_modules could hide a dependency the
// package is missing.

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const DEFAULT_PORT = 20991;
const DEFAULT_TIMEOUT_S = 90;
const LOG_TAIL_LINES = 40;
const CHECKS = [
  { url: "/login", describe: "login page", ok: (status) => status === 200 },
  { url: "/favicon.svg", describe: "public assets", ok: (status, body) => status === 200 && body.includes("<svg") },
];

function parseArgs(argv) {
  const args = { input: null, port: DEFAULT_PORT, timeoutS: DEFAULT_TIMEOUT_S };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--port") args.port = Number(argv[++i]);
    else if (arg === "--timeout") args.timeoutS = Number(argv[++i]);
    else if (!args.input) args.input = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  if (!args.input) throw new Error("Usage: smokeStart.js <package.tgz | package dir> [--port N] [--timeout SECONDS]");
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) throw new Error(`Invalid --port: ${args.port}`);
  if (!(args.timeoutS > 0)) throw new Error(`Invalid --timeout: ${args.timeoutS}`);
  return args;
}

// A tarball unpacks to <tmp>/package; a directory is used as it is.
function resolvePackageRoot(input, scratch) {
  const stat = fs.statSync(input);
  if (stat.isDirectory()) return path.resolve(input);
  const out = path.join(scratch, "unpacked");
  fs.mkdirSync(out, { recursive: true });
  const untar = spawnSync("tar", ["-xzf", input, "-C", out], { encoding: "utf8" });
  if (untar.status !== 0) throw new Error(`Cannot unpack ${input}: ${untar.stderr || untar.error}`);
  return path.join(out, "package");
}

function findServerEntry(appDir) {
  for (const name of ["custom-server.js", "server.js"]) {
    const file = path.join(appDir, name);
    if (fs.existsSync(file)) return file;
  }
  throw new Error(`No custom-server.js or server.js in ${appDir}`);
}

// Same environment cli.js gives the server: runtime + bundled node_modules on NODE_PATH.
function buildServerEnv(packageRoot, home, dataDir, port) {
  const { buildEnvWithRuntime } = require(path.join(packageRoot, "hooks", "sqliteRuntime.js"));
  const base = {
    PATH: process.env.PATH,
    // Node and its child processes need these on Windows to start at all.
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP } : {}),
    HOME: home,
    USERPROFILE: home,
    DATA_DIR: dataDir,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    INITIAL_PASSWORD: "smoke-test-password",
    JWT_SECRET: "smoke-test-secret-smoke-test-secret",
    API_KEY_SECRET: "smoke-test-api-key-secret",
    MACHINE_ID_SALT: "smoke-test-salt",
  };
  // The package locates its runtime through HOME/DATA_DIR of THIS process, so point them at the
  // throwaway directories only while it builds the environment, then put them back.
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, DATA_DIR: process.env.DATA_DIR };
  Object.assign(process.env, { HOME: home, USERPROFILE: home, DATA_DIR: dataDir });
  try {
    return { ...buildEnvWithRuntime(base), PORT: String(port), HOSTNAME: "127.0.0.1" };
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Another process on the port would answer our requests and hide a server that failed to start.
function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", (error) => reject(new Error(`Port ${port} is not free (${error.code}); pass another with --port.`)));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
  });
}

async function get(port, url) {
  const res = await fetch(`http://127.0.0.1:${port}${url}`, { redirect: "manual", signal: AbortSignal.timeout(5000) });
  return { status: res.status, body: await res.text() };
}

async function waitUntilUp(port, deadline, hasExited) {
  while (Date.now() < deadline) {
    if (hasExited()) return false;
    try {
      const { status } = await get(port, "/login");
      if (status < 500) return true;
    } catch { /* not listening yet */ }
    await sleep(500);
  }
  return false;
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  for (let i = 0; i < 10 && child.exitCode === null && child.signalCode === null; i++) await sleep(300);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function main(argv) {
  const args = parseArgs(argv);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "rcrouter-smoke-"));
  let child = null;
  const output = [];
  try {
    const packageRoot = resolvePackageRoot(args.input, scratch);
    const entry = findServerEntry(path.join(packageRoot, "app"));
    const home = path.join(scratch, "home");
    const dataDir = path.join(scratch, "data");
    fs.mkdirSync(home, { recursive: true });
    await assertPortFree(args.port);
    const env = buildServerEnv(packageRoot, home, dataDir, args.port);

    console.log(`Starting ${path.relative(packageRoot, entry)} from ${packageRoot} on 127.0.0.1:${args.port}`);
    child = spawn(process.execPath, [entry], { cwd: path.dirname(entry), env, stdio: ["ignore", "pipe", "pipe"] });
    const collect = (chunk) => output.push(...String(chunk).split("\n").filter(Boolean));
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);

    const up = await waitUntilUp(args.port, Date.now() + args.timeoutS * 1000, () => child.exitCode !== null);
    if (!up) {
      const why = child.exitCode !== null ? `exited with code ${child.exitCode}` : `did not answer within ${args.timeoutS}s`;
      throw new Error(`The packed app ${why}.\n${output.slice(-LOG_TAIL_LINES).join("\n")}`);
    }
    for (const check of CHECKS) {
      const { status, body } = await get(args.port, check.url);
      if (!check.ok(status, body)) throw new Error(`GET ${check.url} (${check.describe}) answered ${status}`);
      console.log(`  ok  GET ${check.url} -> ${status}`);
    }
    console.log("The packed app starts and serves its pages.");
    return 0;
  } catch (error) {
    console.error(`SMOKE TEST FAILED: ${error.message}`);
    return 1;
  } finally {
    if (child) await stop(child);
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

module.exports = { main, parseArgs };
