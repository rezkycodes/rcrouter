/**
 * TargetDescriptor — typed carrier for a resolved model + account affinity.
 *
 * Replaces bare model strings in the internal routing pipeline so that
 * connectionId, proxyPoolId, and timing metadata travel with the target
 * rather than being re-derived at every hop.
 *
 * @typedef {Object} TargetDescriptor
 * @property {string}      modelStr       - "provider/model" string
 * @property {string}      provider
 * @property {string}      model
 * @property {string|null} connectionId   - pinned account (null = free selection)
 * @property {string|null} proxyPoolId
 * @property {number}      createdAt      - epoch ms when the descriptor was made
 */

/**
 * Build a TargetDescriptor from a model string and optional account pin.
 * @param {string} modelStr
 * @param {string|null} [connectionId]
 * @param {object} [extra] - proxyPoolId, etc.
 * @returns {TargetDescriptor}
 */
export function makeDescriptor(modelStr, connectionId = null, extra = {}) {
  const slash = typeof modelStr === "string" ? modelStr.indexOf("/") : -1;
  return {
    modelStr: modelStr || "",
    provider: slash > 0 ? modelStr.slice(0, slash) : "",
    model: slash > 0 ? modelStr.slice(slash + 1) : (modelStr || ""),
    connectionId: connectionId ?? null,
    proxyPoolId: extra.proxyPoolId ?? null,
    createdAt: Date.now(),
  };
}

/**
 * Normalize a model string OR TargetDescriptor to a bare model string.
 * Safe to call on anything the combo pipeline might produce.
 * @param {string|TargetDescriptor|null|undefined} target
 * @returns {string}
 */
export function descriptorKey(target) {
  if (!target) return "";
  if (typeof target === "string") return target;
  return target.modelStr || target.model || "";
}

/**
 * Extract the connectionId from a TargetDescriptor (or null for bare strings).
 * @param {string|TargetDescriptor|null|undefined} target
 * @returns {string|null}
 */
export function descriptorConnectionId(target) {
  if (!target || typeof target === "string") return null;
  return target.connectionId ?? null;
}

/**
 * Clone a descriptor, overwriting fields.
 * @param {TargetDescriptor} descriptor
 * @param {Partial<TargetDescriptor>} overrides
 * @returns {TargetDescriptor}
 */
export function cloneDescriptor(descriptor, overrides = {}) {
  return { ...descriptor, ...overrides };
}
