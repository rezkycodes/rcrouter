# Translator protocol compatibility

This matrix is the release-facing inventory for translator cases that are
still marked `it.fails`. A case stays here until the destination protocol can
carry the source value without silently changing its meaning. The fixture name
is the executable source of truth; do not remove an expected failure to make a
quality check look green.

## Current limitations

| Case | Source → target | Fixture | Status | Next action |
| --- | --- | --- | --- | --- |
| C-01 | OpenAI → Claude | `tests/translator/bugs-toClaude-context.test.js` — `input_audio` | Bounded loss | Claude Messages has no audio block. Add an audio-capable adapter or reject the request before translation with a typed unsupported-modality error. |
| C-02 | OpenAI → Kiro | `tests/translator/bugs-kiro.test.js` — remote image URL | Bounded loss | The direct fallback emits a privacy-safe diagnostic; use SSRF-safe prefetch when enabled and preserve inline image data before promoting this case. |
| C-03 | OpenAI → Cursor | `tests/translator/bugs-gemini-cursor-commandcode.test.js` — image content | Bounded loss | The text/protobuf adapter emits a privacy-safe diagnostic; preserve image bytes or a verified remote reference in the executor schema before promoting this case. |
| C-04 | OpenAI → CommandCode | `tests/translator/bugs-gemini-cursor-commandcode.test.js` — image content | Bounded loss | `/alpha/generate` currently exposes text/tool blocks only. Preserve the image through a verified upstream field before promoting this case. |
| C-05 | OpenAI Responses → OpenAI Chat | `tests/translator/bugs-codexCli-responses.test.js` — `input_image.file_id` | Bounded loss | The fallback emits a privacy-safe diagnostic; resolve file IDs through an authenticated file service before translation because a bare ID is not a valid `image_url`. |
| C-06 | Claude → OpenAI | `tests/translator/bugs-claudeCode-context.test.js` — `redacted_thinking` | Bounded loss | Emits a privacy-safe diagnostic; semantic preservation needs a target encrypted-reasoning continuity field. |

“Bounded loss” means the translator deliberately avoids inventing a wire
representation. The request remains valid, but the unsupported block is not
claimed to be semantically preserved. These cases must not log raw image data,
file IDs, or credential material.

## Resolved slices

The following high-frequency losses now have passing regression coverage:

- OpenAI `tool_choice: "none"` and `reasoning_content` → Claude thinking blocks.
- Claude base64/remote images and multimodal tool results → OpenAI blocks.
- Claude tool-result image blocks now have a passing multimodal regression.
- Multiple OpenAI system messages → one Gemini `systemInstruction`.
- Explicit Cursor `max_tokens`, Kiro `max_tokens`/`max_output_tokens`, and
  malformed CommandCode tool arguments.
- Nameless Responses function calls no longer emit an invalid
  `tool_calls: []` assistant message.
- Claude `redacted_thinking` blocks now produce an explicit privacy-safe
  diagnostic instead of being silently dropped or forwarding the opaque blob.
- Unsupported multimodal blocks now use explicit privacy-safe diagnostics where
  the destination has no compatible field; semantic-loss fixtures remain
  expected failures until a lossless schema or typed rejection exists.
- Kiro remote images use the existing SSRF-safe prefetch path when available;
  the direct fallback is an explicit marker that does not echo the URL.
- Cursor image blocks and Responses `file_id` references now emit explicit
  diagnostics rather than silently dropping data or creating invalid URLs.

Run the focused inventory with:

```sh
rg -n "it\\.fails|KNOWN BUG" tests/translator
```

The complete quality comparator (`pnpm check`) remains the release gate; the
expected-failure count is compared with `tests/__baseline__/current.json`.
