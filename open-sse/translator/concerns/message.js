import { OPENAI_BLOCK } from "../schema/index.js";

// Collapse a text-only OpenAI content-part array to the wire's compact string
// form. Keep structured/annotated blocks as arrays so metadata (for example
// cache_control) is not silently discarded.
export function collapseTextParts(parts) {
  if (!Array.isArray(parts) || parts.length === 0) return parts;
  const textOnly = parts.every((part) =>
    part?.type === OPENAI_BLOCK.TEXT &&
    Object.keys(part).every((key) => key === "type" || key === "text"),
  );
  return textOnly ? parts.map((part) => part.text || "").join("\n") : parts;
}
