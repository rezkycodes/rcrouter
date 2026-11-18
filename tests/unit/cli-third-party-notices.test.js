import assert from "node:assert/strict";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let testApi;
try {
  testApi = await import("vitest");
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error;
  testApi = await import("node:test");
}
const { afterEach, describe, it } = testApi;

const require = createRequire(import.meta.url);
const {
  MIN_PACKAGES,
  OUTPUT_FILE_NAME,
  listShippedPackages,
  readLicenseTexts,
  writeThirdPartyNotices,
} = require("../../cli/scripts/thirdPartyNotices.js");

const tempDirs = [];

function createTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rcrouter-notices-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

function write(root, relativePath, contents) {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

const MIT = (holder) => `MIT License\n\nCopyright (c) ${holder}\n\nPermission is hereby granted, free of charge...\n`;
const APACHE = "Apache License\nVersion 2.0, January 2004\nhttp://www.apache.org/licenses/\n";

// A pnpm-store style package directory plus the matching `pnpm licenses` row.
function addStorePackage(storeRoot, { name, version = "1.0.0", license = "MIT", files = {} }) {
  const dir = path.join(storeRoot, `${name.replace("/", "+")}@${version}`, "node_modules", name);
  write(dir, "package.json", JSON.stringify({ name, version, license }));
  for (const [file, text] of Object.entries(files)) write(dir, file, text);
  return { name, version, license, author: "", source: "", dir };
}

function fillerRows(storeRoot, count) {
  return Array.from({ length: count }, (_, i) =>
    addStorePackage(storeRoot, { name: `filler-${i}`, files: { LICENSE: MIT(`Filler ${i}`) } }));
}

function setup({ extraRows = () => [], shipped = () => {}, filler = MIN_PACKAGES } = {}) {
  const root = createTempDir();
  const store = path.join(root, "store");
  const cliDir = path.join(root, "cli");
  const cliAppDir = path.join(cliDir, "app");
  write(cliDir, "package.json", JSON.stringify({ name: "@acme/tool", version: "9.9.9" }));
  fs.mkdirSync(cliAppDir, { recursive: true });
  const rows = [...fillerRows(store, filler), ...extraRows(store)];
  shipped(cliAppDir);
  const run = (options = {}) =>
    writeThirdPartyNotices({ appDir: root, cliDir, cliAppDir, listProd: () => rows, ...options });
  return { root, store, cliDir, cliAppDir, run, output: () => fs.readFileSync(path.join(cliDir, OUTPUT_FILE_NAME), "utf8") };
}

describe("THIRD-PARTY-NOTICES generation", () => {
  it("lists every component and writes a header naming the package and upstream", () => {
    const ctx = setup({ extraRows: (s) => [addStorePackage(s, { name: "left-pad", version: "2.1.0", files: { LICENSE: MIT("Left Pad Authors") } })] });
    const result = ctx.run();
    const text = ctx.output();

    assert.equal(result.components, MIN_PACKAGES + 1);
    assert.match(text, /^Third-party notices for @acme\/tool 9\.9\.9/);
    assert.match(text, /based on 9router by\ndecolua and contributors/);
    assert.match(text, /^left-pad@2\.1\.0\n {2}License: MIT/m);
    assert.match(text, /Copyright \(c\) Left Pad Authors/);
  });

  it("stores identical license texts once and keeps different copyright holders apart", () => {
    const same = MIT("Shared Holder");
    const ctx = setup({
      extraRows: (s) => [
        addStorePackage(s, { name: "pkg-a", files: { LICENSE: same } }),
        addStorePackage(s, { name: "pkg-b", files: { "LICENSE.md": same } }),
        addStorePackage(s, { name: "pkg-c", files: { LICENSE: MIT("Someone Else") } }),
      ],
    });
    const result = ctx.run();
    const text = ctx.output();

    assert.equal(result.texts, MIN_PACKAGES + 2); // 50 fillers + shared + "Someone Else"
    assert.equal(text.split("Copyright (c) Shared Holder").length - 1, 1);
    assert.match(text, /used by 2 components: pkg-a@1\.0\.0, pkg-b@1\.0\.0/);
    assert.equal(text.split("Copyright (c) Someone Else").length - 1, 1);
  });

  it("keeps a NOTICE file next to the LICENSE of the same package", () => {
    const ctx = setup({
      extraRows: (s) => [addStorePackage(s, { name: "aws-like", license: "Apache-2.0", files: { LICENSE: APACHE, NOTICE: "Copyright Example Corp attribution notice\n" } })],
    });
    ctx.run();
    const text = ctx.output();

    assert.match(text, /\[LICENSE\]\nApache License/);
    assert.match(text, /\[NOTICE\]\nCopyright Example Corp attribution notice/);
  });

  it("never invents a text for a package without a license file, except the fixed Apache-2.0 text", () => {
    const ctx = setup({
      extraRows: (s) => [
        addStorePackage(s, { name: "apache-with-text", license: "Apache-2.0", files: { LICENSE: APACHE } }),
        addStorePackage(s, { name: "apache-no-text", license: "Apache-2.0" }),
        addStorePackage(s, { name: "mit-no-text", license: "MIT" }),
      ],
    });
    const result = ctx.run();
    const text = ctx.output();

    assert.equal(result.withoutText, 1);
    assert.match(text, /^mit-no-text@1\.0\.0\n {2}License: MIT\n {2}Text: {4}the package ships no license file/m);
    assert.match(text, /^apache-no-text@1\.0\.0\n {2}License: Apache-2\.0\n {2}Text: {4}license text #\d+ below \(the standard Apache-2\.0 text/m);
    assert.match(text, /used by 2 components: apache-with-text@1\.0\.0, apache-no-text@1\.0\.0/);
  });

  it("skips packages the build leaves out of the bundle", () => {
    const isExcluded = (segment) => ["@img", "sharp"].includes(segment);
    const ctx = setup({
      extraRows: (s) => [
        addStorePackage(s, { name: "@img/sharp-libvips-linux-x64", license: "LGPL-3.0-or-later", files: { LICENSE: "GNU LESSER GENERAL PUBLIC LICENSE" } }),
        addStorePackage(s, { name: "sharp", license: "Apache-2.0", files: { LICENSE: APACHE } }),
      ],
    });
    ctx.run({ isExcluded });
    const text = ctx.output();

    assert.doesNotMatch(text, /sharp/);
    assert.doesNotMatch(text, /LGPL|LESSER GENERAL/);
  });

  it("adds packages that are inside the bundle but missing from the production list", () => {
    const ctx = setup({
      shipped: (appDir) => {
        write(appDir, "node_modules/.pnpm/next@1.0.0/node_modules/next/dist/compiled/react-refresh/package.json",
          JSON.stringify({ name: "react-refresh", version: "0.12.0", license: "MIT", repository: "git+https://github.com/facebook/react.git" }));
        // an app/ package of our own and a duplicate of a listed package must not be added
        write(appDir, "node_modules/own/package.json", JSON.stringify({ name: "own-private", version: "1.0.0", private: true }));
        write(appDir, "node_modules/filler-0/package.json", JSON.stringify({ name: "filler-0", version: "1.0.0", license: "MIT" }));
      },
    });
    const result = ctx.run();
    const text = ctx.output();

    assert.equal(result.components, MIN_PACKAGES + 1);
    assert.equal(result.bundledOnly, 1);
    assert.match(text, /^react-refresh@0\.12\.0\n {2}License: MIT\n {2}Source: {2}https:\/\/github\.com\/facebook\/react\.git\n {2}Note: {4}vendored inside another package/m);
    assert.doesNotMatch(text, /own-private/);
    assert.equal(text.split("\nfiller-0@1.0.0\n").length - 1, 1);
  });

  it("refuses to write a partial file when the list is suspiciously short", () => {
    const ctx = setup({ filler: MIN_PACKAGES - 1 });

    assert.throws(() => ctx.run(), /refusing to write a partial notices file/);
    assert.equal(fs.existsSync(path.join(ctx.cliDir, OUTPUT_FILE_NAME)), false);
  });

  it("produces byte-identical output on repeated runs", () => {
    const ctx = setup({ extraRows: (s) => [addStorePackage(s, { name: "zeta", files: { LICENSE: MIT("Z") } }), addStorePackage(s, { name: "alpha", files: { LICENSE: MIT("A") } })] });
    ctx.run();
    const first = ctx.output();
    ctx.run();

    assert.equal(ctx.output(), first);
    assert.ok(first.indexOf("\nalpha@1.0.0\n") < first.indexOf("\nzeta@1.0.0\n"));
  });
});

describe("license file discovery", () => {
  it("reads LICENSE/COPYING/NOTICE style files and ignores code that merely starts with those words", () => {
    const dir = createTempDir();
    write(dir, "LICENSE-MIT", "mit text");
    write(dir, "COPYING", "copying text");
    write(dir, "license-checker.js", "module.exports = 1");
    write(dir, "notice.json", "{}");
    write(dir, "README.md", "readme");

    const text = readLicenseTexts(dir);

    assert.match(text, /\[COPYING\]\ncopying text/);
    assert.match(text, /\[LICENSE-MIT\]\nmit text/);
    assert.doesNotMatch(text, /module\.exports|readme/);
  });

  it("skips empty and oversized files and returns an empty string when nothing is found", () => {
    const dir = createTempDir();
    write(dir, "LICENSE", "");
    write(dir, "NOTICE", "x".repeat(300 * 1024));

    assert.equal(readLicenseTexts(dir), "");
    assert.equal(readLicenseTexts(path.join(dir, "missing")), "");
  });

  it("finds packages anywhere under cli/app/node_modules and skips private ones", () => {
    const appDir = createTempDir();
    write(appDir, "node_modules/a/package.json", JSON.stringify({ name: "a", version: "1.0.0", license: { type: "ISC" } }));
    write(appDir, "node_modules/.pnpm/b@2.0.0/node_modules/b/package.json", JSON.stringify({ name: "b", version: "2.0.0", licenses: [{ type: "MIT" }, { type: "Apache-2.0" }] }));
    write(appDir, "node_modules/c/package.json", JSON.stringify({ name: "c", version: "3.0.0", private: true }));
    write(appDir, "node_modules/d/package.json", JSON.stringify({ type: "module" }));

    const found = listShippedPackages(appDir).sort((x, y) => x.name.localeCompare(y.name));

    assert.deepEqual(found.map((p) => [p.name, p.version, p.license]), [
      ["a", "1.0.0", "ISC"],
      ["b", "2.0.0", "MIT OR Apache-2.0"],
    ]);
    assert.deepEqual(listShippedPackages(path.join(appDir, "nope")), []);
  });
});
