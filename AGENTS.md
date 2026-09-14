# RcRouter contributor instructions

RcRouter keeps the 9router request/response pipeline as its core and adopts
small, tested VansRouter reliability features. Read this file and `README.md`
before changing the project; when working in a nested project, read that
project's own `AGENTS.md` and `README.md` too.

## Quality gates

- Install from the lockfile with `pnpm install --frozen-lockfile`.
- Run `pnpm check` before a handoff. It compares lint/test output with the
  reviewed baseline in `tests/__baseline__/` and must not hide new failures.
- Run `pnpm run build` for changes that touch runtime, routing, providers, or
  deployment files.
- Focused Vitest runs use `pnpm test:focused <path>`.

## Routing invariants

- Keep public OpenAI-compatible request/response shapes unchanged.
- Treat `TargetDescriptor` and account IDs as internal-only; never log raw
  session identifiers, API keys, OAuth tokens, or image/file payloads.
- Context Relay affinity is tenant-scoped, bounded, and committed only after a
  successful upstream response. A failed account must be invalidated before
  fallback.
- Check provider/proxy breaker state before account work; acquire the account
  semaphore only after a candidate is selected; release it in `finally`.
- Connection-cache entries require explicit invalidation on mutation. Do not
  cache secrets beyond their required lifecycle.
- Do not turn unsupported protocol data into a guessed wire representation.
  Keep an explicit expected-failure fixture and document it in
  `docs/protocol-compatibility.md` until a lossless schema exists.

## Change discipline

- Prefer existing helpers and the smallest working diff (YAGNI).
- Use `apply_patch` for edits and preserve unrelated worktree changes.
- Keep 9router as read-only `upstream`; publish RcRouter changes to the
  project-owned `origin` remote with `gh` for issue tracking.
- Mark deliberate simplifications with a `ponytail:` comment.
