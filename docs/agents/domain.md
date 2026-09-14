# Domain Docs

RcRouter uses a multi-context documentation layout.

Before exploring, read `CONTEXT-MAP.md` when it exists, then the relevant
context document and ADRs. Contexts are the gateway/dashboard (`src/`),
routing and translation engine (`open-sse/`), CLI (`cli/`), tests (`tests/`),
and documentation site (`gitbook/`).

Read system-wide ADRs in `docs/adr/`; also read ADRs local to the context being
changed. If context documents or ADRs do not yet exist, proceed silently.
Create them only when a domain term or architectural decision is actually
settled.

Use the glossary vocabulary defined by the relevant `CONTEXT.md`. Surface any
conflict with an existing ADR instead of silently overriding it.
