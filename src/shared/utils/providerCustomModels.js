function modelType(model) {
  return model?.kind || model?.type || "llm";
}

// Catalog ids that are clearly not chat models (embeddings, speech, image gen, moderation, rerank).
const NON_LLM_ID_PATTERN = /embed|whisper|dall-e|dalle|imagen|moderation|rerank|tts/i;

// Service kinds (providers.js service table) that are not chat models. Raw provider catalogs tag plain
// chat models with their own type ("model" for Anthropic, "chat" for Together), so only these are skipped.
const NON_LLM_KINDS = new Set(["embedding", "image", "imageToText", "tts", "stt", "webSearch", "webFetch", "video", "music"]);

function matchedPrefix(id, prefixes) {
  return prefixes.find((p) => id.startsWith(`${p}/`));
}

function stripProviderPrefix(id, prefixes) {
  const prefix = matchedPrefix(id, prefixes);
  return prefix ? id.slice(prefix.length + 1) : id;
}

// Picks which models of a provider's live /models catalog are worth importing: chat models
// that are not already built in, saved as custom models, or present as legacy aliases.
// Returns entries ready for POST /api/models/custom ({ models: [...] }).
export function getModelsToImport({
  fetchedModels = [],
  providerId,
  providerAlias,
  existingModels = [],
  customModels = [],
  modelAliases = {},
}) {
  const prefixes = [providerId, providerAlias];
  const knownIds = new Set(existingModels.map((model) => model.id));

  for (const model of customModels) {
    if (model?.providerAlias === providerAlias && modelType(model) === "llm") knownIds.add(model.id);
  }
  for (const fullModel of Object.values(modelAliases || {})) {
    if (typeof fullModel !== "string") continue;
    const prefix = matchedPrefix(fullModel, prefixes);
    if (prefix) knownIds.add(fullModel.slice(prefix.length + 1));
  }

  const toImport = [];
  for (const model of fetchedModels) {
    const rawId = model?.id || model?.name || model?.model;
    if (typeof rawId !== "string" || NON_LLM_KINDS.has(model.kind || model.type) || NON_LLM_ID_PATTERN.test(rawId)) continue;

    // Gemini lists models as { name: "models/<id>" }; the "models/" resource prefix is not part of the id.
    const id = stripProviderPrefix(rawId.replace(/^models\//, ""), prefixes);
    if (!id || knownIds.has(id)) continue;

    knownIds.add(id);
    toImport.push({ providerAlias, id, type: "llm" });
  }
  return toImport;
}

export function getProviderCustomModelRows({
  customModels = [],
  modelAliases = {},
  providerAlias,
  builtInModels = [],
  type = "llm",
  includeLegacyAliases = true,
}) {
  const builtInIds = new Set(builtInModels.map((model) => model.id));
  const seenFullModels = new Set();
  const rows = [];

  for (const model of customModels) {
    if (!model?.id || model.providerAlias !== providerAlias) continue;
    const rowType = modelType(model);
    if (type && rowType !== type) continue;
    if (builtInIds.has(model.id)) continue;

    const fullModel = `${providerAlias}/${model.id}`;
    if (seenFullModels.has(fullModel)) continue;
    seenFullModels.add(fullModel);
    rows.push({
      id: model.id,
      name: model.name || model.id,
      fullModel,
      source: "custom",
      type: rowType,
    });
  }

  if (!includeLegacyAliases) return rows;

  const prefix = `${providerAlias}/`;
  for (const [alias, fullModel] of Object.entries(modelAliases || {})) {
    if (typeof fullModel !== "string" || !fullModel.startsWith(prefix)) continue;
    const id = fullModel.slice(prefix.length);
    if (!id || builtInIds.has(id) || seenFullModels.has(fullModel)) continue;

    seenFullModels.add(fullModel);
    rows.push({
      id,
      alias,
      fullModel,
      source: "legacyAlias",
      type: type || "llm",
    });
  }

  return rows;
}
