import { OPENAI_BLOCK } from "../schema/index.js";

// Collapse a text-only OpenAI content-part array to the wire's compact string
// form. Keep structured/annotated blocks as arrays so metadata (for example
// cache_control) is not silently discarded.
// ponytail: RcRouter keeps its stricter rule over upstream's `(parts, opts)` form: marked blocks are
// never flattened, so cache-aware targets keep them without needing the preserveCacheControl flag.
// `join: false` keeps part boundaries: only a lone text part collapses (upstream's
// rule), so converters whose source distinguishes parts (Gemini) stay lossless.
export function collapseTextParts(parts, { join = true } = {}) {
  if (!Array.isArray(parts) || parts.length === 0) return parts;
  if (!join && parts.length > 1) return parts;
  const textOnly = parts.every((part) =>
    part?.type === OPENAI_BLOCK.TEXT &&
    Object.keys(part).every((key) => key === "type" || key === "text"),
  );
  return textOnly ? parts.map((part) => part.text || "").join("\n") : parts;
}
