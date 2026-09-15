# RcRouter

<div align="center">
  <h1>🚀 RcRouter</h1>
  <p><b>Next-Gen High-Performance AI Router & Token Saver for Coding Agents</b></p>
  <p><i>Connect Claude Code, Cursor, Codex, OpenCode, Cline, and Copilot to AI providers with session-aware routing and granular multi-tenant access control.</i></p>
  
  <p>
    <b>Forked from the official <a href="https://github.com/decolua/9router">decolua/9router</a> (v0.5.75 Core)</b><br/>
    Enhanced with enterprise-grade features from <b>VansRouter</b> and intelligent combo routing from <b>OmniRoute</b>.
  </p>
</div>

---

## 🌟 Key Highlights & Why RcRouter?

Standard AI routers often suffer from three major shortcomings when driving long-running coding agents:
1. **Broken Prompt Caching:** Naive round-robin can switch accounts between turns, causing upstream prompt-cache misses and avoidable cost or latency.
2. **Missing Access Control:** Anyone with an API key can access every connected model and provider without restrictions.
3. **Agentic Loops & Degeneration:** Reasoning models (like Kimi K2.6/K2.7) frequently enter degenerate overthinking loops or leak unparsed raw markup into client outputs.

**RcRouter solves all of this out-of-the-box:**
- ✅ **Context-Relay (Cache-Aware Routing):** Reuses the same eligible upstream account across successful turns when a session ID is supplied, improving the chance of upstream prompt-cache hits.
- ✅ **Upstream v0.5.75 Core:** Fully aligned with the latest official 9router core (1M context window auto-compact, 4-marker Claude cache budget caps, Kiro protocol updates).
- ✅ **Granular Tri-State ACL:** Per-API-key restrictions across service kinds, providers, combos, and specific models (`null` = permit all, `[]` = deny all, array = whitelist).
- ✅ **Bounded read caching:** 5-second settings and 2-second connection caches, with explicit invalidation on mutation, reduce repeated SQLite reads within a process.
- ✅ **Account Capacity Guard:** Per-connection concurrency caps (default 3) with FIFO queueing and cancellation-safe slot release; configure `maxConcurrency` in a connection's provider-specific settings.
- ✅ **In-Memory Circuit Breaker:** Keyed per `provider:proxyHash` that automatically isolates failing upstreams while excluding HTTP 429 rate limits.
- ✅ **Token Savers (Ponytail + Caveman + RTK):** Injects senior-developer YAGNI rules (Lite, Full, Ultra) and terse formatting into system prompts; output reduction depends on the prompt and provider.
- ✅ **Anti-Loop Hardening:** Built-in `LoopGuard` terminates repetitive planning loops and converts Kimi-native `<|tool_calls_section_begin|>` into standard OpenAI `tool_calls`.
- ✅ **Seamless Auto-Migration:** Automatically migrates configurations and accounts from `~/.9router` to `~/.rcrouter` on initial startup without manual setup.

---

## 🧠 Deep Dive: Context-Relay (Cache-Aware Session Continuity)

### The Problem: Why Traditional Round-Robin Destroys Coding Sessions
Modern LLMs (Anthropic Claude 3.5/3.7, Google Gemini 2.5/3, DeepSeek V3) feature **Prompt Caching**. When large contexts (50k–150k tokens of repository code) are re-sent in multi-turn conversations:
- **Cache Hit:** A provider may discount cached input and return it faster according to its own cache policy.
- **Cache Miss:** The provider may bill and process the full context again; the exact impact depends on provider pricing and workload.

In naive routers with round-robin or random rotation:
```
Turn 1: Developer sends 60k tokens of code  ──> Sent to Account A (Cache created on Account A)
Turn 2: Developer asks follow-up question   ──> Rotated to Account B (CACHE MISS! Re-billed 60k tokens)
Turn 3: Developer asks to edit file X       ──> Rotated to Account C (CACHE MISS! Re-billed 60k tokens)
```
Every rotation wipes out the prompt cache.

### The Solution: How Context-Relay Works in RcRouter
When a combo uses the `context-relay` strategy, RcRouter extracts a session identifier from `x-session-id`, `x-conversation-id`, `session-id`, `body.session_id`, `body.conversation_id`, or `body.user`. The binding is tenant-scoped, expires after 30 minutes of inactivity, and is held in memory (so a restart clears it):

```
Turn 1: Request arrives (Session ID: "sess-abc")
        └──> Account A succeeds; RcRouter anchors the session to Account A.
Turn 2: Follow-up request arrives (Session ID: "sess-abc")
        └──> RcRouter prefers Account A if eligible; the upstream may reuse its cache.
Turn 3: Account A hits rate-limit (HTTP 429) or upstream error (5xx)
        └──> RcRouter invalidates the failed binding and tries an eligible fallback.
        └──> The session re-anchors to Account B only if that request succeeds.
```

**Key Advantages:**
1. **Cache continuity:** Reusing an eligible account can preserve upstream prompt-cache locality; actual savings depend on the provider and request.
2. **Failure safety:** A failed request does not create an affinity binding.
3. **Resilient failover:** Retryable account failures can switch to another account or target, with a new binding after success.

---

## 🎯 Combo Routing Strategies

RcRouter supports 6 specialized strategies per combo:

| Strategy | Description | Best For |
| :--- | :--- | :--- |
| **`context-relay`** | Anchors sessions to the same target for prompt cache hits; fails over on error | Claude Code, Cursor, long multi-turn sessions |
| **`p2c`** | Power of Two Choices: picks 2 random candidates, routes to the least loaded | High-concurrency teams, latency reduction |
| **`reset-aware`** | Prioritizes accounts whose free monthly quota resets soonest (< 48h) | Maximizing free tier tokens before expiration |
| **`fallback`** | Tries targets in strictly configured sequence; moves to next on error | Simple primary/backup chains |
| **`round-robin`** | Sequential cyclic rotation across all healthy targets | Distributing uniform load across accounts |
| **`fusion`** | Queries all candidates in parallel; judge model synthesizes one optimal answer | Highest possible reasoning and code quality |

### Auto Combo policies

The virtual `auto`, `auto/coding`, `auto/fast`, `auto/cheap`, and
`auto/reasoning` models apply their policy only after candidate validation.
Disabled connections, model locks, cached quota exhaustion, circuit-breaker
cooldowns, and API-key ACL denials are excluded before routing. If no eligible
target remains, the API returns `503 No eligible models available for auto
combo`; it never sends the synthetic `auto/fallback` model upstream.

---

## 🔒 Tri-State Multi-Tenant Access Control (ACL)

RcRouter implements strict tri-state access control per API key:
- `null` / `undefined`: **Allow all** (unrestricted key).
- `[]` (empty array): **Deny all** (total restriction).
- `["item1", "item2"]`: **Whitelist** (only listed items permitted).

### Enforced Layers:
1. **Service Kind:** `allowedKinds` (`llm`, `embedding`, `image`, `tts`, `stt`, `video`, `webSearch`).
2. **Provider Whitelist:** `allowedProviders` (`anthropic`, `openai`, `glm`, `kiro`, etc.).
3. **Combo Whitelist:** `allowedCombos` (`combo/coding`, `combo/fast`).
4. **Model Whitelist:** `allowedModels` (restricts specific model IDs).
5. **Catalog Discovery:** `GET /v1/models` automatically filters visible models according to the caller's key.
6. **Internal Trust Bypass:** Constant-time token verification supporting both `x-rc-cli-token` and legacy `x-9r-cli-token` headers.

---

## 🗜️ Token Savers (Ponytail + Caveman + RTK)

Reduce upstream token usage without modifying client code:
- **Ponytail (Senior Dev YAGNI Ruleset):** Injects concise design ladder instructions directly into system prompts:
  - `lite`: Standard implementation with a one-line mention of simpler alternatives.
  - `full`: Enforced ladder: standard library first, native features second, shortest diff.
  - `ultra`: Aggressive YAGNI: favors deletion over addition, prefers one-line stdlib solutions.
- **Caveman Mode:** Enforces terse, jargon-free output format.
- **RTK (Request Token Killer):** In-place compression of bulky `tool_result` contents (such as git diffs, file searches, directory listings).
- **LoopGuard:** Enabled by default; detects repeated tool calls or text-only planning loops and injects a stop-and-summarize hint. Disable it with `PATCH /api/settings` (`{"loopGuardEnabled":false}`) when a provider intentionally repeats context.

---

## 🔌 Specialized Providers & Regional Extensions

- **ZCode (Z.ai GLM-5.2):** Integrates ZCode Plan GLM models with automated Aliyun CAPTCHA solving via headless Playwright.
- **Local SearXNG:** Self-hosted web search provider (`http://127.0.0.1:8888/search`) with zero API keys required.
- **Indonesian & Southeast Asian TTS:** Pre-registered neural voices (`id-ID-ArdiNeural`, `id-ID-GadisNeural`, `th-TH-PremwadeeNeural`, `ms-MY-YasminNeural`, `tl-PH-BlessicaNeural`).
- **Multi-Account Compatible Nodes:** Allows operators to add unlimited connection keys to a single custom OpenAI or Anthropic compatible node.

---

## ⚡ Quick Start

### Install the global CLI (npm)

```bash
npm install -g rcrouter
rcrouter
```

The CLI bundles the production server and opens the dashboard at
`http://localhost:20128`. Use `rcrouter --no-browser` on headless machines.

### 1. Run from Source (Recommended for Local Dev)

```bash
cd RcRouter

# Install dependencies
pnpm install

# Start development server (port 20128)
pnpm run dev
```

Dashboard is accessible at `http://localhost:20128/dashboard`.  
API endpoint is available at `http://localhost:20128/v1`.

### 2. Production Build & PM2 Deployment

```bash
cd RcRouter

# Production standalone build (includes auto DB backup & static asset copying)
pnpm run build

# Start with PM2 on default port 20128:
PORT=20128 pm2 start server.js --name rcrouter

# Or specify custom port for Nginx reverse proxy (e.g. 3003):
PORT=3003 pm2 start server.js --name rcrouter

# Save PM2 state across system reboots
pm2 save
```

### 3. Systemd User Service (Linux)

Create `~/.config/systemd/user/rcrouter.service`:

```ini
[Unit]
Description=rcrouter - Local AI Model Proxy Gateway (port 20128)
After=network.target network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/node /path/to/RcRouter/server.js
WorkingDirectory=/path/to/RcRouter
Environment="PORT=20128"
Environment="HOSTNAME=0.0.0.0"
Environment="NODE_ENV=production"
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Enable and start the service:
```bash
systemctl --user daemon-reload
systemctl --user enable --now rcrouter.service
```

---

## ✅ Quality Checks

```bash
pnpm install --frozen-lockfile
pnpm test                              # regression gate against reviewed baseline
pnpm test:raw                          # full Vitest output
pnpm test:focused tests/unit/capabilities.test.js
pnpm lint                              # lint regression gate against reviewed baseline
pnpm lint:raw                          # full ESLint output, including known debt
pnpm check                             # lint + regression gate
pnpm run build
pnpm run release:cloud-smoke              # Cloudflare Worker embeddings fixture
```

The offline suite is green: all runnable tests pass. `pnpm test` still compares
against the historical reviewed baseline in `tests/__baseline__/README.md` so
future regressions remain visible; do not refresh that snapshot merely to hide
a new failure. Live/real-provider tests remain explicitly gated on credentials
or `RUN_LIVE_TESTS=1`.

The opt-in provider lane is available from GitHub Actions → **Live provider tests**.
Set the protected `RCROUTER_LIVE_TESTS=1` repository secret before dispatching it;
the default quality workflow never contacts external providers. The optional real
provider and RTK jobs require a runner with a seeded `DATA_DIR`/API key and are
enabled explicitly through workflow inputs.

The optional Cloudflare Worker slice lives in [`cloud/`](cloud/). It shares the
`open-sse` core and exposes `/health` plus OpenAI-compatible `/v1/embeddings`.
`pnpm run release:cloud-smoke` runs its deterministic fixture and is part of
`pnpm run release:verify`.

Account capacity is process-local. Set a connection's `maxConcurrency` to a
positive number to cap in-flight upstream requests, or `0`/`null` to bypass
the cap. Multi-process deployments need a shared coordinator if limits must
apply across workers.

### Operational metrics and correlation

`GET /api/metrics` is protected by dashboard authentication (or the machine-bound
CLI token). It returns bounded, process-local counters, gauges, latency summaries,
circuit-breaker states, and redacted semaphore identifiers; prompts, credentials,
and raw session identifiers are not included. Chat responses carry an
`x-rc-correlation-id` header that can be matched with request-detail diagnostics.

---

## 🤖 Connecting Your AI Coding Tools

### Claude Code
```bash
export ANTHROPIC_BASE_URL="http://localhost:20128/v1"
export ANTHROPIC_AUTH_TOKEN="<your-rcrouter-api-key>"
claude
```

### Cursor IDE
- **OpenAI API Key:** `<your-rcrouter-api-key>`
- **OpenAI Base URL:** `http://localhost:20128/v1`
- **Models:** `combo/glm-5.2`, `combo/claude-opus-4.8`, `kr/claude-sonnet-4.5`

### OpenAI Codex CLI
In `~/.codex/config.toml`:
```toml
model = "combo/glm-5.2"
model_provider = "RcRoute"

[model_providers.RcRoute]
name = "RcRouter"
base_url = "http://localhost:20128/v1"
wire_api = "responses"
```

---

## 📜 Upstream Attribution & License

- **Upstream Project:** [decolua/9router](https://github.com/decolua/9router)
- **License:** MIT License (Open Source)
