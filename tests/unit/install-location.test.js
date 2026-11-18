import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Where RcRouter keeps its files (~/.rcrouter, not 9router's ~/.9router) and the pieces of the
// dashboard that must follow the running code (changelog) or stay out of it (promo links).
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "../..");
const posixOnly = it.skipIf(process.platform === "win32");

const tempDirs = [];
let home;

function tmp(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function put(root, relativePath, contents = "x") {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

beforeEach(() => {
  home = tmp("rcrouter-home-");
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("DATA_DIR", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function loadMitmPaths() {
  const file = require.resolve("../../src/mitm/paths.js");
  delete require.cache[file];
  return require(file);
}

describe("MITM data directory", () => {
  posixOnly("lives under ~/.rcrouter", () => {
    const { DATA_DIR, MITM_DIR } = loadMitmPaths();

    expect(DATA_DIR).toBe(path.join(home, ".rcrouter"));
    expect(MITM_DIR).toBe(path.join(home, ".rcrouter", "mitm"));
  });

  posixOnly("carries the trusted root CA over once, without stale pid/lock files", () => {
    put(home, ".9router/mitm/rootCA.crt", "cert");
    put(home, ".9router/mitm/rootCA.key", "key");
    put(home, ".9router/mitm/aliases.json", "{}");
    put(home, ".9router/mitm/.mitm.pid", "4242");
    put(home, ".9router/mitm/.mitm.lock", "lock");

    const { MITM_DIR } = loadMitmPaths();

    expect(fs.readFileSync(path.join(MITM_DIR, "rootCA.crt"), "utf8")).toBe("cert");
    expect(fs.readFileSync(path.join(MITM_DIR, "rootCA.key"), "utf8")).toBe("key");
    expect(fs.existsSync(path.join(MITM_DIR, "aliases.json"))).toBe(true);
    expect(fs.existsSync(path.join(MITM_DIR, ".mitm.pid"))).toBe(false);
    expect(fs.existsSync(path.join(MITM_DIR, ".mitm.lock"))).toBe(false);
    // the 9router copy is left alone
    expect(fs.readFileSync(path.join(home, ".9router/mitm/rootCA.crt"), "utf8")).toBe("cert");
  });

  posixOnly("never overwrites an existing RcRouter MITM directory", () => {
    put(home, ".9router/mitm/rootCA.crt", "old");
    put(home, ".rcrouter/mitm/rootCA.crt", "new");

    const { MITM_DIR } = loadMitmPaths();

    expect(fs.readFileSync(path.join(MITM_DIR, "rootCA.crt"), "utf8")).toBe("new");
  });

  posixOnly("does not migrate when DATA_DIR points somewhere else", () => {
    put(home, ".9router/mitm/rootCA.crt", "old");
    const custom = tmp("rcrouter-custom-");
    vi.stubEnv("DATA_DIR", custom);

    const { MITM_DIR } = loadMitmPaths();

    expect(MITM_DIR).toBe(path.join(custom, "mitm"));
    expect(fs.existsSync(path.join(MITM_DIR, "rootCA.crt"))).toBe(false);
  });
});

describe("app data directory migration", () => {
  posixOnly("copies the 9router data but not its native runtime/", async () => {
    put(home, ".9router/db/data.sqlite", "db");
    put(home, ".9router/connect.env", "NINE_ROUTER_SERVER=x");
    put(home, ".9router/runtime/node_modules/better-sqlite3/index.js", "native");
    vi.spyOn(console, "log").mockImplementation(() => {});

    const { DATA_DIR } = await import("../../src/lib/dataDir.js");

    expect(DATA_DIR).toBe(path.join(home, ".rcrouter"));
    expect(fs.readFileSync(path.join(DATA_DIR, "db", "data.sqlite"), "utf8")).toBe("db");
    expect(fs.existsSync(path.join(DATA_DIR, "connect.env"))).toBe(true);
    expect(fs.existsSync(path.join(DATA_DIR, "runtime"))).toBe(false);
    expect(fs.existsSync(path.join(home, ".9router/runtime/node_modules/better-sqlite3/index.js"))).toBe(true);
  });

  posixOnly("leaves an existing ~/.rcrouter database untouched", async () => {
    put(home, ".9router/db/data.sqlite", "legacy");
    put(home, ".rcrouter/db/data.sqlite", "mine");

    const { DATA_DIR } = await import("../../src/lib/dataDir.js");

    expect(fs.readFileSync(path.join(DATA_DIR, "db", "data.sqlite"), "utf8")).toBe("mine");
  });
});

describe("CLI runtime location", () => {
  const sqliteRuntime = () => require("../../cli/hooks/sqliteRuntime.js");

  posixOnly("installs the SQLite runtime into ~/.rcrouter/runtime", () => {
    expect(sqliteRuntime().getRuntimeDir()).toBe(path.join(home, ".rcrouter", "runtime"));
  });

  posixOnly("follows DATA_DIR when it is set", () => {
    const custom = tmp("rcrouter-custom-");
    vi.stubEnv("DATA_DIR", custom);

    expect(sqliteRuntime().getRuntimeDir()).toBe(path.join(custom, "runtime"));
  });
});

describe("changelog shown in the dashboard", () => {
  it("serves the CHANGELOG.md that ships next to the running app", async () => {
    const appDir = tmp("rcrouter-app-");
    put(appDir, "CHANGELOG.md", "# v9.9.9 (2030-01-01)\n\n- something new\n");
    vi.spyOn(process, "cwd").mockReturnValue(appDir);
    const { GET } = await import("../../src/app/api/changelog/route.js");

    const res = await GET();

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/markdown/);
    expect(await res.text()).toContain("# v9.9.9 (2030-01-01)");
  });

  it("answers 404 when the build does not carry a changelog", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(tmp("rcrouter-empty-"));
    const { GET } = await import("../../src/app/api/changelog/route.js");

    const res = await GET();

    expect(res.status).toBe(404);
    expect((await res.json()).error).toMatch(/not bundled/);
  });

  it("answers 500 and logs when the file cannot be read", async () => {
    const appDir = tmp("rcrouter-bad-");
    fs.mkdirSync(path.join(appDir, "CHANGELOG.md")); // a directory: EISDIR
    vi.spyOn(process, "cwd").mockReturnValue(appDir);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await import("../../src/app/api/changelog/route.js");

    const res = await GET();

    expect(res.status).toBe(500);
    expect(logged).toHaveBeenCalled();
  });

  it("has an entry for the version being built, so a version bump never ships without notes", () => {
    const { version } = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
    const changelog = fs.readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");

    expect(changelog).toMatch(new RegExp(`^# v${version.replace(/\./g, "\\.")} \\(`, "m"));
  });

  it("is requested from the local route, never from upstream's hosted copy", async () => {
    const { GITHUB_CONFIG } = await import("../../src/shared/constants/config.js");

    expect(GITHUB_CONFIG.changelogUrl).toBe("/api/changelog");
  });
});

describe("dashboard sidebar", () => {
  it("carries no promo links to other products", () => {
    const sidebar = fs.readFileSync(path.join(repoRoot, "src/shared/components/Sidebar.js"), "utf8");

    expect(sidebar).not.toMatch(/9remote|9english/i);
  });
});
