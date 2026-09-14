# RcRouter operations runbook

This runbook describes the behavior that is shipped today. It intentionally
does not include credentials, client prompts, session IDs, or provider payloads.

## First response checklist

1. Confirm liveness with `GET /api/health` (`{"ok":true}` only means the
   process is serving requests).
2. Capture the UTC timestamp, provider/model, HTTP status, and the opaque
   request tag from the server log. Never copy an API key, cookie, session ID,
   prompt, or image into an incident ticket.
3. Reproduce with a focused test before changing account or routing state:
   `pnpm test:focused tests/unit/<relevant-test>.test.js`.

## Circuit breaker open

Symptoms include `circuit breaker OPEN` or a 503 with a retry-after value.
RcRouter records provider failures per `provider:proxy bucket`; HTTP 429 is
handled as account quota and does not count as a provider-wide failure.

- Wait for the reported cooldown and retry once.
- If only one proxy bucket is failing, keep accounts on other buckets in the
  rotation; do not disable the whole provider.
- A process restart clears the in-memory breaker registry. Restart only after
  capturing the failure status and upstream error class; the restart does not
  change persisted connection credentials.
- If the breaker reopens, preserve the opaque request tag and open a ticket
  with provider, proxy bucket classification, status, and cooldown only.

## Account quota or disabled account

An account-level failure is persisted as a model lock/rate-limit state and is
excluded from subsequent selection until its reset time. A successful request
clears the account error and provider strike state.

- Check the provider's connection status and quota view in the dashboard.
- Re-enable a deliberately disabled connection only after validating its
  credentials; activation clears stale health locks by design.
- For 409/429 responses, use the recorded reset time instead of manually
  guessing a cooldown. Do not copy the upstream response body into logs.

## Account capacity / semaphore queue

Each account/proxy bucket has a process-local FIFO semaphore. The default
capacity is 3 concurrent requests; a connection can set a positive
`providerSpecificData.maxConcurrency`. Set it to `0` or `null` only when the
upstream has its own safe limiter. Queued work times out after 30 seconds and
the default queue limit is 20.

- `account capacity reached` means another eligible account may be tried.
- A client disconnect returns 499 and releases the slot in `finally`.
- After a quota cooldown, already queued work is blocked until the reset
  window expires; this prevents an immediate 429 stampede.
- Capacity is process-local. Multi-process deployments need an external
  coordinator if the limit must apply across workers.

## Connection cache

Provider connection reads use a 2-second in-process cache. Connection mutation
paths explicitly invalidate it. A restart naturally clears the cache.

- After adding, deleting, enabling, or editing a connection, wait for the
  mutation response before retrying a request.
- If a stale connection appears for more than two seconds, record the
  provider and operation and inspect the mutation path; do not edit the DB by
  hand while the server is running.

## Context Relay affinity

The `context-relay` combo strategy stores a tenant-scoped opaque binding for
30 minutes, bounded to 10,000 entries. It commits only after a successful
upstream response and invalidates the affected account on fallback. Restarting
RcRouter clears the in-memory map; persistence across restarts is intentionally
not promised.

- Keep the client's session header/body value stable across turns.
- A failed first request does not poison the session.
- A 429, timeout, breaker-open, disabled account, or stale target causes a
  re-selection; the replacement is bound only after it succeeds.
- Never use a raw session value as an incident identifier. Use the short
  correlation digest printed by the router.

## Diagnostics and privacy

Request-file logging is opt-in (`ENABLE_REQUEST_LOGS=true`). Diagnostic logger
headers, credential-bearing URLs, session identifiers, API keys, cookies, and
image/audio/file blocks are redacted before writing. Request text can still be
sensitive; disable request logging when a payload-level trace is unnecessary.
The dashboard request-details API returns metadata with conversation payloads
redacted.

## Metrics and correlation

Dashboard operators can query `GET /api/metrics` with the normal dashboard
cookie or machine-bound CLI token. The response includes bounded counters and
latency summaries for usage writes, pending requests, connection-cache hits,
semaphore outcomes, circuit-breaker transitions, and Context Relay affinity,
plus the current breaker/semaphore state. Semaphore keys are one-way digests;
prompts, credentials, API keys, and raw session values are never metric labels.

Every chat response carries an `x-rc-correlation-id` such as `rc_<random>`.
The identifier is generated per request and is safe to include in an incident
ticket; it is not derived from an API key or client session value.

## Release / rollback

Run the quality gate and production build before a staged restart:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm run build
pnpm run release:migration-drill
pnpm run release:container-smoke
# after deploying a pinned image to staging:
RCROUTER_BASE_URL=https://staging.example pnpm run release:staged-check
```

`release:migration-drill` creates an isolated SQLite database, forces a pending
schema backup, restores that copy, and verifies the critical settings row after
restart. It never reads the operator's configured `DATA_DIR`.

`release:container-smoke` builds the Dockerfile, starts the image with an
ephemeral `/app/data` mount, and polls `GET /api/health`. On a developer
machine without a Docker daemon it reports `SKIP`; CI sets `CI=true`, where a
missing daemon or a failed health check is a release failure. The publish
workflow runs this job before an image can be pushed.

The build script creates a pre-build SQLite backup under
`~/.rcrouter/db/backups/`. Keep the backup for the release window. To roll back
application code, deploy the previous verified commit; restore the database
backup only if a migration was part of that release. The current LoopGuard,
connection cache, semaphore, breaker, and Context Relay state are in-memory and
will reset on restart.

The canonical release image is published to GHCR as
`ghcr.io/rezkycodes/rcrouter`; `docker-compose.yml` can build it locally and
keeps the historical `9router-data` volume name so existing SQLite data is not
orphaned during the rename.

`release:staged-check` observes `/api/health` for a bounded release window
(60 seconds by default), optionally verifies `RCROUTER_EXPECTED_VERSION`, and
can probe an authenticated metrics URL with `RCROUTER_METRICS_URL`. It fails
on any non-200 response, invalid JSON, or unhealthy payload. Use a pinned
image digest for the deployment and record the probe output with the release
ticket before widening traffic.

## Known release blockers

- Six translator limitations remain intentionally fail-closed cases in
  [the compatibility matrix](protocol-compatibility.md); unsupported payloads
  return HTTP 422 with a privacy-safe capability code before upstream dispatch.
- Credential encryption/key rotation remains pending an approved operational
  master-key lifecycle.
- Container smoke and migration/rollback drills run in CI before publication.
  A staged restart still requires an operator to deploy the pinned image
  digest, verify `/api/health`, and observe error/latency metrics for one
  release window before widening traffic.
