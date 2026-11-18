import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// The guard that stops a package built from pnpm's isolated node_modules (symlinks to .pnpm/<id>)
// from being published: copied as plain folders, its packages lose their dependencies.
const require = createRequire(import.meta.url);
const { isolatedLayoutProblem, bundleProblem } = require("../../cli/scripts/bundleLayout.js");

const tempDirs = [];
function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rcrouter-layout-"));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe("isolatedLayoutProblem (checked before building)", () => {
  it("flags node_modules/next being a symlink into .pnpm", () => {
    const app = tmp();
    const store = path.join(app, "node_modules", ".pnpm", "next@16", "node_modules", "next");
    fs.mkdirSync(store, { recursive: true });
    fs.symlinkSync(store, path.join(app, "node_modules", "next"), "dir");

    expect(isolatedLayoutProblem(app)).toMatch(/hoisted/);
  });

  it("accepts a flat node_modules/next folder", () => {
    const app = tmp();
    fs.mkdirSync(path.join(app, "node_modules", "next"), { recursive: true });

    expect(isolatedLayoutProblem(app)).toBeNull();
  });

  it("leaves a missing node_modules to the build to report", () => {
    expect(isolatedLayoutProblem(tmp())).toBeNull();
  });
});

describe("bundleProblem (checked on the copied bundle)", () => {
  it("flags a bundle that still carries .pnpm", () => {
    const bundle = tmp();
    fs.mkdirSync(path.join(bundle, "node_modules", ".pnpm", "next@16"), { recursive: true });

    expect(bundleProblem(bundle)).toMatch(/\.pnpm.*hoisted/s);
  });

  it("accepts a flat bundle", () => {
    const bundle = tmp();
    fs.mkdirSync(path.join(bundle, "node_modules", "next"), { recursive: true });

    expect(bundleProblem(bundle)).toBeNull();
  });
});
