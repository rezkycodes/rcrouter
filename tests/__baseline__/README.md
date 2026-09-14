# RcRouter test baseline

`current.json` is the reviewed result from the complete offline Vitest suite.
It is the source of truth for the regression gate: a test that was passing in
this snapshot must not fail in a later run. A baseline failure becoming green
is allowed and reported as a resolved failure.

Run the normal gate with `pnpm test`. It writes the Vitest JSON report to a
temporary directory, checks it against this snapshot, then removes the report.
Use `pnpm test:raw` to see the unfiltered result, or
`pnpm test:focused tests/unit/example.test.js` for one file.

## Reviewed baseline

The snapshot was captured with Node 24.17.0 and Vitest 4.1.11. It contains 252
test files, 2,410 assertions, and 101 failures. Those historical failures are
now resolved by the current offline suite (0 failed suites/tests); the snapshot
is retained as a regression floor and `pnpm test` reports the resolutions.

`lint-current.json` is the equivalent reviewed ESLint snapshot: 137 errors and
202 warnings. `pnpm lint` blocks new errors, while `pnpm lint:raw` shows every
existing error and warning.

| Historical failure set | Count | Resolution |
| --- | ---: | --- |
| Cursor AgentService codec helpers | 35 | Resolved; live/unsupported protocol fixtures remain explicitly gated |
| Kiro thinking/direct translation | 28 | Resolved with protocol-safe payloads |
| Claude/OpenAI request and response preservation | 8 | Resolved |
| Cursor OAuth auto-import | 8 | Resolved with platform-aware probing and fallback |
| DB concurrency | 3 | Resolved with explicit timestamp idempotency and atomic writes |
| Windsurf executor | 3 | Resolved; provider remains hidden until ToolCallChunk support |
| Mock/fixture contract drift | 8 | Resolved |
| Other provider/combo/network cases | 8 | Resolved or explicitly gated when external credentials are required |

Review every `current.json` diff. Do not refresh it merely to silence a new
failure; link the change to the ticket that explains why the behavior is now
accepted or why the test is incorrect.
