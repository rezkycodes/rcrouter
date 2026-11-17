// Loop guard: stateless detection of repeating tool call patterns in conversation history.
// Analyzes messages array in the current request body - no cross-request state needed.
// Returns { detected: bool, hint: string|null } (plus `error` when the guard failed open).
//
// Work is strictly bounded so the guard can never stall the event loop on huge
// agent sessions: only the most recent tool calls / assistant messages are
// inspected, repeat sequences are length-capped, and large texts (big code or
// diff dumps) are never sentence-split.

const SINGLE_REPEAT_THRESHOLD = 3; // same tool+args appearing >= this many times
const SEQUENCE_REPEAT_THRESHOLD = 2; // same sequence of N tool calls appearing >= this many times
const MIN_SEQUENCE_LENGTH = 2; // minimum sequence length to detect
const MAX_SEQUENCE_LENGTH = 6; // maximum sequence length to detect (agent loops are tight cycles)
const RECENT_TOOL_WINDOW = 40; // only inspect the most recent tool calls (bounds the O(N^2 * len) scan)
const RECENT_TEXT_WINDOW = 20; // only inspect the most recent assistant messages for text loops

// Text-loop detection thresholds (symptom: model repeats planning/intent text
// without ever making a tool call — e.g. "I need to read the key files..." 6×).
const TEXT_MESSAGE_REPEAT_THRESHOLD = 3; // same normalized assistant message >= this many times
const TEXT_SENTENCE_REPEAT_THRESHOLD = 3; // same sentence across all assistant msgs >= this many times
const MIN_TEXT_LENGTH = 12; // ignore tiny fragments (< this many chars) to avoid false positives
const MAX_TEXT_SCAN_CHARS = 4096; // never sentence-split texts longer than this (4 KB)

export const LOOP_GUARD_LIMITS = Object.freeze({
  MAX_SEQUENCE_LENGTH,
  RECENT_TOOL_WINDOW,
  RECENT_TEXT_WINDOW,
  MAX_TEXT_SCAN_CHARS,
});

const NO_LOOP = Object.freeze({ detected: false, hint: null });

const HINT_SINGLE_REPEAT =
  "You have called the same tool with identical arguments multiple times with no new progress. STOP repeating. Summarize findings from existing results or change your strategy.";
const HINT_SEQUENCE_REPEAT =
  "You have repeated the same sequence of tool calls multiple times. This is a loop. STOP this pattern immediately. Summarize what you have already found or take a completely different approach.";
const HINT_MESSAGE_REPEAT =
  "You have repeated the same response multiple times without making progress. This is a text loop — you are NOT moving forward. STOP repeating yourself. Either call a tool to act, or give your final answer now with the information you already have.";
const HINT_SENTENCE_REPEAT =
  "You keep repeating the same planning statement without acting on it. STOP planning in circles. Either execute a tool call NOW, or provide your final answer with current knowledge. Do not restate your plan again.";

/**
 * Normalize tool call arguments for stable hashing:
 * Sort object keys recursively so equivalent nested objects produce the same hash.
 * Some adapters already decode arguments, so object input is supported as well.
 */
function normalizeArgs(rawArgs) {
  let value = rawArgs;
  if (typeof rawArgs === "string") {
    try {
      value = JSON.parse(rawArgs);
    } catch {
      return rawArgs || "";
    }
  }
  if (value === null || typeof value !== "object") return String(value ?? "");

  const sortKeys = (entry) => {
    if (Array.isArray(entry)) return entry.map(sortKeys);
    if (!entry || typeof entry !== "object") return entry;
    return Object.fromEntries(
      Object.keys(entry)
        .sort()
        .map((key) => [key, sortKeys(entry[key])]),
    );
  };

  return JSON.stringify(sortKeys(value));
}

function toolCallHash(tc) {
  const name = tc?.function?.name || tc?.name || "";
  const args = normalizeArgs(tc?.function?.arguments || tc?.arguments || "");
  return `${name}::${args}`;
}

/**
 * Extract tool_call hashes from the most recent conversation history, in order.
 * Scans newest-to-oldest and stops after `maxCalls` so serialization cost stays
 * constant regardless of how long the session is.
 */
function extractToolCallSequence(messages, maxCalls = RECENT_TOOL_WINDOW) {
  const newestFirst = [];
  for (let i = messages.length - 1; i >= 0 && newestFirst.length < maxCalls; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant" || !Array.isArray(msg.tool_calls)) continue;
    for (let j = msg.tool_calls.length - 1; j >= 0 && newestFirst.length < maxCalls; j--) {
      newestFirst.push(toolCallHash(msg.tool_calls[j]));
    }
  }
  return newestFirst.reverse();
}

/**
 * Detect single tool call repeated >= SINGLE_REPEAT_THRESHOLD times.
 */
function detectSingleRepeat(seq) {
  const counts = new Map();
  for (const h of seq) {
    counts.set(h, (counts.get(h) || 0) + 1);
    if (counts.get(h) >= SINGLE_REPEAT_THRESHOLD) return h;
  }
  return null;
}

/**
 * Detect a sequence of N tool calls that repeats >= SEQUENCE_REPEAT_THRESHOLD times.
 * Uses sliding window to find N-gram repeats. Capped at MAX_SEQUENCE_LENGTH to
 * avoid polynomial explosion (a repeated longer cycle always repeats its first
 * MAX_SEQUENCE_LENGTH calls too, so real loops are still caught).
 * @param {string[]} seq - tool call hashes in order
 * @returns {string|null} the repeated pattern (hashes joined by "|") or null
 */
export function detectSequenceRepeat(seq) {
  const n = seq.length;
  const maxLen = Math.min(MAX_SEQUENCE_LENGTH, Math.floor(n / 2));
  // Try sequence lengths from largest to smallest (greedy)
  for (let len = maxLen; len >= MIN_SEQUENCE_LENGTH; len--) {
    for (let start = 0; start <= n - len * 2; start++) {
      const pattern = seq.slice(start, start + len).join("|");
      let count = 0;
      let pos = 0;
      while (pos <= n - len) {
        const window = seq.slice(pos, pos + len).join("|");
        if (window === pattern) {
          count++;
          pos += len;
        } else {
          pos++;
        }
      }
      if (count >= SEQUENCE_REPEAT_THRESHOLD) return pattern;
    }
  }
  return null;
}

/**
 * Extract plain-text content from a single message (handles string + content-array).
 */
function messageText(msg) {
  if (!msg) return "";
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((p) => p && typeof p.text === "string")
      .map((p) => p.text)
      .join(" ");
  }
  return "";
}

function hasNonTextContent(msg) {
  if (!Array.isArray(msg?.content)) return false;
  return msg.content.some((part) => !part || part.type !== "text");
}

/**
 * Normalize text for stable comparison: lowercase, collapse whitespace, strip
 * trailing punctuation. Keeps internal words so semantic repeats still match.
 */
function normalizeText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!?…]+$/g, "")
    .trim();
}

/**
 * Split text into sentence-ish chunks for finer-grained repeat detection.
 * Uses common sentence delimiters (incl. newlines for planning-style text).
 */
function splitSentences(text) {
  return String(text || "")
    .split(/[\n.!?…]+/)
    .map((s) => normalizeText(s))
    .filter((s) => s.length >= MIN_TEXT_LENGTH);
}

/**
 * Extract assistant message texts from the most recent history, in order.
 * Limited to RECENT_TEXT_WINDOW so we never scan thousands of old messages.
 */
function extractAssistantTexts(messages, maxCount = RECENT_TEXT_WINDOW) {
  const newestFirst = [];
  for (let i = messages.length - 1; i >= 0 && newestFirst.length < maxCount; i--) {
    const msg = messages[i];
    // Multimodal assistant turns and tool-call turns carry progress that cannot
    // be judged from their text alone. Leave them to the modality/tool guards.
    if (msg?.role !== "assistant" || msg.tool_calls || hasNonTextContent(msg)) continue;
    const t = messageText(msg);
    if (t.length >= MIN_TEXT_LENGTH) newestFirst.push(t);
  }
  return newestFirst.reverse();
}

/**
 * Detect text-only reasoning loops (no tool calls involved).
 * Catches two patterns:
 *  1. Same assistant message repeated >= TEXT_MESSAGE_REPEAT_THRESHOLD times
 *     (e.g. model emits "Subagent gagal. Saya cek langsung." 6× across turns)
 *  2. Same sentence appearing >= TEXT_SENTENCE_REPEAT_THRESHOLD times across
 *     all assistant messages (e.g. "I need to read the key files..." in 3+ msgs).
 *     Each message counts a sentence at most once, and texts larger than
 *     MAX_TEXT_SCAN_CHARS (code/diff dumps) are not sentence-split.
 * @param {object[]} messages
 * @returns {{ detected: boolean, hint: string|null }}
 */
function detectTextRepeat(messages) {
  const texts = extractAssistantTexts(messages);
  if (texts.length < TEXT_MESSAGE_REPEAT_THRESHOLD) return NO_LOOP;

  // 1. Exact message repeat (normalized)
  const msgCounts = new Map();
  for (const t of texts) {
    const norm = normalizeText(t);
    if (norm.length < MIN_TEXT_LENGTH) continue;
    const count = (msgCounts.get(norm) || 0) + 1;
    msgCounts.set(norm, count);
    if (count >= TEXT_MESSAGE_REPEAT_THRESHOLD) return { detected: true, hint: HINT_MESSAGE_REPEAT };
  }

  // 2. Sentence-level repeat across messages
  const sentenceCounts = new Map();
  for (const t of texts) {
    if (t.length > MAX_TEXT_SCAN_CHARS) continue;
    for (const s of new Set(splitSentences(t))) {
      const count = (sentenceCounts.get(s) || 0) + 1;
      sentenceCounts.set(s, count);
      if (count >= TEXT_SENTENCE_REPEAT_THRESHOLD) return { detected: true, hint: HINT_SENTENCE_REPEAT };
    }
  }

  return NO_LOOP;
}

function detectToolLoop(messages) {
  const seq = extractToolCallSequence(messages);
  if (seq.length < SINGLE_REPEAT_THRESHOLD) return NO_LOOP;
  if (detectSingleRepeat(seq)) return { detected: true, hint: HINT_SINGLE_REPEAT };
  if (detectSequenceRepeat(seq)) return { detected: true, hint: HINT_SEQUENCE_REPEAT };
  return NO_LOOP;
}

/**
 * Main loop detection function. Fail-open: never throws; if analysis itself
 * fails the request proceeds untouched and the failure is surfaced via `error`.
 * @param {object} body - the translated request body (must have messages array)
 * @returns {{ detected: boolean, hint: string|null, error?: string }}
 */
export function detectLoop(body) {
  try {
    const messages = body?.messages;
    if (!Array.isArray(messages) || messages.length === 0) return { ...NO_LOOP };

    const toolLoop = detectToolLoop(messages);
    if (toolLoop.detected) return toolLoop;

    // Text-only loop detection (symptom 1: model repeats planning/intent text
    // without making tool calls — the tool-call check misses this)
    const textLoop = detectTextRepeat(messages);
    return textLoop.detected ? textLoop : { ...NO_LOOP };
  } catch (err) {
    return { detected: false, hint: null, error: err?.message || String(err) };
  }
}
