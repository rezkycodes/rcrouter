# RcRouter Cloud Worker

This optional Worker package reuses the RcRouter `open-sse` core for a small,
stateless edge surface: `/health` and OpenAI-compatible embeddings at
`/v1/embeddings` (plus the legacy `/{machineId}/v1/embeddings` path). The local
RcRouter process remains the full dashboard/control plane.

## Setup

```bash
# 1. Login to Cloudflare
npm install -g wrangler
wrangler login

# 2. Install dependencies
cd cloud
pnpm --ignore-workspace install

# 3. Create KV & D1, then paste IDs into wrangler.toml
wrangler kv namespace create KV
wrangler d1 create proxy-db

# 4. Init database & deploy
wrangler d1 execute proxy-db --remote --file=./migrations/0001_init.sql
npm run deploy
```

Copy the Worker URL into your client as an OpenAI-compatible base URL. The
machine records used by the handler are stored in D1; keep `wrangler.toml`
bindings private and replace the placeholder IDs before deploying.

## Local verification

From the repository root:

```bash
pnpm run release:cloud-smoke
```

The command runs the deterministic 26-case embeddings/runtime fixture. It is also part
of `pnpm run release:verify`, so a restored Worker tree cannot silently drift.

To validate the Cloudflare bundle locally after installing Worker dependencies:

```bash
cd cloud
./node_modules/.bin/wrangler deploy --dry-run --config wrangler.toml
```
