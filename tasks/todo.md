# RcRouter Execution Checklist

Follow this order. A checkbox is complete only when its verification evidence is attached to the pull request or release note.

## Foundation

- [ ] Choose and normalize the default port across scripts, runtime, containers, and README.
- [ ] Add standard test/check/build scripts using existing project tooling.
- [ ] Reproduce and classify the stored failing baseline (17 suites / 26 tests) in a clean dependency environment.
- [ ] Add PR CI quality gates before publication workflows.
- [ ] Obtain a project-owned RcRouter remote URL; then set it as `origin` and retain 9router as read-only `upstream`.

## Context Relay correctness

- [ ] Approve the tenant-scoped opaque affinity-key and log-redaction design.
- [ ] Implement bounded TTL/LRU affinity storage with deterministic cleanup.
- [ ] Replace model-only relay records with internal account-aware `TargetDescriptor` values.
- [ ] Thread `connectionId` to credential selection through the existing preferred-connection path.
- [ ] Commit affinity only after upstream success; invalidate and reselect on account-specific failure.
- [ ] Add tests for tenant isolation, two-account stickiness, expiry, eviction, 429, timeout, disabled account, and recovery.

## Reliability and auto-routing

- [ ] Add safely invalidated connection caching and measure repository-read reduction.
- [ ] Add account semaphore capacity, cancellation-safe slot release, and queue metrics.
- [ ] Verify lock ordering with the existing provider mutex and breaker.
- [ ] Implement a validated Auto Combo candidate resolver.
- [ ] Replace `auto/fallback` with a typed no-eligible-target outcome.
- [ ] Cover ACL, quota, breaker, and capacity eligibility in table-driven tests.

## Compatibility and security

- [ ] Publish the translator compatibility matrix from current expected failures.
- [ ] Repair protocol cases in focused vertical slices and promote each to a passing regression test.
- [ ] Add executor-level tests for binary/protobuf/NDJSON paths.
- [ ] Threat-model credential storage and approve key management before any encryption migration.
- [ ] Validate proxy outbound destinations and add ACL/error-redaction regressions.
- [ ] Make LoopGuard behavior explicit and test valid tool/multimodal traffic.

## Release readiness

- [ ] Add metrics, dashboard queries, and privacy-safe correlation identifiers.
- [ ] Write operator runbooks for breaker, quota, account, cache, and affinity incidents.
- [ ] Update README claims only after benchmark/test evidence exists.
- [ ] Add root `AGENTS.md` with pipeline, test, and invariants once conventions are stable.
- [ ] Run full suite, build, container smoke test, migration/rollback drill, and staged release.
