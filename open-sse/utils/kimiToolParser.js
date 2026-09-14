/**
 * Native Kimi tool-call markup parser.
 *
 * Kimi K2.6/K2.7 (served through Kimchi / Cast AI / NVIDIA) occasionally leaks its native
 * token-based tool-call format into the OpenAI `content` field instead of
 * populating the structured `tool_calls` array. This module detects that markup
 * and extracts normalized OpenAI-style tool_calls.
 *
 * Observed raw markup shapes:
 *
 *   Format 1 (token markup):
 *   <|tool_calls_section_begin|> <|tool_call_begin|> functions.NAME:ID <|tool_call_argument_begin|> {JSON} <|tool_call_end|> <|tool_calls_section_end|>
 *
 *   Format 2 (legacy prefix):
 *   <optional prose / whitespace>functions.NAME:ID {"arg": "value"}functions.NAME:ID {"arg": "value"}
 *
 * Where:
 *   - `functions.` is the optional/literal prefix.
 *   - `NAME` is the tool name.
 *   - `:ID` is an optional call identifier (e.g. `:0`).
 *   - The argument block is a JSON object.
 *
 * The parser is intentionally conservative: it only extracts tool calls when the
 * content matches the native Kimi pattern. It returns the original content when
 * no markup is found, and never throws for malformed input.
 */

const KIMI_TOOL_PREFIX = "functions.";
const KIMI_SECTION_BEGIN = "<|tool_calls_section_begin|>";
const KIMI_SECTION_END = "<|tool_calls_section_end|>";
const KIMI_CALL_BEGIN = "<|tool_call_begin|>";
const KIMI_CALL_END = "<|tool_call_end|>";
const KIMI_ARG_BEGIN = "<|tool_call_argument_begin|>";
const KIMI_ARG_END = "<|tool_call_argument_end|>";

// Maximum recursion / iteration guard for malformed payloads.
const MAX_CALLS = 64;

/**
 * Detect whether a string contains native Kimi tool-call markup.
 *
 * @param {string|null|undefined} content
 * @returns {boolean}
 */
export function hasKimiToolMarkup(content) {
  if (typeof content !== "string" || content.length === 0) return false;
  return (
    content.includes(KIMI_SECTION_BEGIN) ||
    content.includes(KIMI_CALL_BEGIN) ||
    content.includes(KIMI_TOOL_PREFIX)
  );
}

/**
 * Split content into a leading prose portion and the raw tool-call tail.
 *
 * Everything from the first tool-call marker occurrence onward is considered the
 * tool-call region. Leading whitespace is trimmed; if the leading prose is empty
 * the result is an empty string.
 *
 * @param {string} content
 * @returns {{ prefix: string, tail: string }}
 */
export function splitKimiToolRegion(content) {
  if (typeof content !== "string" || content.length === 0) return { prefix: "", tail: "" };

  let earliestIdx = -1;
  for (const marker of [KIMI_SECTION_BEGIN, KIMI_CALL_BEGIN, KIMI_TOOL_PREFIX]) {
    const idx = content.indexOf(marker);
    if (idx !== -1 && (earliestIdx === -1 || idx < earliestIdx)) {
      earliestIdx = idx;
    }
  }

  if (earliestIdx === -1) return { prefix: content, tail: "" };
  return {
    prefix: content.slice(0, earliestIdx).trim(),
    tail: content.slice(earliestIdx),
  };
}

/**
 * Parse a balanced JSON object from the start of a string.
 *
 * Scans character-by-character, respecting string escaping and nested braces.
 *
 * @param {string} text
 * @returns {object}
 */
export function parseJsonObject(text) {
  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      depth++;
      if (depth === 1) end = -1;
      continue;
    }

    if (ch === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
      continue;
    }
  }

  if (end === -1) {
    throw new Error("unbalanced JSON object");
  }

  return JSON.parse(text.slice(0, end));
}

/**
 * Parse a single Kimi tool-call fragment of the form `NAME:ID {JSON}` or
 * `NAME {JSON}`.
 *
 * Returns null if the fragment cannot be parsed. The returned object matches
 * the OpenAI tool_calls item shape:
 *
 *   {
 *     id: string,
 *     type: "function",
 *     function: { name: string, arguments: string }
 *   }
 *
 * @param {string} raw
 * @param {number} index
 * @returns {{id: string, type: "function", function: {name: string, arguments: string}}|null}
 */
export function parseKimiToolCallFragment(raw, index) {
  if (typeof raw !== "string" || raw.length === 0) return null;

  // Find the JSON object: it starts with the first '{' and ends at the
  // matching '}'. We avoid naive regex parsing so nested objects and quoted
  // braces are handled correctly.
  const jsonStart = raw.indexOf("{");
  if (jsonStart === -1) return null;

  const header = raw.slice(0, jsonStart).trim();
  const argsRaw = raw.slice(jsonStart);

  // Header is either "NAME", "functions.NAME", "NAME:ID", or "functions.NAME:ID".
  const headerMatch = header.match(/^(?:functions\.)?([a-zA-Z0-9_\-/.]+)(?::([a-zA-Z0-9_\-]+))?$/);
  if (!headerMatch) return null;

  const name = headerMatch[1];
  const providedId = headerMatch[2];

  let args;
  try {
    args = parseJsonObject(argsRaw);
  } catch {
    return null;
  }

  const id = providedId ? `functions.${name}:${providedId}` : `functions.${name}:${index}`;

  return {
    id,
    type: "function",
    function: {
      name,
      arguments: JSON.stringify(args),
    },
  };
}

/**
 * Extract all native Kimi tool calls from a content string.
 * Handles both token-based markup (<|tool_calls_section_begin|>, <|tool_call_begin|>)
 * and raw string markup (functions.NAME:ID {...}).
 *
 * Returns an empty array when no markup is present or when parsing fails.
 *
 * @param {string} content
 * @returns {Array<{id: string, type: "function", function: {name: string, arguments: string}}>}
 */
export function extractKimiToolCalls(content) {
  if (!hasKimiToolMarkup(content)) return [];

  const { tail } = splitKimiToolRegion(content);
  if (!tail) return [];

  // Strategy 1: Token-based markup (<|tool_call_begin|>)
  if (tail.includes(KIMI_CALL_BEGIN)) {
    const calls = [];
    let pos = 0;
    let index = 0;

    while (pos < tail.length && calls.length < MAX_CALLS) {
      const beginIdx = tail.indexOf(KIMI_CALL_BEGIN, pos);
      if (beginIdx === -1) break;
      const afterBegin = beginIdx + KIMI_CALL_BEGIN.length;

      const argBeginIdx = tail.indexOf(KIMI_ARG_BEGIN, afterBegin);
      const firstBraceIdx = tail.indexOf("{", afterBegin);

      let headerEnd = -1;
      let jsonStart = -1;

      if (argBeginIdx !== -1 && (firstBraceIdx === -1 || argBeginIdx < firstBraceIdx)) {
        headerEnd = argBeginIdx;
        jsonStart = tail.indexOf("{", argBeginIdx + KIMI_ARG_BEGIN.length);
      } else if (firstBraceIdx !== -1) {
        headerEnd = firstBraceIdx;
        jsonStart = firstBraceIdx;
      } else {
        break;
      }

      if (jsonStart === -1) break;

      const header = tail.slice(afterBegin, headerEnd).trim();
      const headerMatch = header.match(/^(?:functions\.)?([a-zA-Z0-9_\-/.]+)(?::([a-zA-Z0-9_\-]+))?$/);
      if (!headerMatch) {
        pos = afterBegin;
        continue;
      }

      const name = headerMatch[1];
      const providedId = headerMatch[2];
      const id = providedId ? `functions.${name}:${providedId}` : `functions.${name}:${index}`;

      try {
        const argsObj = parseJsonObject(tail.slice(jsonStart));
        calls.push({
          id,
          type: "function",
          function: {
            name,
            arguments: JSON.stringify(argsObj),
          },
        });
        index++;

        const endIdx = tail.indexOf(KIMI_CALL_END, jsonStart);
        if (endIdx !== -1) {
          pos = endIdx + KIMI_CALL_END.length;
        } else {
          pos = jsonStart + 1;
        }
      } catch {
        pos = afterBegin;
      }
    }

    if (calls.length > 0) return calls;
  }

  // Strategy 2: Legacy raw prefix extraction (functions.NAME:ID {JSON})
  const calls = [];
  let remaining = tail;
  let index = 0;

  while (remaining.length > 0 && calls.length < MAX_CALLS) {
    if (!remaining.startsWith(KIMI_TOOL_PREFIX)) break;

    // Drop the prefix.
    remaining = remaining.slice(KIMI_TOOL_PREFIX.length);

    // Find where this call ends: the next prefix or end of string.
    const nextPrefix = remaining.indexOf(KIMI_TOOL_PREFIX);
    const fragment = nextPrefix === -1 ? remaining : remaining.slice(0, nextPrefix);

    const call = parseKimiToolCallFragment(fragment, index);
    if (!call) break;

    calls.push(call);
    index++;

    if (nextPrefix === -1) break;
    remaining = remaining.slice(nextPrefix);
  }

  return calls;
}

/**
 * Normalize an assistant message that may contain leaked native Kimi markup.
 *
 * If native tool-call markup is detected, the content is trimmed to the leading
 * prose (or empty string) and a structured `tool_calls` array is attached. The
 * caller can also set `finish_reason` to `"tool_calls"` based on the returned
 * `hasTools` flag.
 *
 * Returns an object with the normalized message and metadata:
 *
 *   {
 *     message: { role: "assistant", content: string, tool_calls?: array },
 *     hasTools: boolean,
 *     originalContent: string
 *   }
 *
 * @param {{role?: string, content?: string, tool_calls?: array|null}} message
 * @returns {{message: object, hasTools: boolean, originalContent: string}}
 */
export function normalizeKimiToolCalls(message) {
  const original = message?.content;
  const originalContent = typeof original === "string" ? original : "";

  // Respect already-structured tool_calls.
  if (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0) {
    return {
      message: { ...message },
      hasTools: true,
      originalContent,
    };
  }

  const calls = extractKimiToolCalls(originalContent);
  if (calls.length === 0) {
    return {
      message: { ...message },
      hasTools: false,
      originalContent,
    };
  }

  const { prefix } = splitKimiToolRegion(originalContent);

  return {
    message: {
      ...message,
      content: prefix,
      tool_calls: calls,
    },
    hasTools: true,
    originalContent,
  };
}

/**
 * Convenience wrapper that returns the OpenAI-style tool_calls array, or null
 * when no native markup is present.
 *
 * @param {string|null|undefined} content
 * @returns {array|null}
 */
export function parseKimiToolCalls(content) {
  const calls = extractKimiToolCalls(content);
  return calls.length > 0 ? calls : null;
}
