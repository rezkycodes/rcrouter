# RcRouter - AI Router & Token Saver

**Context-aware routing, token savings, and automatic fallback for AI coding tools.**

**Connect All AI Code Tools (Claude Code, Cursor, Antigravity, Copilot, Codex, Gemini, OpenCode, Cline, OpenClaw...) to 40+ AI Providers & 100+ Models.**

> RcRouter is a fork of **[9router](https://github.com/decolua/9router)** by decolua and contributors, used under the MIT License. It is an independent project, not an official 9router release, and is not endorsed by its authors. Report issues in [this repository](https://github.com/rezkycodes/rcrouter/issues), not upstream.

[![npm](https://img.shields.io/npm/v/@rezkycodes/rcrouter.svg)](https://www.npmjs.com/package/@rezkycodes/rcrouter)
[![Downloads](https://img.shields.io/npm/dm/@rezkycodes/rcrouter.svg)](https://www.npmjs.com/package/@rezkycodes/rcrouter)
[![GHCR](https://img.shields.io/badge/GHCR-rezkycodes%2Frcrouter-blue?logo=github)](https://github.com/rezkycodes/rcrouter/pkgs/container/rcrouter)
[![License](https://img.shields.io/npm/l/@rezkycodes/rcrouter.svg)](https://github.com/rezkycodes/rcrouter/blob/main/LICENSE)

[📖 Documentation](https://github.com/rezkycodes/rcrouter)

---

## 🤔 Why RcRouter?

**Stop wasting money, tokens and hitting limits:**

- ❌ Subscription quota expires unused every month
- ❌ Rate limits stop you mid-coding
- ❌ Tool outputs (git diff, grep, ls...) burn tokens fast
- ❌ Expensive APIs ($20-50/month per provider)

**RcRouter solves this:**

- ✅ **RTK Token Saver** - Auto-compress tool_result, save 20-40% tokens
- ✅ **Maximize subscriptions** - Track quota, use every bit before reset
- ✅ **Auto fallback** - Subscription → Cheap → Free, zero downtime
- ✅ **Multi-account** - Round-robin between accounts per provider
- ✅ **Universal** - Works with any OpenAI/Claude-compatible CLI

---

## ⚡ Quick Start

**Option 1 — npm or pnpm (recommended for desktop):**

```bash
# npm
npm install -g @rezkycodes/rcrouter

# pnpm
pnpm i -g @rezkycodes/rcrouter

rcrouter

# Or run directly with npx
npx @rezkycodes/rcrouter
```

**Option 2 — Docker (server/VPS):**

```bash
docker run -d --name rcrouter -p 20128:20128 \
  -v "$HOME/.rcrouter:/app/data" -e DATA_DIR=/app/data \
  ghcr.io/rezkycodes/rcrouter:latest
```

Published image: [GHCR](https://github.com/rezkycodes/rcrouter/pkgs/container/rcrouter) (multi-platform amd64/arm64).

🎉 Dashboard opens at `http://localhost:20128`

**2. Connect a FREE provider (no signup needed):**

Dashboard → Providers → Connect **Kiro AI** (free Claude unlimited) or **OpenCode Free** (no auth) → Done!

**3. Use in your CLI tool:**

```
Claude Code/Codex/OpenClaw/Cursor/Cline Settings:
  Endpoint: http://localhost:20128/v1
  API Key:  [copy from dashboard]
  Model:    kr/claude-sonnet-4.5
```

That's it! Start coding with FREE AI models.

---

## 🚀 CLI Options

```bash
rcrouter                    # Start with default settings
rcrouter --port 8080        # Custom port
rcrouter --no-browser       # Don't open browser
rcrouter --skip-update      # Skip auto-update check
rcrouter --help             # Show all options
```

**Dashboard**: `http://localhost:20128/dashboard`

---

## 🔌 Connect to a Remote RcRouter

Already running RcRouter on another machine (e.g. a team server on your LAN)? Point this machine's CLI tools at it — no local server is started:

```bash
rcrouter connect http://<server-host>:20128                       # pick tools interactively
rcrouter connect http://<server-host>:20128 --tools claude,codex  # or choose up front
rcrouter connect --reset --tools claude,codex                     # undo
```

Without a global install, run `npx @rezkycodes/rcrouter connect …` instead of `rcrouter connect …`.

For compatibility with existing setups the identifiers written to tool configs keep the `9router` name (provider id, `*.bak-9router` backups, `NINE_ROUTER_PASSWORD`).

It logs in with the dashboard password (hidden prompt), reuses or creates an API key named `cli-<hostname>`, and writes each tool's config (backing up the original once as `*.bak-9router`).

Supported tools: `claude`, `codex`, `opencode`, `droid`, `crush`, `kilo`, `cline`, `pi`, `omp`, or `all`.

### Models

Models come from the **server's own CLI-tools configuration**, so a client gets whatever the operator already picked on the dashboard. Nothing is hardcoded.

| Tool | Model taken from (first match wins) |
|---|---|
| `claude` | tier flag (`--opus` …) → server's Claude tier → *left unset* (Claude Code's own default) |
| others | `--model` → that tool's own model on the server → server's OpenCode model → *tool skipped* |

`kilo` has no readable model on the server, so it always uses `--model` or the OpenCode model. `omp` (Oh My Pi) needs no model: it uses proxy discovery, so every server model appears under `9router` in `/model`. A Claude tier the server doesn't set is removed from your config rather than kept from an earlier run. A skipped tool makes the command exit `1`.

### Overriding the server's models

```bash
# One Claude tier; the other tiers still come from the server
rcrouter connect http://<server-host>:20128 --tools claude --sonnet cc/claude-sonnet-5-5

# Every Claude tier
rcrouter connect http://<server-host>:20128 --tools claude \
  --fable cc/claude-fable-5-2 --opus cc/claude-opus-5-5 \
  --sonnet cc/claude-sonnet-5-5 --haiku cc/claude-haiku-4-5-20251001

# All non-Claude tools at once
rcrouter connect http://<server-host>:20128 --tools codex,opencode,kilo --model ocg/deepseek-flash

# Claude and other tools in one run
rcrouter connect http://<server-host>:20128 --tools claude,codex --opus cc/claude-opus-5-5 --model gpt-6

# A different model per tool: --model covers every non-Claude tool in a run, so run once per tool
rcrouter connect http://<server-host>:20128 --tools codex --model gpt-6
rcrouter connect http://<server-host>:20128 --tools opencode --model ocg/glm-5.3
```

A model the server doesn't list is still written, with a `not listed by server` warning. To see the ids it serves: `curl http://<server-host>:20128/v1/models -H "Authorization: Bearer <your key>"`.

### Checking the current config

`rcrouter show` prints what each CLI tool on this machine is currently set to — base URL, masked API key and models. It only reads local files and never contacts a server.

```bash
rcrouter show                 # every supported tool
rcrouter show claude          # one tool
rcrouter show claude codex    # several
rcrouter show claude --json   # machine-readable (key still masked)
```

```
✅ Claude Code
   File:     ~/.claude/settings.json
   Base URL: http://<server-host>:20128/v1
   API key:  sk-a1b…9f3c
   Models:
     fable   cc/claude-fable-5-2
     opus    cc/claude-opus-5-5
     sonnet  cc/claude-sonnet-5-5
```

Tools not pointed at RcRouter are listed as `not configured`. For Codex, OpenCode and Cline it also warns when a `9router` entry exists but another provider is the active one.

### Other options

| Option | Purpose |
|---|---|
| `--password <pw>` | Dashboard password (or `NINE_ROUTER_PASSWORD`); prompted if omitted — preferred, keeps it out of shell history |
| `--save` | After a successful login, save the password for this server to `~/.rcrouter/connect.env` (plain text, mode 600) so later runs skip the prompt. Delete the file to forget it |
| `--api-key <key>` | Use this key and skip login. The server's models can't be read without a login, so pass model flags |
| `--key-name <name>` | API key name to reuse/create (default `cli-<hostname>`) |
| `--print-env` | Also print `OPENAI_BASE_URL` / `OPENAI_API_KEY` for other CLIs |
| `--reset` | Remove the RcRouter (`9router`-named) settings from the selected tools |

See `rcrouter connect --help` for the full list.

> ⚠️ Over plain `http://` the password and API key are sent unencrypted — use a trusted LAN/VPN or put HTTPS in front. The API key is stored in each tool's config file.

---

## 🛠️ Supported CLI Tools

Claude-Code • OpenClaw • Codex • OpenCode • Cursor • Antigravity • Cline • Continue • Droid • Roo • Copilot • Kilo Code • Gemini CLI • Qwen Code • iFlow • Crush • Crusher • Aider

Any tool supporting OpenAI/Claude-compatible API works.

---

## 💾 Data Location

- **macOS/Linux**: `~/.rcrouter/db/data.sqlite`
- **Windows**: `%APPDATA%/rcrouter/db/data.sqlite`
- **Docker**: `/app/data/db/data.sqlite` (mount `$HOME/.rcrouter` to persist)

On first start, an existing `~/.9router` database (from 9router) is copied to the new location; the original is left untouched. Everything RcRouter installs for itself also lives under `~/.rcrouter`, including the SQLite runtime (`~/.rcrouter/runtime`), MITM certificates (`~/.rcrouter/mitm`) and update logs (`~/.rcrouter/update`), so a separately installed 9router keeps its own `~/.9router`.

---

## 📚 Documentation

Full docs, advanced setup, video tutorials & development guide:

- **GitHub**: https://github.com/rezkycodes/rcrouter
- **Full README**: https://github.com/rezkycodes/rcrouter/blob/main/README.md

---

## 🙏 Acknowledgments

- **[9router](https://github.com/decolua/9router)** by decolua and contributors - RcRouter is based on this project, used under the MIT License (their copyright notice is kept in [LICENSE](LICENSE))
- **[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)** - Original Go implementation

## 📄 License

MIT License - see [LICENSE](LICENSE) for details. Third-party components keep their own licenses.
