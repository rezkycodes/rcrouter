import { filterModelsListForKey } from "./keyAccess.js";
import { stripComboPrefix } from "open-sse/services/combo.js";

/**
 * Apply a key's per-key `access` allow list to a published models list.
 *
 * keyAccess.js matches combos by bare name, while RcRouter's model listings publish
 * them as "combo/<name>" — so combos are shown to the filter without the prefix and the
 * original ids are kept in the result. A null context (no key, unknown key, or
 * unrestricted key) leaves the list untouched.
 */
export async function filterModelsByKeyAccess(ctx, data) {
  if (!ctx) return data;
  const forAccess = data.map((model) =>
    model.owned_by === "combo" ? { ...model, id: stripComboPrefix(model.id) } : model
  );
  const visible = new Set(await filterModelsListForKey(ctx, forAccess));
  return data.filter((_, i) => visible.has(forAccess[i]));
}
