"use strict";

// Generates THIRD-PARTY-NOTICES.txt for the npm package.
//
// Why this exists: Next.js standalone tracing copies only the JS files it follows, so the
// third-party packages inside cli/app/node_modules ship WITHOUT their LICENSE/NOTICE files,
// and libraries compiled into the .next chunks leave no trace at all. MIT, BSD and Apache-2.0
// require the notice to travel with the software, so the list is rebuilt at every release:
//
//   1. every production dependency of the app (`pnpm licenses list --prod`, transitive
//      included), with the license text read from the pnpm store where the package is complete;
//   2. every package that is actually inside the bundle but missing from (1), e.g. the
//      libraries Next.js vendors (@edge-runtime/*, react-refresh, ...).
//
// Packages the build deliberately leaves out (EXCLUDE_PATTERNS in build-cli.js, e.g. sharp and
// its LGPL libvips binaries) are skipped in (1): the package does not contain them.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const OUTPUT_FILE_NAME = "THIRD-PARTY-NOTICES.txt";
const MIN_PACKAGES = 50; // fewer means pnpm returned nothing useful: fail instead of shipping a stub
const MAX_TEXT_BYTES = 256 * 1024;
const LICENSE_FILE_RE = /^(licen[cs]e|copying|notice|unlicen[cs]e)([-_.][\w.-]*)?$/i;
const CODE_EXT_RE = /\.(c?js|mjs|ts|tsx|jsx|json|map|node|wasm)$/i;

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function declaredLicense(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license && typeof pkg.license === "object" && pkg.license.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) {
    return pkg.licenses.map((l) => (typeof l === "string" ? l : l && l.type)).filter(Boolean).join(" OR ");
  }
  return "";
}

function authorOf(pkg) {
  if (typeof pkg.author === "string") return pkg.author;
  if (pkg.author && typeof pkg.author === "object" && pkg.author.name) return pkg.author.name;
  return "";
}

function sourceOf(pkg) {
  if (pkg.homepage) return pkg.homepage;
  const repo = pkg.repository;
  const url = typeof repo === "string" ? repo : repo && repo.url;
  return url ? String(url).replace(/^git\+/, "") : "";
}

// `pnpm licenses list --prod --json` -> [{ name, version, license, author, source, dir }]
function listProdLicenses(appDir) {
  let raw;
  try {
    raw = execFileSync("pnpm", ["licenses", "list", "--prod", "--json"], {
      cwd: appDir,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
  } catch (error) {
    throw new Error(`"pnpm licenses list --prod --json" failed in ${appDir}: ${error.stderr || error.message}`);
  }
  return parseLicenseReport(raw, appDir);
}

function parseLicenseReport(raw, appDir) {
  const byLicense = JSON.parse(raw);
  // pnpm reports where each package lives in its default (isolated) layout,
  // node_modules/.pnpm/<id>/node_modules/<name>. With the hoisted linker (what the published
  // package is built with) those folders do not exist: the package sits at node_modules/<name>,
  // or nested under its parent. Then the installed copies are searched by name and version.
  let installed = null;
  const dirOf = (name, version, reported) => {
    if (reported && fs.existsSync(reported)) return reported;
    if (!installed) installed = new Map(listShippedPackages(appDir).map((p) => [`${p.name}@${p.version}`, p.dir]));
    return installed.get(`${name}@${version}`) || reported;
  };
  const out = [];
  for (const [license, packages] of Object.entries(byLicense)) {
    for (const pkg of packages) {
      pkg.versions.forEach((version, i) => {
        out.push({
          name: pkg.name,
          version,
          license,
          author: pkg.author || "",
          source: pkg.homepage || "",
          dir: dirOf(pkg.name, version, pkg.paths[i]),
        });
      });
    }
  }
  return out;
}

// Packages physically present in the bundle (third-party code lives under node_modules).
function listShippedPackages(cliAppDir) {
  const start = path.join(cliAppDir, "node_modules");
  const out = [];
  if (!fs.existsSync(start)) return out;
  const stack = [start];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === "package.json") {
        const pkg = readPackageJson(full);
        if (!pkg || !pkg.name || !pkg.version || pkg.private) continue;
        out.push({
          name: pkg.name,
          version: pkg.version,
          license: declaredLicense(pkg),
          author: authorOf(pkg),
          source: sourceOf(pkg),
          dir,
        });
      }
    }
  }
  return out;
}

function readPackageJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function readLicenseTexts(dir) {
  let names;
  try { names = fs.readdirSync(dir).sort(compareText); } catch { return ""; }
  const parts = [];
  for (const name of names) {
    if (!LICENSE_FILE_RE.test(name) || CODE_EXT_RE.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size === 0 || stat.size > MAX_TEXT_BYTES) continue;
      parts.push({ name, text: fs.readFileSync(file, "utf8").replace(/\r\n?/g, "\n").trim() });
    } catch { /* unreadable file: treated as absent */ }
  }
  if (parts.length === 0) return "";
  if (parts.length === 1) return parts[0].text;
  return parts.map((p) => `[${p.name}]\n${p.text}`).join("\n\n");
}

function mergeEntries(prod, shipped, isExcluded) {
  const byId = new Map();
  for (const item of prod) {
    if (item.name.split("/").some(isExcluded)) continue;
    byId.set(`${item.name}@${item.version}`, { ...item, origin: "dependency" });
  }
  for (const item of shipped) {
    const id = `${item.name}@${item.version}`;
    if (!byId.has(id)) byId.set(id, { ...item, origin: "bundled" });
  }
  return [...byId.values()]
    .map((item) => ({ ...item, text: readLicenseTexts(item.dir) }))
    .sort((a, b) => compareText(a.name, b.name) || compareText(a.version, b.version));
}

function groupTexts(entries) {
  const groups = new Map(); // sha256 -> { number, text, users: entry[] }
  for (const entry of entries) {
    if (!entry.text) continue;
    const key = crypto.createHash("sha256").update(entry.text).digest("hex");
    if (!groups.has(key)) groups.set(key, { number: groups.size + 1, text: entry.text, users: [] });
    const group = groups.get(key);
    group.users.push(entry);
    entry.textNumber = group.number;
  }
  const list = [...groups.values()];
  applyStandardApacheText(entries, list);
  return list;
}

// Apache-2.0 is one fixed text (its appendix placeholder names no holder), so a package that
// declares it but ships no copy can point at the copy the other Apache-2.0 packages ship.
// MIT/BSD texts carry a per-package copyright line and are never guessed.
function applyStandardApacheText(entries, groups) {
  const apacheCount = (g) => g.users.filter((u) => u.license === "Apache-2.0").length;
  const best = groups.reduce((a, g) => (apacheCount(g) > (a ? apacheCount(a) : 0) ? g : a), null);
  if (!best) return;
  for (const entry of entries) {
    if (entry.textNumber || entry.license !== "Apache-2.0") continue;
    entry.textNumber = best.number;
    entry.textIsStandard = true;
    best.users.push(entry);
  }
}

function render(entries, groups, meta) {
  const counts = {};
  for (const e of entries) counts[e.license || "(not declared)"] = (counts[e.license || "(not declared)"] || 0) + 1;
  const summary = Object.entries(counts)
    .sort((a, b) => b[1] - a[1] || compareText(a[0], b[0]))
    .map(([license, n]) => `  ${license}: ${n}`)
    .join("\n");

  const lines = [
    `Third-party notices for ${meta.name} ${meta.version}`,
    "=".repeat(60),
    "",
    `${meta.name} is licensed under the MIT License (see LICENSE). It is based on 9router by`,
    "decolua and contributors (MIT); their copyright notice is kept in LICENSE.",
    "",
    "This file lists the third-party software that is shipped in this package or compiled into",
    "it, with the license each component declares and, where the component provides one, the",
    "full license text. It is generated at build time; do not edit it by hand.",
    "",
    'Where a component is offered under a choice of licenses (an SPDX "OR" expression), the',
    "most permissive option applies.",
    "",
    `${entries.length} components`,
    summary,
    "",
    "COMPONENTS",
    "-".repeat(60),
  ];
  for (const e of entries) {
    lines.push("", `${e.name}@${e.version}`);
    lines.push(`  License: ${e.license || "not declared in package.json"}`);
    if (e.author) lines.push(`  Author:  ${e.author}`);
    if (e.source) lines.push(`  Source:  ${e.source}`);
    if (e.origin === "bundled") lines.push("  Note:    vendored inside another package of this bundle");
    if (e.textIsStandard) lines.push(`  Text:    license text #${e.textNumber} below (the standard Apache-2.0 text; the package ships no copy)`);
    else if (e.textNumber) lines.push(`  Text:    license text #${e.textNumber} below`);
    else lines.push("  Text:    the package ships no license file; see its declared license above");
  }
  lines.push("", "", "LICENSE TEXTS", "-".repeat(60));
  for (const g of groups) {
    const ids = g.users.map((u) => `${u.name}@${u.version}`);
    lines.push("", `#${g.number}  used by ${ids.length} component${ids.length === 1 ? "" : "s"}: ${ids.join(", ")}`, "", g.text, "", "-".repeat(60));
  }
  return lines.join("\n") + "\n";
}

function writeThirdPartyNotices({
  appDir,
  cliDir,
  cliAppDir,
  isExcluded = () => false,
  listProd = listProdLicenses,
}) {
  const cliPkg = readPackageJson(path.join(cliDir, "package.json"));
  if (!cliPkg) throw new Error(`Cannot read ${path.join(cliDir, "package.json")}`);

  const entries = mergeEntries(listProd(appDir), listShippedPackages(cliAppDir), isExcluded);
  if (entries.length < MIN_PACKAGES) {
    throw new Error(`Only ${entries.length} third-party components found (expected at least ${MIN_PACKAGES}); refusing to write a partial notices file`);
  }
  const groups = groupTexts(entries);
  const file = path.join(cliDir, OUTPUT_FILE_NAME);
  fs.writeFileSync(file, render(entries, groups, { name: cliPkg.name, version: cliPkg.version }));
  return {
    file,
    components: entries.length,
    texts: groups.length,
    withoutText: entries.filter((e) => !e.textNumber).length,
    bundledOnly: entries.filter((e) => e.origin === "bundled").length,
  };
}

module.exports = {
  OUTPUT_FILE_NAME,
  MIN_PACKAGES,
  listProdLicenses,
  parseLicenseReport,
  listShippedPackages,
  readLicenseTexts,
  writeThirdPartyNotices,
};
