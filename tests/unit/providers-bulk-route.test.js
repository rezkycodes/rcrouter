// POST /api/providers/bulk: validate the whole batch first, then save it in one
// transaction. Real route + real temp database (same approach as
// compatible-provider-connections.test.js), so node hydration, provider rules and
// the repo transaction are exercised together.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalDataDir = process.env.DATA_DIR;

async function setup() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "rc-providers-bulk-"));
  process.env.DATA_DIR = tempDir;
  // The driver keeps its adapter on `global` (to survive Next HMR), so resetting
  // modules alone would reuse the first test's database for the whole file.
  global._dbAdapter = { instance: null, initPromise: null, logged: false };
  vi.resetModules();
  vi.doMock("next/server", () => ({
    NextResponse: {
      json: (body, init = {}) => new Response(JSON.stringify(body), {
        status: init.status || 200,
        headers: { "Content-Type": "application/json" },
      }),
    },
  }));
  const { POST } = await import("@/app/api/providers/bulk/route.js");
  const models = await import("@/models/index.js");
  const constants = await import("@/shared/constants/providers.js");
  return { POST, models, constants, cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }) };
}

const call = (POST, body) => POST(new Request("https://rc.local/api/providers/bulk", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body),
}));

const entry = (name, extra = {}) => ({ provider: "openrouter", name, apiKey: `sk-${name}`, ...extra });

describe("POST /api/providers/bulk", () => {
  let cleanup = () => {};

  afterEach(() => {
    vi.doUnmock("next/server");
    vi.resetModules();
    cleanup();
    cleanup = () => {};
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it("saves the whole batch and answers 201 with one result per item", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;

    const res = await call(ctx.POST, { items: [entry("a"), entry("b", { testStatus: "active" })] });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.results.map((r) => [r.name, r.ok])).toEqual([["a", true], ["b", true]]);
    const stored = await ctx.models.getProviderConnections({ provider: "openrouter" });
    expect(stored.map((c) => [c.name, c.testStatus, c.authType]).sort())
      .toEqual([["a", "unknown", "apikey"], ["b", "active", "apikey"]]);
    expect(stored[0].providerSpecificData).toMatchObject({
      connectionProxyEnabled: false, connectionProxyUrl: "", connectionNoProxy: "",
    });
  });

  it("does not leak secrets back in the response", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;

    const res = await call(ctx.POST, { items: [entry("secret", { apiKey: "sk-super-secret" })] });

    expect(JSON.stringify(await res.json())).not.toContain("sk-super-secret");
  });

  it.each([
    ["no items field", {}],
    ["an empty list", { items: [] }],
    ["a non-array", { items: "nope" }],
  ])("answers 400 for %s", async (_label, payload) => {
    const ctx = await setup();
    cleanup = ctx.cleanup;

    expect((await call(ctx.POST, payload)).status).toBe(400);
  });

  it("answers 400 above 500 items and saves nothing", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;

    const res = await call(ctx.POST, { items: Array.from({ length: 501 }, (_, i) => entry(`k${i}`)) });

    expect(res.status).toBe(400);
    expect(await ctx.models.getProviderConnections({ provider: "openrouter" })).toHaveLength(0);
  });

  it("answers 400 for malformed JSON", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;

    expect((await call(ctx.POST, "{not json")).status).toBe(400);
  });

  it.each([
    ["an unknown provider", entry("x", { provider: "definitely-not-a-provider" })],
    ["a missing key", entry("x", { apiKey: "" })],
    ["a missing name", entry("", {})],
  ])("rejects the whole batch with 400 for %s and saves nothing", async (_label, bad) => {
    const ctx = await setup();
    cleanup = ctx.cleanup;

    const res = await call(ctx.POST, { items: [entry("good"), bad] });

    expect(res.status).toBe(400);
    expect(await ctx.models.getProviderConnections({ provider: "openrouter" })).toHaveLength(0);
  });

  it("answers 409 for a repeated provider/name in one batch and saves nothing", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;

    const res = await call(ctx.POST, { items: [entry("twin"), entry("twin", { apiKey: "sk-other" })] });

    expect(res.status).toBe(409);
    expect(await ctx.models.getProviderConnections({ provider: "openrouter" })).toHaveLength(0);
  });

  it("reports a collision with a stored connection per item, keeps the stored key, saves the rest", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;
    await ctx.models.createProviderConnection({ provider: "openrouter", authType: "apikey", name: "taken", apiKey: "sk-original" });

    const res = await call(ctx.POST, { items: [entry("taken", { apiKey: "sk-new" }), entry("free")] });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.results[0]).toMatchObject({ name: "taken", ok: false, code: "PROVIDER_NAME_CONFLICT" });
    expect(body.results[1]).toMatchObject({ name: "free", ok: true });
    const stored = await ctx.models.getProviderConnections({ provider: "openrouter" });
    expect(stored.find((c) => c.name === "taken").apiKey).toBe("sk-original");
  });

  it("hydrates an OpenAI-compatible node into every connection", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;
    const node = await ctx.models.createProviderNode({
      id: "openai-compatible-bulk", type: "openai-compatible", name: "Bulk Node",
      prefix: "bn", apiType: "chat", baseUrl: "https://bulk.test/v1",
    });

    const res = await call(ctx.POST, { items: [entry("k1", { provider: node.id }), entry("k2", { provider: node.id })] });

    expect(res.status).toBe(201);
    const stored = await ctx.models.getProviderConnections({ provider: node.id });
    expect(stored).toHaveLength(2);
    for (const c of stored) {
      expect(c.providerSpecificData).toMatchObject({
        prefix: "bn", apiType: "chat", baseUrl: "https://bulk.test/v1", nodeName: "Bulk Node",
      });
    }
  });

  it("answers 404 when a compatible provider's node does not exist", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;

    const res = await call(ctx.POST, { items: [entry("k", { provider: "openai-compatible-ghost" })] });

    expect(res.status).toBe(404);
  });

  it("stores cookie providers with the cookie auth type", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;
    const cookieProvider = Object.keys(ctx.constants.WEB_COOKIE_PROVIDERS)[0];

    const res = await call(ctx.POST, { items: [entry("cookie-1", { provider: cookieProvider })] });

    expect(res.status).toBe(201);
    const [stored] = await ctx.models.getProviderConnections({ provider: cookieProvider });
    expect(stored.authType).toBe("cookie");
  });

  it("applies provider-specific normalisation like the single-add route", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;
    const { normalizeProviderSpecificData } = await import("@/lib/providerNormalization.js");
    const raw = { accountId: " acct-123 ", region: "eu" };
    const expected = normalizeProviderSpecificData("cloudflare-ai", { providerSpecificData: raw }, raw);

    const res = await call(ctx.POST, { items: [entry("cf", { provider: "cloudflare-ai", providerSpecificData: raw })] });

    expect(res.status).toBe(201);
    const [stored] = await ctx.models.getProviderConnections({ provider: "cloudflare-ai" });
    expect(stored.providerSpecificData).toMatchObject(expected || {});
  });

  it("answers 400 for a proxy pool that does not exist", async () => {
    const ctx = await setup();
    cleanup = ctx.cleanup;

    const res = await call(ctx.POST, { items: [entry("p", { proxyPoolId: "no-such-pool" })] });

    expect(res.status).toBe(400);
    expect(await ctx.models.getProviderConnections({ provider: "openrouter" })).toHaveLength(0);
  });
});
