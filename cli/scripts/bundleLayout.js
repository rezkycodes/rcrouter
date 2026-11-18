"use strict";

// The package ships its own node_modules (app/node_modules), so every package in it must sit
// together with the packages it requires. pnpm's default layout does not: each package is a
// symlink to node_modules/.pnpm/<id>/node_modules/<name> and its dependencies are NEXT TO it.
// build-cli.js copies a symlink as a plain folder, which cuts the copy off from those
// neighbours: 1.1.1-1.1.3 shipped a `next` that could not find @swc/helpers (the server died on
// boot), an `open` without wsl-utils and an AWS SDK without @smithy/core.
// The hoisted linker lays node_modules out flat, like npm does, and has no such problem.

const fs = require("fs");
const path = require("path");

const HOW_TO_FIX =
  "Install the app dependencies with pnpm's hoisted linker, then build again:\n" +
  "  pnpm install --frozen-lockfile --config.node-linker=hoisted";

// Before the (long) app build: is the installed node_modules in pnpm's isolated layout?
function isolatedLayoutProblem(appDir) {
  let isLink;
  try {
    isLink = fs.lstatSync(path.join(appDir, "node_modules", "next")).isSymbolicLink();
  } catch {
    return null; // not installed: the build reports that itself
  }
  if (!isLink) return null;
  return `node_modules was installed with pnpm's default (isolated) layout; a package built from it would not start.\n${HOW_TO_FIX}`;
}

// After copying: does the bundle still carry the isolated layout?
function bundleProblem(cliAppDir) {
  if (!fs.existsSync(path.join(cliAppDir, "node_modules", ".pnpm"))) return null;
  return `${path.join(cliAppDir, "node_modules", ".pnpm")} is in the bundle: its packages are cut off from their dependencies.\n${HOW_TO_FIX}`;
}

module.exports = { isolatedLayoutProblem, bundleProblem };
