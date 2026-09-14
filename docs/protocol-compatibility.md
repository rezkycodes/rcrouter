# Translator protocol compatibility

This matrix is the release-facing inventory for translator cases that are
still marked `it.fails`. A case stays here until the destination protocol can
carry the source value without silently changing its meaning. The fixture name
is the executable source of truth; do not remove an expected failure to make a
quality check look green.

## Current limitations

| Case | Source → target | Fixture | Status | Next action |
| --- | --- | --- | --- | --- |
| C-01 | OpenAI → Claude | `tests/translator/bugs-toClaude-context.test.js` — `input_audio` | Resolved | Emits a privacy-safe diagnostic because Claude Messages has no audio block; raw audio bytes and URLs are never forwarded. |
| C-02 | OpenAI → Kiro | `tests/translator/bugs-kiro.test.js` — remote image URL | Bounded loss | Kiro accepts inline image payloads only in this route. Use the existing SSRF-safe prefetch path when enabled; otherwise keep the URL limitation explicit. |
| C-03 | OpenAI → Cursor | `tests/translator/bugs-gemini-cursor-commandcode.test.js` — image content | Bounded loss | Cursor’s current request adapter is text/protobuf-oriented. Add a fixture only after the executor schema accepts image bytes or a remote reference. |
| C-04 | OpenAI → CommandCode | `tests/translator/bugs-gemini-cursor-commandcode.test.js` — image content | Bounded loss | `/alpha/generate` currently exposes text/tool blocks only. Preserve the image through a verified upstream field before promoting this case. |
| C-05 | OpenAI Responses → OpenAI Chat | `tests/translator/bugs-codexCli-responses.test.js` — `input_image.file_id` | Bounded loss | Resolve file IDs through an authenticated file service before translation; a bare file ID is not a valid `image_url`. |
| C-06 | Claude → OpenAI | `tests/translator/bugs-claudeCode-context.test.js` — `redacted_thinking` | Resolved | Emits a privacy-safe diagnostic because OpenAI Chat has no encrypted-reasoning continuity field; the opaque payload is never forwarded. |

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
- OpenAI audio blocks now produce an explicit privacy-safe diagnostic on the
  Claude route instead of being silently dropped or forwarding raw payloads.

Run the focused inventory with:

```sh
rg -n "it\\.fails|KNOWN BUG" tests/translator
```

The complete quality comparator (`pnpm check`) remains the release gate; the
expected-failure count is compared with `tests/__baseline__/current.json`.
