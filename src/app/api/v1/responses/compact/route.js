import { handleChat } from "@/sse/handlers/chat.js";
import { cloneRequestWithJson, readBoundedJson } from "@/sse/utils/boundedBody.js";
import { initTranslators } from "open-sse/translator/index.js";

let initialized = false;

async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
  }
}

export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*"
    }
  });
}

/**
 * POST /v1/responses/compact - Compact conversation context
 * Reuses the same handleChat pipeline, signals compact via body._compact
 */
export async function POST(request) {
  await ensureInitialized();
  // Single bounded read of the socket (413 before JSON.parse); handleChat then
  // re-reads only the small in-memory re-serialization.
  const { body, error } = await readBoundedJson(request);
  if (error) return error;
  body._compact = true;
  return await handleChat(cloneRequestWithJson(request, body));
}
