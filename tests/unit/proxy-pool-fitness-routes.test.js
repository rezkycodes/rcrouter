// /api/proxy-pools/fitness (GET), /fitness/clear-all (POST) and
// /[id]/fitness/clear (POST). Real routes + real service + real temp database;
// only next/server (plain Response) and the dashboard auth check are stubbed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;
const FITNESS_KEYS = ["__9routerPoolFitness__", "__9routerPoolFitnessState__"];
const FUTURE = () => Date.now() + 60_000;

let tempDir;
let routes;
let svc;
let db;
let authorized;

async function setup() {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-fitness-routes-"));
  process.env.DATA_DIR = tempDir;
  global._dbAdapter = { instance: null, initPromise: null, logged: false };
  for (const key of FITNESS_KEYS) delete globalThis[key];
  vi.resetModules();
  authorized = true;
  vi.doMock("next/server", () => ({
    NextResponse: {
      json: (body, init = {}) => new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      }),
    },
  }));
  vi.doMock("@/lib/auth/routeAuth.js", () => ({ requireDashboardAuth: vi.fn(async () => authorized) }));
  routes = {
    snapshot: (await import("@/app/api/proxy-pools/fitness/route.js")).GET,
    clearAll: (await import("@/app/api/proxy-pools/fitness/clear-all/route.js")).POST,
    clearOne: (await import("@/app/api/proxy-pools/[id]/fitness/clear/route.js")).POST,
  };
  svc = await import("open-sse/services/proxyPoolFitness.js");
  db = await import("@/lib/db/index.js");
  await db.initDb();
}

const get = (url = "https://rc.local/api/proxy-pools/fitness") => new Request(url, { method: "GET" });
const post = (body, url = "https://rc.local/api/proxy-pools/fitness/clear-all") => new Request(url, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const idParams = (id) => ({ params: Promise.resolve({ id }) });

describe("proxy pool fitness routes", () => {
  beforeEach(setup);

  afterEach(async () => {
    vi.doUnmock("next/server");
    vi.doUnmock("@/lib/auth/routeAuth.js");
    try {
      const { getAdapter } = await import("@/lib/db/driver.js");
      (await getAdapter()).close();
    } catch {
      // adapter was never opened or is already closed
    }
    global._dbAdapter = { instance: null, initPromise: null, logged: false };
    for (const key of FITNESS_KEYS) delete globalThis[key];
    vi.resetModules();
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  describe("GET /api/proxy-pools/fitness", () => {
    it("answers an empty map when nothing is blocked", async () => {
      const res = await routes.snapshot(get());

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ pools: {} });
    });

    it("lists active blocks by pool and scope, without expired ones", async () => {
      const until = FUTURE();
      await svc.markPoolUnfit("p1", "freebuff::m1", until, "limited_ip");
      await svc.markPoolUnfit("p1", "opencode::*", until, "ip-limit");
      await db.upsertProxyPoolFitness("p2", "freebuff::m1", Date.now() - 1_000, "old");

      const res = await routes.snapshot(get());

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        pools: { p1: { "freebuff::m1": { until, reason: "limited_ip" }, "opencode::*": { until, reason: "ip-limit" } } },
      });
    });

    it("returns 401 without touching the registry when unauthenticated", async () => {
      await svc.markPoolUnfit("p1", "freebuff::m1", FUTURE());
      authorized = false;

      const res = await routes.snapshot(get());

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Unauthorized" });
    });
  });

  describe("POST /api/proxy-pools/fitness/clear-all", () => {
    beforeEach(async () => {
      await svc.markPoolUnfit("p1", "freebuff::m1", FUTURE());
      await svc.markPoolUnfit("p2", "opencode::m2", FUTURE());
    });

    it("clears every block when no provider is given", async () => {
      const res = await routes.clearAll(post({}));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, provider: null });
      expect(await db.listProxyPoolFitness()).toEqual([]);
      expect(svc.isPoolFit("p1", "freebuff::m1")).toBe(true);
    });

    it("clears only the named provider, trimmed", async () => {
      const res = await routes.clearAll(post({ provider: "  freebuff " }));

      expect(await res.json()).toEqual({ ok: true, provider: "freebuff" });
      expect((await db.listProxyPoolFitness()).map((r) => r.scope)).toEqual(["opencode::m2"]);
    });

    it("treats a blank or non-string provider as clear-everything", async () => {
      const res = await routes.clearAll(post({ provider: 42 }));

      expect(await res.json()).toEqual({ ok: true, provider: null });
      expect(await db.listProxyPoolFitness()).toEqual([]);
    });

    it("accepts an empty or malformed body", async () => {
      const res = await routes.clearAll(new Request("https://rc.local/api/proxy-pools/fitness/clear-all", { method: "POST" }));
      expect(res.status).toBe(200);
      expect(await db.listProxyPoolFitness()).toEqual([]);

      await svc.markPoolUnfit("p1", "freebuff::m1", FUTURE());
      const bad = await routes.clearAll(post("{not json"));
      expect(bad.status).toBe(200);
      expect(await db.listProxyPoolFitness()).toEqual([]);
    });

    it("returns 401 and clears nothing when unauthenticated", async () => {
      authorized = false;

      const res = await routes.clearAll(post({}));

      expect(res.status).toBe(401);
      expect(await db.listProxyPoolFitness()).toHaveLength(2);
      expect(svc.isPoolFit("p1", "freebuff::m1")).toBe(false);
    });

    it("returns 500 when the clear could not be persisted", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { getAdapter } = await import("@/lib/db/driver.js");
      (await getAdapter()).close();

      const res = await routes.clearAll(post({}));

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: "Failed to clear proxy fitness" });
      vi.restoreAllMocks();
    });
  });

  describe("POST /api/proxy-pools/[id]/fitness/clear", () => {
    const url = "https://rc.local/api/proxy-pools/p1/fitness/clear";

    beforeEach(async () => {
      await svc.markPoolUnfit("p1", "freebuff::m1", FUTURE());
      await svc.markPoolUnfit("p1", "freebuff::m2", FUTURE());
    });

    it("clears one scope of one pool", async () => {
      const res = await routes.clearOne(post({ scope: "freebuff::m1" }, url), idParams("p1"));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, poolId: "p1", scope: "freebuff::m1" });
      expect((await db.listProxyPoolFitness("p1")).map((r) => r.scope)).toEqual(["freebuff::m2"]);
      expect(svc.isPoolFit("p1", "freebuff::m1")).toBe(true);
      expect(svc.isPoolFit("p1", "freebuff::m2")).toBe(false);
    });

    it("trims the scope", async () => {
      const res = await routes.clearOne(post({ scope: " freebuff::m1 " }, url), idParams("p1"));

      expect((await res.json()).scope).toBe("freebuff::m1");
    });

    it.each([
      ["a missing scope", {}],
      ["a blank scope", { scope: "   " }],
      ["a non-string scope", { scope: 7 }],
    ])("returns 400 for %s", async (_name, body) => {
      const res = await routes.clearOne(post(body, url), idParams("p1"));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "pool id and scope are required" });
      expect(await db.listProxyPoolFitness("p1")).toHaveLength(2);
    });

    it("returns 400 for a missing pool id and for an unparseable body", async () => {
      expect((await routes.clearOne(post({ scope: "a::b" }, url), idParams(""))).status).toBe(400);
      expect((await routes.clearOne(post("{nope", url), idParams("p1"))).status).toBe(400);
    });

    it("returns 401 and clears nothing when unauthenticated", async () => {
      authorized = false;

      const res = await routes.clearOne(post({ scope: "freebuff::m1" }, url), idParams("p1"));

      expect(res.status).toBe(401);
      expect(await db.listProxyPoolFitness("p1")).toHaveLength(2);
    });

    it("returns 500 when the clear could not be persisted", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const { getAdapter } = await import("@/lib/db/driver.js");
      (await getAdapter()).close();

      const res = await routes.clearOne(post({ scope: "freebuff::m1" }, url), idParams("p1"));

      expect(res.status).toBe(500);
      vi.restoreAllMocks();
    });
  });
});
