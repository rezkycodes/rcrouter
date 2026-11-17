import { handleChat } from "@/sse/handlers/chat.js";
import { readBoundedText } from "@/sse/utils/boundedBody.js";
import { initTranslators } from "open-sse/translator/index.js";
import { transformToOllama } from "open-sse/utils/ollamaTransform.js";

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

export async function POST(request) {
  await ensureInitialized();
  
  // One bounded read (413 before parsing) instead of request.clone(), which would tee
  // and buffer the whole body twice. handleChat gets the same bytes as a fresh Request.
  const { text, error } = await readBoundedText(request);
  if (error) return error;

  let modelName = "llama3.2";
  try {
    modelName = JSON.parse(text).model || "llama3.2";
  } catch {}

  const response = await handleChat(new Request(request.url, { method: "POST", headers: request.headers, body: text }));
  return transformToOllama(response, modelName);
}

