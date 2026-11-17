// Tool-name fitting: shorten tool names that exceed an upstream's length limit
// (OpenAI-style 64 chars, Issue #148 in VansRouter) deterministically and
// without collisions, and expose the reverse map so responses can restore the
// ORIGINAL name (see utils/toolNameRestore.js).
//
// Runs on the CLIENT-shaped body at the start of translateRequest(), so every
// downstream translator (OpenAI / Claude / Responses / Gemini / Kiro ...) sees
// names that already fit. Shapes covered: OpenAI chat, Claude and Responses
// (tools, tool_choice, history tool_calls / tool_use / function_call items).
//
// Pure: the input body is never mutated. Untouched branches are shared with the
// input; when nothing needs fitting the very same body object is returned.

import { TOOL_NAME_HASH_LENGTH } from "../../config/toolNameLimits.js";
import { ROLE, CLAUDE_BLOCK, RESPONSES_ITEM } from "../schema/index.js";

// Non-enumerable carrier for the reverse map on the translated body, so it
// never leaks into JSON / spread copies (unlike the legacy `_toolNameMap`).
export const FITTED_TOOL_NAMES_KEY = "_fittedToolNames";

const NAMED_INPUT_ITEM_TYPES = new Set([RESPONSES_ITEM.FUNCTION_CALL, RESPONSES_ITEM.CUSTOM_TOOL_CALL]);
const NAMED_MESSAGE_ROLES = new Set([ROLE.TOOL, "function"]);

/** 53-bit string hash (cyrb53) rendered as a fixed-width base36 string. */
function hashName(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  const value = 4294967296 * (2097151 & h2) + (h1 >>> 0);
  return value.toString(36).padStart(TOOL_NAME_HASH_LENGTH, "0").slice(-TOOL_NAME_HASH_LENGTH);
}

/**
 * "<prefix>_<hash>" of exactly <= maxLength chars. `attempt` salts the hash and
 * is only non-zero after a collision, so the common case depends on the name alone.
 */
function fitName(name, maxLength, attempt) {
  const suffix = `_${hashName(attempt === 0 ? name : `${name}#${attempt}`)}`;
  let end = maxLength - suffix.length;
  const lastUnit = name.charCodeAt(end - 1);
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) end -= 1; // never split a surrogate pair
  return `${name.slice(0, end)}${suffix}`;
}

/**
 * Assign every over-long name a unique fitted name that cannot collide with a
 * short name in use or with another fitted name.
 * @returns {Map<string,string>} original -> fitted
 */
function buildFittedNames(names, maxLength) {
  const taken = new Set();
  for (const name of names) if (name.length <= maxLength) taken.add(name);
  const fittedByOriginal = new Map();
  for (const name of names) {
    if (name.length <= maxLength || fittedByOriginal.has(name)) continue;
    let attempt = 0;
    let candidate = fitName(name, maxLength, attempt);
    while (taken.has(candidate)) candidate = fitName(name, maxLength, ++attempt);
    taken.add(candidate);
    fittedByOriginal.set(name, candidate);
  }
  return fittedByOriginal;
}

// ---- structural rewriting (copy-on-write) -------------------------------

const isObject = (value) => value !== null && typeof value === "object";

function mapList(list, fn) {
  if (!Array.isArray(list)) return list;
  let changed = false;
  const next = list.map((item) => {
    const mapped = fn(item);
    if (mapped !== item) changed = true;
    return mapped;
  });
  return changed ? next : list;
}

function renameField(node, key, rename) {
  const current = node?.[key];
  if (typeof current !== "string") return node;
  const next = rename(current);
  return next === current ? node : { ...node, [key]: next };
}

/** tools[] entries and history tool_calls[]: `{function:{name}}` or `{name}`. */
function mapNamed(entry, rename) {
  if (!isObject(entry)) return entry;
  if (isObject(entry.function) && typeof entry.function.name === "string") {
    const fn = renameField(entry.function, "name", rename);
    return fn === entry.function ? entry : { ...entry, function: fn };
  }
  return renameField(entry, "name", rename);
}

function mapToolChoice(choice, rename) {
  if (!isObject(choice)) return choice;
  let next = mapNamed(choice, rename);
  if (Array.isArray(choice.tools)) {
    const tools = mapList(choice.tools, (tool) => mapNamed(tool, rename));
    if (tools !== choice.tools) next = { ...next, tools };
  }
  return next;
}

function mapMessage(msg, rename) {
  if (!isObject(msg)) return msg;
  let next = msg;
  if (Array.isArray(msg.tool_calls)) {
    const toolCalls = mapList(msg.tool_calls, (call) => mapNamed(call, rename));
    if (toolCalls !== msg.tool_calls) next = { ...next, tool_calls: toolCalls };
  }
  if (Array.isArray(msg.content)) {
    const content = mapList(msg.content, (block) =>
      block?.type === CLAUDE_BLOCK.TOOL_USE ? renameField(block, "name", rename) : block);
    if (content !== msg.content) next = { ...next, content };
  }
  if (NAMED_MESSAGE_ROLES.has(msg.role)) next = renameField(next, "name", rename);
  return next;
}

function mapInputItem(item, rename) {
  return NAMED_INPUT_ITEM_TYPES.has(item?.type) ? renameField(item, "name", rename) : item;
}

/** Apply `rename(name) -> name` to every tool-name position; returns `body` if nothing changed. */
function rewriteToolNames(body, rename) {
  const patch = {};
  const tools = mapList(body.tools, (tool) => mapNamed(tool, rename));
  if (tools !== body.tools) patch.tools = tools;
  const toolChoice = mapToolChoice(body.tool_choice, rename);
  if (toolChoice !== body.tool_choice) patch.tool_choice = toolChoice;
  const messages = mapList(body.messages, (msg) => mapMessage(msg, rename));
  if (messages !== body.messages) patch.messages = messages;
  const input = mapList(body.input, (item) => mapInputItem(item, rename));
  if (input !== body.input) patch.input = input;
  return Object.keys(patch).length === 0 ? body : { ...body, ...patch };
}

/**
 * Fit every tool name longer than `maxLength` in a client-shaped request body.
 * @param {object} body - request body (not mutated)
 * @param {number} maxLength - upstream limit (see resolveToolNameMaxLength)
 * @returns {{ body: object, restoreMap: Map<string,string>|null }}
 *   `restoreMap` maps fitted -> original; null (and the identical `body`) when
 *   every name already fits.
 */
export function fitToolNames(body, maxLength) {
  if (!isObject(body)) return { body, restoreMap: null };

  const seen = new Set();
  rewriteToolNames(body, (name) => {
    seen.add(name);
    return name;
  });
  if (![...seen].some((name) => name.length > maxLength)) return { body, restoreMap: null };

  const fittedByOriginal = buildFittedNames([...seen], maxLength);
  const fitted = rewriteToolNames(body, (name) => fittedByOriginal.get(name) ?? name);
  const restoreMap = new Map([...fittedByOriginal].map(([original, short]) => [short, original]));
  return { body: fitted, restoreMap };
}

/** Attach the reverse map to a translated body as a non-enumerable property. */
export function attachFittedToolNames(body, restoreMap) {
  if (!isObject(body) || !restoreMap?.size) return body;
  Object.defineProperty(body, FITTED_TOOL_NAMES_KEY, {
    value: restoreMap, enumerable: false, configurable: true, writable: true,
  });
  return body;
}

/** Read the reverse map attached by attachFittedToolNames (undefined when none). */
export function getFittedToolNames(body) {
  const map = body?.[FITTED_TOOL_NAMES_KEY];
  return map instanceof Map && map.size > 0 ? map : undefined;
}
