# Credential storage threat model

Status: reviewed 2026-09-14. Encryption migration is intentionally deferred;
the key-management decision below must be approved before changing the stored
schema.

## Scope and assets

RcRouter stores provider connections in the SQLite `providerConnections.data`
JSON column. Depending on the provider, this contains `apiKey`, `accessToken`,
`refreshToken`, `idToken`, OAuth metadata, and provider-specific credentials.
The same values can therefore exist in:

- the live SQLite database under `${DATA_DIR}/db/data.sqlite`;
- pre-migration and legacy backups;
- an explicitly requested database export JSON;
- process memory while selecting or refreshing an account.

API keys used by clients are also retained internally in usage history so that
usage can be grouped, but external usage responses expose only masked values.

## Threats and current controls

| Asset / path | Threat | Current control | Residual risk |
| --- | --- | --- | --- |
| Provider tokens in SQLite | A local filesystem reader obtains a bearer token | Data directory is operator-controlled; machine/CLI secrets use mode `0600`; no token is returned by provider GET APIs | Connection data remains plaintext at rest; host permissions and disk encryption are the boundary |
| Database export/import | An attacker downloads or uploads a portable credential bundle | Export requires a valid machine-bound CLI token or password re-auth; import uses the same gate | A valid operator can intentionally export plaintext; exports must be treated as secrets and deleted securely |
| Request diagnostics | Headers, session identifiers, credential-bearing URLs, and media leak to local logs | Request logger masks sensitive headers and recursively redacts credential/session fields and media blocks | Streaming text files and unrelated provider logs may still contain provider-generated sensitive text; keep request logging opt-in |
| API responses | Dashboard/API exposes provider secrets | Provider list/detail routes delete API/OAuth token fields; usage masks API keys; request-detail API redacts payload fields | New routes must use the same allowlist approach; do not spread connection objects directly |
| Process memory | Runtime compromise reads active credentials | Credentials are only loaded for the selected account and cache entries are short-lived | No application-level defense against a compromised host/process |

## Key-management decision

RcRouter does **not** perform application-level encryption yet. Before an
encryption migration is approved, operators must choose and document all of:

1. a master-key source (environment/secret manager, never a value stored in
   the same SQLite file);
2. key versioning and rotation, including how old rows are re-encrypted;
3. startup behavior when the key is absent or rotated incorrectly (fail closed,
   with no plaintext fallback);
4. backup/export handling (encrypted backup by default, explicit redacted
   export for diagnostics); and
5. a recovery procedure that is tested without logging decrypted credentials.

Until those choices are approved, the safe operational contract is:

- protect `DATA_DIR` with the OS account and filesystem permissions;
- protect database backups and exports as credential-bearing secrets;
- keep `ENABLE_REQUEST_LOGS` disabled unless actively troubleshooting; and
- never add a migration that guesses a key or silently rewrites plaintext into
  an unrecoverable format.

This document records the gap and the required approval; it is not an
encryption claim.
