import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Installing @rezkycodes/rcrouter must run no code. npm 12 blocks install scripts that are not on
// the user's allow-list and prints `npm warn install-scripts ... postinstall blocked` on every
// `npm i -g`. The SQLite and tray runtimes are installed by the launcher the first time the
// server starts, so nothing needs to run at install time.
const require = createRequire(import.meta.url);
const cliDir = path.resolve(import.meta.dirname, "../../cli");
const pkg = require("../../cli/package.json");

describe("the published CLI package", () => {
  it.each(["preinstall", "install", "postinstall"])("has no %s script", (name) => {
    expect(pkg.scripts?.[name]).toBeUndefined();
  });

  it("has no binding.gyp (npm would add an implicit node-gyp install script for it)", () => {
    expect(fs.existsSync(path.join(cliDir, "binding.gyp"))).toBe(false);
  });

  it("does not ship an install hook that nothing runs", () => {
    expect(fs.existsSync(path.join(cliDir, "hooks", "postinstall.js"))).toBe(false);
  });

  it("still installs the runtimes when the server starts", () => {
    const launcher = fs.readFileSync(path.join(cliDir, "cli.js"), "utf8");

    expect(launcher).toMatch(/ensureSqliteRuntime\(/);
    expect(launcher).toMatch(/ensureTrayRuntime\(/);
  });
});
