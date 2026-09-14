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
test files, 2,410 assertions, and 101 failures. These are debt, not successes:
new failures still fail `pnpm test`.

`lint-current.json` is the equivalent reviewed ESLint snapshot: 137 errors and
202 warnings. `pnpm lint` blocks new errors, while `pnpm lint:raw` shows every
existing error and warning.

| Failure set | Count | Classification | Follow-up |
| --- | ---: | --- | --- |
| Cursor AgentService codec helpers | 35 | Implementation gap: expected exported codec helpers are absent | Protocol-fidelity workstream |
| Kiro thinking/direct translation | 28 | Implementation gap: Kiro request contract and direct-route expectations diverge | Protocol-fidelity workstream |
| Claude/OpenAI request and response preservation | 8 | Implementation gap: reasoning, normalization, helper, and golden-payload assertions diverge | Protocol-fidelity workstream |
| Cursor OAuth auto-import | 8 | Implementation gap: platform-specific token discovery contract diverges | OAuth maintenance workstream |
| DB concurrency | 3 | Environment-sensitive: SQLite driver/concurrency semantics differ from the assertion | Database reliability workstream |
| Windsurf executor | 3 | Upstream endpoint/configuration contract changed | Provider maintenance workstream |
| Mock/fixture contract drift (Codex image, force-stream, Kiro terminal, request details) | 8 | Test harness or fixture no longer matches current implementation | Test maintenance workstream |
| Other single-path provider, combo, network, or translator cases | 8 | Implementation or external-service contract gap; includes the live MiMo check | Classify/fix in its owning workstream before release |

Review every `current.json` diff. Do not refresh it merely to silence a new
failure; link the change to the ticket that explains why the behavior is now
accepted or why the test is incorrect.
