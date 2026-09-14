/**
 * Auto-Combo Engine: Zero-Config Dynamic Routing with Manual Override Support
 *
 * Supported variants:
 * - auto              (General balanced routing across all active connections)
 * - auto/coding       (Code generation models with Prompt Cache affinity via Context-Relay)
 * - auto/fast         (Low-latency models load-balanced via P2C)
 * - auto/cheap        (Zero-cost / free-tier models prioritized by Reset-Aware)
 * - auto/reasoning    (Deep thinking and reasoning models)
 */

export const AUTO_VARIANTS = {
  DEFAULT: "auto",
  CODING: "auto/coding",
  FAST: "auto/fast",
  CHEAP: "auto/cheap",
  REASONING: "auto/reasoning",
};

export const AUTO_MODELS_LIST = [
  { id: "auto", object: "model", owned_by: "auto-combo", description: "General balanced routing across all active connections" },
  { id: "auto/coding", object: "model", owned_by: "auto-combo", description: "Coding-optimized models with prompt cache affinity (Context-Relay)" },
  { id: "auto/fast", object: "model", owned_by: "auto-combo", description: "Fast low-latency models with P2C load balancing" },
  { id: "auto/cheap", object: "model", owned_by: "auto-combo", description: "Free & cheap models prioritized by quota reset time (Reset-Aware)" },
  { id: "auto/reasoning", object: "model", owned_by: "auto-combo", description: "Thinking & reasoning models with session continuity" },
];

/**
 * Check if model string represents an auto-combo route
 * @param {string} modelStr
 * @returns {boolean}
 */
export function isAutoCombo(modelStr) {
  if (typeof modelStr !== "string") return false;
  return modelStr === "auto" || modelStr.startsWith("auto/");
}

/**
 * Extract normalized auto-combo key (e.g. "auto", "auto/coding")
 * @param {string} modelStr
 * @returns {string}
 */
export function normalizeAutoVariant(modelStr) {
  if (!isAutoCombo(modelStr)) return "auto";
  const parts = modelStr.toLowerCase().split("/");
  if (parts.length === 1 || !parts[1]) return "auto";
  return `auto/${parts[1]}`;
}

/**
 * Dynamically resolves candidate models and routing strategy for auto-combo routes.
 * Supports manual overrides via settings.autoComboConfig.
 *
 * @param {object} params
 * @param {string} params.modelStr - Incoming model name (e.g. "auto/coding")
 * @param {object} params.settings - App settings
 * @param {Array<object>} [params.connections] - Pre-fetched active connections
 * @param {Function} [params.getComboModels] - Function to lookup manual combos
 * @param {Function} [params.candidateFilter] - Async predicate for ACL/health/quota eligibility
 * @returns {Promise<{ models: string[], strategy: string, variant: string, isAuto: boolean, noEligibleTargets?: boolean, reason?: string }>}
 */
export async function resolveAutoCombo({
  modelStr,
  settings = {},
  connections = null,
  getComboModels = null,
  candidateFilter = null,
}) {
  const variant = normalizeAutoVariant(modelStr);
  const autoConfig = (settings?.autoComboConfig && settings.autoComboConfig[variant]) || {};

  // 1. Check if user configured manual override
  const mode = autoConfig.mode || "auto"; // "auto" | "combo" | "custom"
  const strategyOverride = autoConfig.strategy;

  const filterModels = async (models, source, connection = null) => {
    if (!Array.isArray(models) || models.length === 0 || typeof candidateFilter !== "function") {
      return Array.isArray(models) ? models : [];
    }
    const eligible = [];
    for (const model of models) {
      try {
        if (await candidateFilter({ model, connection, source, variant })) eligible.push(model);
      } catch {
        // A failed health/ACL probe must not make an unverified target routable.
      }
    }
    return eligible;
  };

  // Mode: Link to an existing manual combo
  if (mode === "combo" && autoConfig.linkedCombo && typeof getComboModels === "function") {
    const linkedModels = await filterModels(
      await getComboModels(autoConfig.linkedCombo),
      "linked-combo"
    );
    if (Array.isArray(linkedModels) && linkedModels.length > 0) {
      return {
        models: linkedModels,
        strategy: strategyOverride || autoConfig.linkedStrategy || "context-relay",
        variant,
        isAuto: true,
      };
    }
  }

  // Mode: Custom selected models list
  if (mode === "custom" && Array.isArray(autoConfig.customModels) && autoConfig.customModels.length > 0) {
    const customModels = await filterModels(autoConfig.customModels, "custom");
    if (customModels.length === 0) {
      return {
        models: [],
        strategy: strategyOverride || "context-relay",
        variant,
        isAuto: true,
        noEligibleTargets: true,
        reason: "no-eligible-custom-models",
      };
    }
    return {
      models: customModels,
      strategy: strategyOverride || "context-relay",
      variant,
      isAuto: true,
    };
  }

  // Mode: Dynamic Auto (Default) - Inspect active connections in SQLite
  let activeConns = connections;
  if (!Array.isArray(activeConns)) {
    try {
      const { getProviderConnections } = await import("../../src/lib/db/repos/connectionsRepo.js");
      activeConns = await getProviderConnections({ isActive: true });
    } catch {
      activeConns = [];
    }
  }

  // Collect candidate model strings from active connections
  const candidates = [];
  for (const conn of activeConns) {
    if (!conn || conn.isActive === false) continue;
    const provider = conn.provider;
    if (!provider) continue;

    const defaultModel = conn.defaultModel;
    // A connection without an explicit model cannot produce an executable
    // target; keep the no-candidate result typed instead of inventing a model.
    if (!defaultModel) continue;
    const candidate = defaultModel.includes("/") ? defaultModel : `${provider}/${defaultModel}`;
    const [eligibleCandidate] = await filterModels([candidate], "connection", conn);
    if (eligibleCandidate) {
      candidates.push(candidate);
    }
  }

  // Filter candidates according to variant capabilities
  let filtered = [];
  let defaultStrategy = "context-relay";

  if (variant === "auto/coding") {
    defaultStrategy = "context-relay";
    filtered = candidates.filter((m) =>
      /claude|sonnet|glm|deepseek|qwen.*coder|coder|codex|gpt-4|cursor/i.test(m)
    );
  } else if (variant === "auto/fast") {
    defaultStrategy = "p2c";
    filtered = candidates.filter((m) =>
      /groq|cerebras|flash|haiku|mini|turbo|8b/i.test(m)
    );
  } else if (variant === "auto/cheap") {
    defaultStrategy = "reset-aware";
    filtered = candidates.filter((m) =>
      /kiro|opencode|glm.*flash|free|ollama|deepseek/i.test(m)
    );
  } else if (variant === "auto/reasoning") {
    defaultStrategy = "context-relay";
    filtered = candidates.filter((m) =>
      /kimi|r1|reason|thinking|deepseek.*r1|gemini.*thinking/i.test(m)
    );
  } else {
    // "auto" (default balanced)
    defaultStrategy = "context-relay";
    filtered = [...candidates];
  }

  // Fallback: If filtered set is empty, fall back to all active candidates so a
  // narrow policy does not fail while there are still routable connections.
  const finalModels = filtered.length > 0 ? filtered : candidates;

  // A placeholder such as "auto/fallback" is not executable by the downstream
  // provider path. Return a typed result instead so the API can explain the
  // unavailability without attempting a synthetic model.
  if (finalModels.length === 0) {
    return {
      models: [],
      strategy: strategyOverride || defaultStrategy,
      variant,
      isAuto: true,
      noEligibleTargets: true,
      reason: "no-active-connections",
    };
  }

  return {
    models: finalModels,
    strategy: strategyOverride || defaultStrategy,
    variant,
    isAuto: true,
  };
}
