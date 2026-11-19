import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The launcher must not hurt what it does not own. Before: a busy port made it kill every
// `next-server` process on the machine (including a separately installed 9router's) and whatever
// listened on the port; and any call, even `--version`, installed runtime packages into ~/.rcrouter.
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "../..");
const cliFile = path.join(repoRoot, "cli", "cli.js");
const { version } = require("../../cli/package.json");
const { findPortHolder, parseLsofHolder, parseNetstatHolder, parseSsHolder } = require("../../cli/src/cli/utils/launcherProcess.js");

const posixOnly = it.skipIf(process.platform === "win32");
const PORT = 20994;
const tempDirs = [];
const children = [];

function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (children.length) {
    try { process.kill(children.pop(), "SIGKILL"); } catch { /* already gone */ }
  }
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

// Stand-ins for the tools the launcher shells out to, so a test can never touch a real process
// or the network: `ps` lists nothing, `lsof` names the fake holder, `npm` fails at once.
function stubBin(holderPid) {
  const dir = tmp("rcrouter-stubs-");
  const script = (name, body) => {
    fs.writeFileSync(path.join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  };
  script("ps", "echo 'USER PID COMMAND'");
  script("npm", "exit 1");
  script("lsof", `case "$*" in *-ti:*) echo ${holderPid};; *) printf 'p${holderPid}\\nc%s\\n' fake-holder;; esac`);
  return dir;
}

function runCli(args, { home, bin }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliFile, ...args], {
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        HOME: home,
        USERPROFILE: home,
        NODE_ENV: "test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child.pid);
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    child.stderr.on("data", (chunk) => { out += chunk; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`launcher did not exit within 20s. Output so far:\n${out}`));
    }, 20000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
}

async function startForeignListener() {
  const source = `require("net").createServer().listen(${PORT}, "127.0.0.1", () => console.log("up")); setInterval(() => {}, 1000);`;
  const holder = spawn(process.execPath, ["-e", source], { stdio: ["ignore", "pipe", "ignore"] });
  children.push(holder.pid);
  await new Promise((resolve) => holder.stdout.once("data", resolve));
  return holder.pid;
}

const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

describe("--version and --help change nothing", () => {
  posixOnly.each([["--version"], ["-v"]])("%s prints the version and writes nothing under HOME", async (flag) => {
    const home = tmp("rcrouter-home-");

    const { code, out } = await runCli([flag], { home, bin: stubBin(1) });

    expect(code).toBe(0);
    expect(out.trim()).toBe(version);
    expect(fs.readdirSync(home)).toEqual([]);
  });

  posixOnly("--help prints usage and writes nothing under HOME", async () => {
    const home = tmp("rcrouter-home-");

    const { code, out } = await runCli(["--help"], { home, bin: stubBin(1) });

    expect(code).toBe(0);
    expect(out).toMatch(/Usage:/);
    expect(fs.readdirSync(home)).toEqual([]);
  });
});

describe("a busy port", () => {
  posixOnly("stops the launch and leaves the process holding it alone", async () => {
    const holderPid = await startForeignListener();
    const home = tmp("rcrouter-home-");

    const { code, out } = await runCli(["--port", String(PORT), "--skip-update", "--no-browser"], {
      home,
      bin: stubBin(holderPid),
    });

    expect(code).toBe(1);
    expect(out).toContain(`Port ${PORT} is already in use by fake-holder (pid ${holderPid})`);
    expect(out).toMatch(/leaves that process alone/);
    expect(isAlive(holderPid)).toBe(true);
    // it stopped before installing anything
    expect(fs.existsSync(path.join(home, ".rcrouter", "runtime"))).toBe(false);
  });
});

describe("the launcher source", () => {
  const source = fs.readFileSync(cliFile, "utf8");

  it("has no machine-wide process kill and no kill-by-port", () => {
    expect(source).not.toMatch(/killAllAppProcesses|killProcessOnPort/);
  });

  it("never matches other servers by name (next-server is also what upstream 9router runs)", () => {
    expect(source).not.toMatch(/next-server/);
  });
});

describe("finding what holds a port", () => {
  it("reads lsof output", () => {
    expect(parseLsofHolder("p4242\ncnext-server (v1\n")).toEqual({ pid: 4242, name: "next-server (v1" });
    expect(parseLsofHolder("")).toBeNull();
  });

  it("reads ss output", () => {
    const row = 'LISTEN 0 511 0.0.0.0:20128 0.0.0.0:* users:(("next-server (v1",pid=463120,fd=21))';

    expect(parseSsHolder(row)).toEqual({ pid: 463120, name: "next-server (v1" });
    expect(parseSsHolder("")).toBeNull();
  });

  it("reads netstat output, matching the whole port number", () => {
    const rows = [
      "  TCP    0.0.0.0:201280         0.0.0.0:0              LISTENING       99",
      "  TCP    0.0.0.0:20128          0.0.0.0:0              LISTENING       4321",
    ].join("\n");

    expect(parseNetstatHolder(rows, 20128)).toEqual({ pid: 4321, name: "" });
    expect(parseNetstatHolder("  TCP  10.0.0.1:50000  10.0.0.2:20128  ESTABLISHED  55", 20128)).toBeNull();
  });

  posixOnly("falls back to ss when lsof finds nothing, and gives up quietly when both fail", () => {
    const ss = 'LISTEN 0 511 0.0.0.0:20128 0.0.0.0:* users:(("next-server (v1",pid=7,fd=21))';
    const lsofMissesIt = (cmd) => {
      if (cmd === "lsof") throw Object.assign(new Error("exit 1"), { status: 1 });
      return ss;
    };

    expect(findPortHolder(20128, { run: lsofMissesIt })).toEqual(process.platform === "linux" ? { pid: 7, name: "next-server (v1" } : null);
    expect(findPortHolder(20128, { run: () => { throw new Error("no such tool"); } })).toBeNull();
  });
});
