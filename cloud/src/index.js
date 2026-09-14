import { handleEmbeddings } from "./handlers/embeddings.js";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

function withCors(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Minimal Cloudflare Worker entry point for the RcRouter cloud deployment.
 * The local dashboard remains the full control plane; this worker exposes the
 * stateless embeddings edge and a health probe using the shared open-sse core.
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    if (url.pathname === "/health" && request.method === "GET") {
      return new Response(JSON.stringify({ status: "ok" }), {
        status: 200,
        headers: { "Content-Type": "application/json", ...CORS_HEADERS },
      });
    }

    if (url.pathname === "/v1/embeddings" && request.method === "POST") {
      return withCors(await handleEmbeddings(request, env, ctx));
    }

    const oldFormat = url.pathname.match(/^\/([^/]+)\/v1\/embeddings$/);
    if (oldFormat && request.method === "POST") {
      return withCors(await handleEmbeddings(request, env, ctx, oldFormat[1]));
    }

    return new Response(JSON.stringify({ error: "Not Found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...CORS_HEADERS },
    });
  },
};
