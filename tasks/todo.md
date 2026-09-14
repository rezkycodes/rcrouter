# RcRouter Execution Checklist

Follow this order. A checkbox is complete only when its verification evidence is attached to the pull request or release note.

## Foundation

- [x] Choose and normalize the default port across scripts, runtime, containers, and README.
- [x] Add standard test/check/build scripts using existing project tooling.
- [x] Reproduce and classify the stored failing baseline (17 suites / 26 tests) in a clean dependency environment.
- [x] Add PR CI quality gates before publication workflows.
- [x] Obtain a project-owned RcRouter remote URL; then set it as `origin` and retain 9router as read-only `upstream`.

## Context Relay correctness

- [x] Approve the tenant-scoped opaque affinity-key and log-redaction design.
- [x] Implement bounded TTL/LRU affinity storage with deterministic cleanup.
- [x] Replace model-only relay records with internal account-aware `TargetDescriptor` values (`713c3edf`).
- [x] Thread `connectionId` to credential selection through the existing preferred-connection path.
- [x] Commit affinity only after upstream success; invalidate and reselect on account-specific failure.
- [x] Add tests for tenant isolation, two-account stickiness, expiry, eviction, 429, timeout, disabled account, and recovery.

## Reliability and auto-routing

- [x] Add safely invalidated connection caching and measure repository-read reduction.
- [x] Add account semaphore capacity, cancellation-safe slot release, and queue metrics.
- [x] Verify lock ordering with the existing provider mutex and breaker (4 static ordering regressions; breaker → selection → semaphore → release).
- [x] Implement a validated Auto Combo candidate resolver.
- [x] Replace `auto/fallback` with a typed no-eligible-target outcome.
- [x] Cover ACL, quota, breaker, and capacity eligibility in table-driven tests.

## Compatibility and security

- [x] Publish the translator compatibility matrix from current expected failures (`docs/protocol-compatibility.md`).
- [ ] Repair protocol cases in focused vertical slices and promote each to a passing regression test. (Common-path and executor slices landed; six bounded-loss cases remain explicitly tracked.)
- [x] Add executor-level tests for binary/protobuf/NDJSON paths (Cursor AgentService 35/35, CommandCode NDJSON 7/7, Kiro EventStream 70/70).
- [ ] Threat-model credential storage and approve key management before any encryption migration (threat model documented; master-key lifecycle approval still pending).
- [x] Validate proxy outbound destinations and add ACL/error-redaction regressions (connection proxy + request logger header redaction + Auto Combo ACL + request-details/security suites).
- [x] Make LoopGuard behavior explicit and test valid tool/multimodal traffic (configurable setting; 8 focused regressions).

## Release readiness

- [x] Add metrics, dashboard queries, and privacy-safe correlation identifiers (bounded in-memory counters/gauges/histograms, protected `/api/metrics`, redacted semaphore keys, and `x-rc-correlation-id`; focused observability tests).
- [x] Write operator runbooks for breaker, quota, account, cache, and affinity incidents (`docs/operations-runbook.md`).
- [ ] Update README claims only after benchmark/test evidence exists.
- [x] Add root `AGENTS.md` with pipeline, test, and invariants once conventions are stable.
- [ ] Run full suite, build, container smoke test, migration/rollback drill, and staged release. (Baseline comparator, production build, and isolated migration drill pass; container smoke runs in CI because Docker is unavailable locally, and staged rollout remains an operator action.)
