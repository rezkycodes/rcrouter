// Tool-name length limits per upstream wire format. Pure data + one resolver.
//
// OpenAI Chat Completions, Gemini/Vertex/Antigravity, Kiro, Cursor, Ollama and
// most OpenAI-compatible gateways cap function names at 64 characters. Claude
// (`^[a-zA-Z0-9_-]{1,128}$`) and the OpenAI Responses API accept 128, so names
// of 65-128 characters are sent to those targets untouched.

import { FORMATS } from "../translator/formats.js";

export const DEFAULT_TOOL_NAME_MAX_LENGTH = 64;

export const TOOL_NAME_MAX_LENGTH_BY_FORMAT = Object.freeze({
  [FORMATS.CLAUDE]: 128,
  [FORMATS.OPENAI_RESPONSES]: 128,
  [FORMATS.CODEX]: 128,
});

// Length of the base36 hash appended to a shortened name ("<prefix>_<hash>").
export const TOOL_NAME_HASH_LENGTH = 8;

// Smallest limit we can honor: one prefix char + "_" + hash.
export const MIN_TOOL_NAME_MAX_LENGTH = TOOL_NAME_HASH_LENGTH + 2;

/**
 * Resolve the tool-name limit for a target format. A provider may override it
 * with `quirks.toolNameMaxLength` (positive integer) in its registry entry.
 * Anything unusable falls back to the per-format / default value.
 * @param {string|null} targetFormat
 * @param {object|null} [quirks] - provider quirks (PROVIDERS[id].quirks)
 * @returns {number}
 */
export function resolveToolNameMaxLength(targetFormat, quirks = null) {
  const override = quirks?.toolNameMaxLength;
  if (Number.isInteger(override) && override >= MIN_TOOL_NAME_MAX_LENGTH) return override;
  return TOOL_NAME_MAX_LENGTH_BY_FORMAT[targetFormat] ?? DEFAULT_TOOL_NAME_MAX_LENGTH;
}
