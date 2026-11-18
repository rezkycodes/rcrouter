// The one definition of the id `/v1/models` publishes for a combo ("combo/<name>").
// Publishing and resolving both go through here so they cannot drift apart again.
// Dependency-free on purpose: the request handlers and the model resolver import it,
// and several test suites replace open-sse/services/combo.js with a stub.

export const COMBO_ID_PREFIX = "combo/";

/** "Main" -> "combo/Main" (the id published in the model catalog). */
export function comboModelId(name) {
  return `${COMBO_ID_PREFIX}${name}`;
}

/** "combo/Main" -> "Main". Anything else (bare name, provider/model, non-string) is returned unchanged. */
export function stripComboPrefix(modelStr) {
  if (typeof modelStr !== "string") return modelStr;
  return modelStr.startsWith(COMBO_ID_PREFIX) ? modelStr.slice(COMBO_ID_PREFIX.length) : modelStr;
}
