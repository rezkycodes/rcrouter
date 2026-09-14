import { describe, expect, it, vi } from "vitest";

vi.mock("../../cloud/src/handlers/embeddings.js", () => ({
  handleEmbeddings: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
}));

import worker from "../../cloud/src/index.js";
import { handleEmbeddings } from "../../cloud/src/handlers/embeddings.js";

describe("Cloudflare Worker entry point", () => {
  it("serves a CORS-enabled health response", async () => {
    const response = await worker.fetch(new Request("https://worker.example/health"), {}, {});

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("routes the new embeddings endpoint to the shared handler", async () => {
    const request = new Request("https://worker.example/v1/embeddings", { method: "POST" });
    const response = await worker.fetch(request, {}, {});

    expect(response.status).toBe(200);
    expect(handleEmbeddings).toHaveBeenCalledWith(request, {}, {});
    expect(response.headers.get("Access-Control-Allow-Methods")).toMatch(/POST/);
  });

  it("returns a JSON 404 for unsupported routes", async () => {
    const response = await worker.fetch(new Request("https://worker.example/nope"), {}, {});

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not Found" });
  });
});
