import { FORMATS } from "../../translator/formats.js";

// Source formats whose public API defaults to a plain JSON reply when `stream` is
// omitted (OpenAI Chat Completions, Anthropic Messages, OpenAI Responses). The
// Gemini family is endpoint-driven (:streamGenerateContent vs :generateContent), so
// an absent body field says nothing there and keeps the legacy streaming default.
const JSON_BY_DEFAULT_FORMATS = new Set([
  FORMATS.OPENAI,
  FORMATS.CLAUDE,
  FORMATS.OPENAI_RESPONSES,
]);

/**
 * Decide whether to stream the reply to the client.
 *
 * - providers that only speak SSE always stream;
 * - an explicit `stream` field wins (`false` -> JSON, any other non-null value -> SSE);
 * - an omitted field follows the client API's own default: JSON, unless the client
 *   asks for an event stream via `Accept` without also accepting JSON.
 *
 * @param {{ body: object, sourceFormat: string, acceptHeader?: string, providerRequiresStreaming?: boolean }} input
 * @returns {boolean}
 */
export function resolveStreamMode({ body, sourceFormat, acceptHeader = "", providerRequiresStreaming = false }) {
  if (providerRequiresStreaming) return true;

  const requested = body?.stream;
  if (requested === false) return false;
  if (requested !== undefined && requested !== null) return true;

  if (!JSON_BY_DEFAULT_FORMATS.has(sourceFormat)) return true;

  const wantsSse = acceptHeader.includes("text/event-stream");
  const wantsJson = acceptHeader.includes("application/json");
  return wantsSse && !wantsJson;
}
