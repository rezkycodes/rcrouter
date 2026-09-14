# Translator protocol compatibility

This matrix is the release-facing inventory for translator cases that are
still marked `it.fails`. Production chat routing now fails closed with HTTP
422 and a machine-readable capability code before an unsupported payload can
reach an upstream provider. A case stays here until the destination protocol
can carry the source value without changing its meaning. The fixture name is
the executable source of truth; do not remove an expected failure to make a
quality check look green.

## Current limitations

| Case | Source → target | Fixture | Status | Next action |
| --- | --- | --- | --- | --- |
| C-01 | OpenAI → Claude | `tests/translator/bugs-toClaude-context.test.js` — `input_audio` | Fail-closed (422) | Runtime code `audio_input_unsupported`; add an audio-capable adapter before promoting the semantic fixture. |
| C-02 | OpenAI → Kiro | `tests/translator/bugs-kiro.test.js` — remote image URL | Fail-closed (422 after prefetch) | Runtime code `remote_image_unresolved`; preserve inline image data through the SSRF-safe prefetch path before promoting the semantic fixture. |
| C-03 | OpenAI → Cursor | `tests/translator/bugs-gemini-cursor-commandcode.test.js` — image content | Fail-closed (422) | Runtime code `image_input_unsupported`; preserve image bytes or a verified remote reference in the executor schema before promoting the semantic fixture. |
| C-04 | OpenAI → CommandCode | `tests/translator/bugs-gemini-cursor-commandcode.test.js` — image content | Fail-closed (422) | Runtime code `image_input_unsupported`; `/alpha/generate` needs a verified image field before promoting the semantic fixture. |
| C-05 | OpenAI Responses → OpenAI Chat | `tests/translator/bugs-codexCli-responses.test.js` — `input_image.file_id` | Fail-closed (422) | Runtime code `file_reference_unresolved`; resolve file IDs through an authenticated file service before promoting the semantic fixture. |
| C-06 | Claude → OpenAI | `tests/translator/bugs-claudeCode-context.test.js` — `redacted_thinking` | Fail-closed (422) | Runtime code `encrypted_thinking_unsupported`; semantic preservation needs a target encrypted-reasoning continuity field. |

“Fail-closed” means the router deliberately refuses to invent a wire
representation. The request is rejected before account health is changed or
an upstream call is attempted. These cases must not log raw image data, audio
bytes, file identifiers, encrypted thinking, or credential material.

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
- Unsupported multimodal blocks now use explicit privacy-safe diagnostics in
  direct translator tests and typed HTTP 422 rejection in production routing;
  semantic-loss fixtures remain expected failures until a lossless schema exists.
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
