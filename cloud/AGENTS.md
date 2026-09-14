# RcRouter Cloud Worker

- Read `README.md` before changing this package.
- Keep Worker handlers portable to Cloudflare's runtime; desktop-only modules
  must remain behind explicit bundler stubs or lazy paths.
- Run the root `pnpm run release:cloud-smoke` fixture after changes. When the
  Worker dependencies are installed, also run the Wrangler dry-run command.
- Never commit D1/KV identifiers or API credentials from `wrangler.toml`.
