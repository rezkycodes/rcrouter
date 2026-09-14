import { isValidApiKey, extractApiKey, isProviderAllowed, isComboAllowed, isKindAllowed } from "@/sse/services/auth.js";
import { getSettings } from "@/lib/localDb";
import { stripComboPrefix } from "open-sse/services/combo.js";
import { buildModelsList, getAllowedModelIds, isModelAllowed } from "@/sse/services/allowedModels.js";
import { capabilitiesFromServiceKind } from "open-sse/providers/capabilities.js";
import { AUTO_MODELS_LIST } from "open-sse/services/autoCombo.js";

const parseOpenAIStyleModels = (data) => {
  if (Array.isArray(data)) return data;
  return data?.data || data?.models || data?.results || [];
};
const _parseModelsGuard = (data) => parseOpenAIStyleModels(data);

const INTERNAL_MODELS_FETCH_HEADER = "x-9r-internal-models-fetch";
const LLM_KIND = "llm";

export { buildModelsList, capabilitiesFromServiceKind, parseOpenAIStyleModels, _parseModelsGuard };

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * GET /v1/models - OpenAI compatible models list (LLM/chat models only by default).
 * For other capabilities use /v1/models/{kind} (image, tts, stt, embedding, image-to-text, web).
 */
export async function GET(request) {
  try {
    const skipDynamicFetch = request?.headers?.get(INTERNAL_MODELS_FETCH_HEADER) === "1";

    const settings = await getSettings();
    let apiKeyInfo = null;
    if (settings.requireApiKey) {
      const apiKey = extractApiKey(request);
      if (!apiKey) {
        return Response.json(
          { error: { message: "Missing API key", type: "authentication_error" } },
          { status: 401, headers: { "Access-Control-Allow-Origin": "*" } }
        );
      }
      apiKeyInfo = await isValidApiKey(apiKey);
      if (!apiKeyInfo) {
        return Response.json(
          { error: { message: "Invalid API key", type: "authentication_error" } },
          { status: 401, headers: { "Access-Control-Allow-Origin": "*" } }
        );
      }
    } else {
      const apiKey = extractApiKey(request);
      if (apiKey) {
        apiKeyInfo = await isValidApiKey(apiKey);
        if (!apiKeyInfo) {
          return Response.json(
            { error: { message: "Invalid API key", type: "authentication_error" } },
            { status: 401, headers: { "Access-Control-Allow-Origin": "*" } }
          );
        }
      }
    }

    let data = await buildModelsList([LLM_KIND], { skipDynamicFetch });
    data = [...AUTO_MODELS_LIST, ...data];
    if (apiKeyInfo) {
      const allowedOwners = new Map();
      for (const model of data) {
        const isCombo = model.owned_by === "combo";
        const key = isCombo
          ? `combo:${stripComboPrefix(model.id)}`
          : `provider:${model.id.includes("/") ? model.id.split("/")[0] : model.owned_by}`;
        if (!allowedOwners.has(key)) {
          const allowed = isCombo
            ? isComboAllowed(apiKeyInfo, key.slice(6))
            : await isProviderAllowed(apiKeyInfo, key.slice(9));
          allowedOwners.set(key, allowed);
        }
      }
      const allowedModelIds = await getAllowedModelIds();
      data = data.filter((model) => {
        if (!isKindAllowed(apiKeyInfo, model.kind || LLM_KIND)) return false;
        const isCombo = model.owned_by === "combo";
        const key = isCombo
          ? `combo:${stripComboPrefix(model.id)}`
          : `provider:${model.id.includes("/") ? model.id.split("/")[0] : model.owned_by}`;
        if (!allowedOwners.get(key)) return false;
        if (!allowedModelIds.has(model.id)) return false;
        return true;
      });
    }

    return Response.json({ object: "list", data }, {
      headers: { "Access-Control-Allow-Origin": "*" },
    });

  } catch (error) {
    console.log("Error fetching models:", error);
    return Response.json(
      { error: { message: error.message, type: "server_error" } },
      { status: 500 }
    );
  }
}
