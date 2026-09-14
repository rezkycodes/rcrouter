# RcRouter Completion Plan

## Goal and boundaries

Build RcRouter as a durable RouterProxy distribution: retain the current 9router-compatible core, selectively adopt proven VansRouter operational features, and avoid importing OmniRoute as a second platform. The immediate priority is correctness of account/session routing; new providers and broad auto-routing come after that foundation is reliable.

This plan started from the RcRouter fork at `c9bdec38`, whose merge-base was the local 9router core (`17c4cc76`). It is now a live implementation tracker; completed items below refer to commits on the project-owned `main` branch.

## Latest implementation status

- Foundation, project-owned GitHub publication, Context Relay account affinity, connection caching, and account semaphore are implemented and covered by the quality gate.
- Auto Combo now filters caller-supplied ACL/health/quota state and returns a typed no-candidate result instead of `auto/fallback` (`5a0eee86`).
- The first protocol-fidelity slice is complete (`08c5211f`); the full translator backlog still contains seven explicit expected failures.
- Verification on 2026-09-14: `pnpm check` passed against the reviewed baseline (98 current failures vs 101 baseline, 3 resolved), and `pnpm run build` completed successfully.

## Verified starting point

| Area | Already present in RcRouter | Remaining gap |
| --- | --- | --- |
| Core | Current 9router ancestry; OpenAI-compatible proxy pipeline | Upstream synchronization policy and project-owned Git remote are not defined |
| Access control | Provider, combo, and model ACL checks | Need regression coverage for every route and bypass boundary |
| Resilience | Circuit breaker keyed by provider and proxy; 429 is not counted as provider failure; per-provider selection mutex | No account concurrency semaphore; connection data is fetched per selection instead of through a safely invalidated cache |
| Settings | 5-second in-process cache with invalidation on internal update | No documented cross-process consistency strategy |
| Context Relay | Six strategy labels and a 30-minute in-memory target map | The entry records only a model target, not the selected connection/account; it can key from `body.user`, logs raw session material, has no size bound, and can re-anchor before upstream success |
| Auto Combo | Manual combo definitions and four heuristic variants | Candidates lack a central capability, health, quota, ACL, and cost-aware resolver; fallback can produce a non-routable placeholder |
| Protocol support | Broad translator suite and direct routing structure | Stored baseline reports 17 failed suites / 26 failed tests; known `it.fails` cases remain in translator fixtures |
| Delivery | Docker and GitBook publishing workflows | No standard `test`, lint/type-check command, or test/build quality gate in CI |

The production entrypoint `server.js` exists. The actual issue is inconsistent default ports: package development/start commands use `20127`, while README/`server.js` default to `20128`.

## Target architecture

```text
Client request
  -> authentication + ACL
  -> Auto/Combo candidate resolver
  -> Affinity lookup (tenant + combo + opaque session key)
  -> account-aware target descriptor
  -> provider/account selection (cache, semaphore, breaker, quota)
  -> protocol translator + upstream request
  -> success commits/reinforces affinity; failure invalidates/re-ranks it
```

`TargetDescriptor` is the essential contract: `{ model, provider, connectionId, proxyBucket, selectedAt }`. A model string alone is not affinity. The descriptor must be propagated to credential selection, which already has a `preferredConnectionId` input, without exposing account identifiers to clients or logs.

## Ordered implementation tasks

### 1. Establish project identity and a reproducible quality baseline

**Work**

- Decide one documented default port (recommend `20128`) and make README, package scripts, Docker/Compose examples, and `server.js` agree.
- Add `test`, focused-test, lint/check, and build scripts using existing dependencies where possible; do not add tooling before checking whether the existing Vitest/ESLint setup covers it.
- Add a pull-request CI quality workflow that installs from the lockfile, runs the selected checks, and records the test outcome.
- Change Git remote ownership only after a project-owned RcRouter repository URL is supplied. Keep 9router as an explicit read-only upstream remote.

**Acceptance criteria**

- A clean clone has one documented development and production startup command/port contract.
- CI fails on a failing test/check/build and does not publish images from an unverified revision.
- The existing failing baseline is reproduced and categorized before any expected-failure markers are removed or added.

**Verification**: run scripts locally in a lockfile-based environment; inspect CI on a branch/PR; compare result to `tests/__baseline__/current.json`.

**Likely files**: `package.json`, `README.md`, `server.js`, `.github/workflows/quality.yml`, `tests/vitest.config.js`.

**Dependencies**: none.

### 2. Define the affinity privacy and lifecycle contract

**Work**

- Specify an opaque affinity key from tenant/API-key scope, combo name, and a client session identifier. Do not use a raw `body.user` value by itself as a global session key.
- Replace raw session IDs in logs with a short non-reversible correlation digest.
- Define TTL, maximum entries, per-tenant limits, eviction policy, and the restart behavior. Begin with bounded in-memory state; persistence is a later decision, not an implicit promise.
- Define state transitions: `unbound -> candidate -> bound only after upstream success -> invalidated on account/provider failure -> reselected`.

**Acceptance criteria**

- Two tenants with the same client session value cannot share affinity.
- Logs and metrics never contain raw user/session/key values.
- The store has deterministic expiry and bounded memory under adversarial unique-session traffic.

**Verification**: unit tests for key isolation, expiry, LRU/limit eviction, and log redaction; load test using unique sessions.

**Likely files**: `open-sse/services/combo.js`, new small affinity-store module, focused unit tests.

**Dependencies**: task 1 test command.

### 3. Carry account-aware targets through Combo and credential selection

**Work**

- Refactor Combo ordering/callbacks from a `model` string to an internal `TargetDescriptor`.
- Thread `connectionId` into `handleSingleModelChat` and then the existing `getProviderCredentials(..., { preferredConnectionId })` path.
- Keep public OpenAI-compatible request/response shapes unchanged; descriptors are internal-only.
- Ensure stale/missing connections degrade safely to ordinary candidate selection rather than producing an invalid target.

**Acceptance criteria**

- A successful Context Relay session reuses the same eligible account/connection, not merely the same provider/model.
- A selected account is never used when it is disabled, unauthorized, unhealthy, or no longer matches the requested model.
- Non-combo and non-Context-Relay behavior remains unchanged.

**Verification**: tests with two accounts for one provider/model, disabled-account fallback, and a normal direct-model regression suite.

**Likely files**: `open-sse/services/combo.js`, `src/sse/handlers/chat.js`, `src/sse/services/auth.js`, focused combo/auth tests.

**Dependencies**: task 2.

### 4. Commit affinity only on success and re-anchor deliberately

**Work**

- Keep a candidate separate from a committed binding until the upstream response is successful.
- On timeout, breaker-open state, invalid credentials, quota/account lock, or recoverable upstream failure, invalidate only the affected binding and attempt the next eligible target.
- Preserve the distinction already used by the breaker: rate-limit 429 is not evidence that an entire provider is down, but it can make one account temporarily ineligible.
- Add counters for affinity hit, miss, invalidation reason, failover, and stickiness success without high-cardinality user identifiers.

**Acceptance criteria**

- Failed first requests do not poison later session routing.
- An account-level failure re-anchors to another eligible account while unrelated sessions remain intact.
- Provider/proxy breaker state and account eligibility are not conflated.

**Verification**: deterministic mocked upstream tests for success, 429, timeout, invalid credential, breaker-open, and recovery; inspect metric labels for privacy/cardinality.

**Likely files**: `open-sse/services/combo.js`, `src/sse/handlers/chat.js`, breaker/metrics helpers, focused tests.

**Dependencies**: task 3.

### 5. Port the small, proven VansRouter reliability pieces

**Work**

- Add a connection cache with explicit invalidation on connection mutation and short, documented freshness; do not cache secrets beyond their required lifecycle.
- Add an account-level semaphore/queue so one hot account cannot exceed its safe concurrency; make capacity configurable and observable.
- Retain existing per-provider mutex and per-provider/proxy breaker rather than replacing them. Validate their lock order to prevent deadlock and head-of-line blocking.
- If multi-process deployment is supported, decide whether settings/connection revision checks or a shared invalidation channel is needed; otherwise state the single-process limitation in docs.

**Acceptance criteria**

- Repeated credential selection avoids unnecessary repository reads without selecting deleted/disabled credentials.
- Concurrent requests respect an account capacity and recover slots on success, error, abort, and timeout.
- Cache invalidation and semaphore release are covered on every connection mutation/failure path.

**Verification**: repository-call-count tests, concurrency tests with aborts, mutation/invalidation tests, and a short latency/throughput comparison against the baseline.

**Likely files**: `src/sse/services/auth.js`, connection repository/service, a cache/semaphore helper, connection mutation handlers, unit tests.

**Dependencies**: task 1. Task 3 should land first if the semaphore is attached to affinity-selected accounts.

### 6. Replace heuristic Auto Combo targets with a validated candidate resolver

**Work**

- Create one internal resolver that returns only routable descriptors after ACL, enabled-connection, model capability, circuit-breaker, quota/reset, and account-capacity checks.
- Treat current `coding`, `fast`, `cheap`, and `reasoning` variants as policies over validated candidates, not string-pattern guesses.
- Remove or replace the non-routable `auto/fallback` placeholder with an explicit no-eligible-target result and client-safe error.
- Add scoring in stages: hard eligibility first, then health/availability, then configured preference/cost/latency. Avoid importing OmniRoute’s broad strategy matrix before metrics demonstrate a need.

**Acceptance criteria**

- Resolver output is always executable by the downstream request path or is a typed no-candidate result.
- ACL and disabled credentials cannot be bypassed through `auto`, `combo`, or custom variants.
- The selected reason is explainable via bounded diagnostic fields, not raw credential details.

**Verification**: table-driven eligibility tests; property test/no-invalid-target invariant; API tests for no eligible candidate.

**Likely files**: `open-sse/services/autoCombo.js`, `open-sse/services/combo.js`, model/provider metadata helper, combo tests.

**Dependencies**: tasks 3–5.

### 7. Turn translator expected failures into a protocol-fidelity backlog

**Work**

- First turn each current `it.fails` category into a named compatibility case with source protocol, destination protocol, fixture, expected behavior, and owner/status.
- Repair in vertical slices, prioritizing request safety and common paths: Claude/OpenAI tool choice and tool-result errors; multimodal/remote-image handling; reasoning/redacted-thinking preservation; Gemini/Cursor/Kiro system, token, and binary/protobuf-specific paths.
- Keep direct translators for fragile pairs rather than forcing all payloads through a lossy pivot. Executor-level tests remain required for Kiro binary, Cursor protobuf, and CommandCode NDJSON.

**Acceptance criteria**

- Each resolved compatibility case changes from explicit expected failure to a passing regression test with an interoperable fixture.
- No compatibility claim is made for protocol pairs without request and streaming-response coverage.
- Test failures are categorized as product defect, intentionally unsupported, or environment-dependent; none remain anonymous.

**Verification**: focused translator/executor tests followed by the complete suite; manual replay against non-production test credentials only where an emulator cannot validate wire behavior.

**Likely files**: `tests/translator/*`, `src/translator/*`, protocol-specific adapters, compatibility matrix document.

**Dependencies**: task 1.

### 8. Harden storage, proxy boundaries, and authorization regressions

**Work**

- Threat-model connection fields and confirm whether credentials are encrypted at rest; introduce versioned encryption/key rotation and a migration only if plaintext storage is confirmed and a master-key operational model is approved.
- Validate proxy endpoints and outbound network policy to limit SSRF-style destinations; retain the existing trusted-peer header stripping model.
- Add route-level ACL regression tests, error redaction tests, and audit logging with stable opaque identifiers.
- Make LoopGuard behavior explicit/configurable and test that it does not silently corrupt valid user/tool traffic.

**Acceptance criteria**

- Secrets are absent from logs, API responses, fixtures, and diagnostics.
- A malformed or unauthorized provider/combo/model/proxy request is rejected before upstream contact.
- Any encryption migration is reversible, versioned, and tested against existing connections.

**Verification**: security-focused unit/integration tests, fixture secret scan, malformed proxy tests, and migration dry run on a copy of a development database.

**Likely files**: connection repository/API, proxy validation helpers, `custom-server.js`, ACL tests, security documentation.

**Dependencies**: task 1; encryption work requires an explicit key-management decision.

### 9. Make operations observable and documentation truthful

**Work**

- Document the single source of truth for configuration, ports, `~/.rcrouter` migration, breakers, cache freshness, account capacity, and affinity restart semantics.
- Add structured operational metrics/dashboards for routing decision, queue depth, cache behavior, breaker status, affinity lifecycle, translator compatibility, and failure class.
- Add runbooks for disabled accounts, quota reset, breaker recovery, leaked semaphore slot investigation, upstream sync, and rollback.
- Add a concise root `AGENTS.md` after the implementation conventions stabilize, so contributors can locate pipeline, tests, and invariants without relying on README prose.

**Acceptance criteria**

- README makes no performance/affinity claim that cannot be demonstrated by tests or a benchmark.
- An operator can diagnose a failed request class without exposing client prompts, session IDs, or secrets.
- A rollback path exists for each stateful migration.

**Verification**: documentation walkthrough from clean install; synthetic incident drill; dashboard/query review for sensitive labels.

**Likely files**: `README.md`, `docs/*`, `AGENTS.md`, metrics helpers, deployment manifests.

**Dependencies**: tasks 2–8, staged as their behavior lands.

## Delivery checkpoints

1. **Green foundation** — task 1 complete; failing baseline is owned and CI gates quality.
2. **Correct stickiness** — tasks 2–4 complete; same-session, same-account behavior is proven and failover is safe.
3. **Predictable capacity** — task 5 complete; cache/semaphore behavior is measured under concurrency.
4. **Safe automatic routing** — task 6 complete; no invalid auto candidates and no ACL bypass.
5. **Release candidate** — tasks 7–9 complete for the chosen supported protocol set; docs/runbooks match observed behavior.

## Explicit non-goals for the first release

- Do not merge OmniRoute wholesale or make every one of its routing strategies configurable.
- Do not promise persistent session affinity across restarts until a storage, privacy, and cleanup design is implemented.
- Do not add a provider merely because it appears in a comparison fork; add it only with credentials, capability metadata, tests, and an operational owner.
- Do not remove expected-failure tests to make the baseline look green.
