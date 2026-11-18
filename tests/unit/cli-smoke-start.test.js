import { createRequire } from "node:module";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// The release gate that starts a packed app. 1.1.1-1.1.3 shipped a server that died on boot
// because nothing ever started the package; these tests keep the gate itself honest, with fake
// packages that boot, crash or never answer.
const require = createRequire(import.meta.url);
const { main, parseArgs } = require("../../cli/scripts/smokeStart.js");

const PORT = "20993";
const tempDirs = [];

function fakePackage(serverSource) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rcrouter-fake-pkg-"));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, "hooks"), { recursive: true });
  fs.mkdirSync(path.join(root, "app"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "hooks", "sqliteRuntime.js"),
    "module.exports = { buildEnvWithRuntime: (env) => ({ ...env, NODE_PATH: '' }) };\n",
  );
  fs.writeFileSync(path.join(root, "app", "custom-server.js"), serverSource);
  return root;
}

const SERVING_SERVER = `
  require("http").createServer((req, res) => {
    if (req.url === "/login") return res.end("<html>login</html>");
    if (req.url === "/favicon.svg") return res.end("<svg></svg>");
    res.statusCode = 404; res.end();
  }).listen(Number(process.env.PORT), process.env.HOSTNAME);
`;

afterEach(() => {
  vi.restoreAllMocks();
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true });
});

describe("smokeStart arguments", () => {
  it("needs a package to start", () => {
    expect(() => parseArgs([])).toThrow(/Usage/);
  });

  it("reads port and timeout", () => {
    expect(parseArgs(["pkg.tgz", "--port", "20555", "--timeout", "30"])).toEqual({
      input: "pkg.tgz",
      port: 20555,
      timeoutS: 30,
    });
  });

  it.each([["0"], ["70000"], ["abc"]])("rejects the port %s", (port) => {
    expect(() => parseArgs(["pkg", "--port", port])).toThrow(/Invalid --port/);
  });

  it("rejects a second package argument", () => {
    expect(() => parseArgs(["a", "b"])).toThrow(/Unexpected argument/);
  });
});

describe("smokeStart on a package", () => {
  it("passes when the app starts and serves its pages", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(await main([fakePackage(SERVING_SERVER), "--port", PORT, "--timeout", "20"])).toBe(0);
  });

  it("fails and shows the crash when the app dies on boot (the 1.1.1-1.1.3 bug)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const failed = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = fakePackage("require('@swc/helpers/_/not-installed');");

    expect(await main([root, "--port", PORT, "--timeout", "20"])).toBe(1);
    expect(failed.mock.calls.flat().join("\n")).toMatch(/exited with code 1[\s\S]*@swc\/helpers/);
  });

  it("fails when the app runs but never answers", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const failed = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = fakePackage("setInterval(() => {}, 1000);");

    expect(await main([root, "--port", PORT, "--timeout", "2"])).toBe(1);
    expect(failed.mock.calls.flat().join("\n")).toMatch(/did not answer within 2s/);
  });

  it("fails when a page is missing from the build", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const failed = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = fakePackage(SERVING_SERVER.replace('"/favicon.svg"', '"/other"'));

    expect(await main([root, "--port", PORT, "--timeout", "20"])).toBe(1);
    expect(failed.mock.calls.flat().join("\n")).toMatch(/GET \/favicon\.svg .* answered 404/);
  });

  it("fails instead of trusting whatever already answers on the port", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const failed = vi.spyOn(console, "error").mockImplementation(() => {});
    const squatter = net.createServer();
    await new Promise((resolve) => squatter.listen(Number(PORT), "127.0.0.1", resolve));
    try {
      expect(await main([fakePackage(SERVING_SERVER), "--port", PORT, "--timeout", "5"])).toBe(1);
      expect(failed.mock.calls.flat().join("\n")).toMatch(/Port 20993 is not free/);
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }
  });

  it("fails when the package has no server entry", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const failed = vi.spyOn(console, "error").mockImplementation(() => {});
    const root = fakePackage(SERVING_SERVER);
    fs.rmSync(path.join(root, "app", "custom-server.js"));

    expect(await main([root, "--port", PORT])).toBe(1);
    expect(failed.mock.calls.flat().join("\n")).toMatch(/No custom-server\.js or server\.js/);
  });
});
