# Implementation Plan: Environment Variables (cross-workspace)

## Overview

FEAT-4 changes the env-var surface in three places:
`agent-runtime/.env.example`, `edge/.dev.vars.example`, and
`frontend/.env.example`. This doc is the single source of truth for
what to add, keep, and remove. It is the canonical checklist for
PR review and for HF Space / Cloudflare secret rotation at cutover.

Per ShopBack security policy, placeholders use the `*_HERE` suffix and
real secrets never appear in committed files. Local dev copies the
`.example` files to gitignored `.env` / `.dev.vars` / `.env.local`.

## Files to Modify

- `agent-runtime/.env.example` — full rewrite (also covered in
  `container-deploy-cutover.md` step 3; this doc is authoritative if
  the two disagree)
- `edge/.dev.vars.example` — add 2 vars, keep the rest
- `frontend/.env.example` — no change (kept for completeness)

Production deployment targets:

| File | Production target | How to set |
|---|---|---|
| `agent-runtime/.env` | HF Space repository secrets | HF Space Settings → Variables and secrets |
| `edge/.dev.vars` | Cloudflare Worker secrets | `wrangler secret put <NAME>` (run from `edge/`) |
| `frontend/.env.local` | Cloudflare Pages env vars | Pages project → Settings → Environment variables |

## Step-by-Step Changes

### Step 1: `agent-runtime/.env.example` — full rewrite

**What's REMOVED** (FEAT-1 leftovers, no longer used):

- `GATEWAY_TOKEN` — was the shared secret between openab-gateway and
  openab core; both binaries are gone
- All `OPENAB_*` (none currently exist, but kept here for grep history)
- All `GEMINI_TELEMETRY_*` — Gemini CLI is gone; Mastra emits OTel
  directly
- `GEMINI_CLI_TRUST_WORKSPACE` — Gemini CLI is gone
- `# TELEGRAM_BOT_TOKEN` (commented placeholder) — only LINE is in
  scope for FEAT-4

**What's ADDED:**

- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` — multi-provider support
- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` — persistence
- `CURATOR_TOKEN` — bearer the Cloudflare cron sends to
  `POST /admin/curator`

**What's KEPT** (with comment updates):

- `LINE_CHANNEL_SECRET`, `LINE_CHANNEL_ACCESS_TOKEN` — now consumed
  by the TS LINE adapter, no longer by openab-gateway
- `GEMINI_API_KEY` — still the default provider
- `GITHUB_TOKEN` — forwarded to GitHub MCP subagent
- `CF_UPLOAD_SECRET`, `CF_IMG_BASE_URL` — image upload path unchanged
- `DASHBOARD_INGEST_TOKEN` — bearer the edge Worker sends on
  `/events/stream` + `/sessions`
- `LANGFUSE_SECRET_KEY`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_BASE_URL` —
  now consumed by Mastra's first-party OTel exporter

**Final `agent-runtime/.env.example` content:**

```bash
# agent-runtime container env. Copy to `.env` (gitignored) and fill in real values.
# In production, set these as HF Space secrets (Settings → Variables and secrets).
# Never commit real secrets. Placeholders use the *_HERE suffix per ShopBack security policy.

# --- LINE Messaging API (consumed by the TS LINE adapter) ---
LINE_CHANNEL_SECRET=YOUR_LINE_CHANNEL_SECRET_HERE
LINE_CHANNEL_ACCESS_TOKEN=YOUR_LINE_CHANNEL_ACCESS_TOKEN_HERE

# --- LLM provider keys (at minimum one; the runtime default is set in
#     Supabase: agent_config.default_model. Adding more keys lets that
#     row pick a different provider without redeploy.) ---
GEMINI_API_KEY=YOUR_GEMINI_API_KEY_HERE
ANTHROPIC_API_KEY=YOUR_ANTHROPIC_API_KEY_HERE
OPENAI_API_KEY=YOUR_OPENAI_API_KEY_HERE

# --- GitHub MCP subagent (fine-grained PAT, no admin/secrets scope) ---
GITHUB_TOKEN=YOUR_GITHUB_FINE_GRAINED_PAT_HERE

# --- Cloudflare Worker integration (outbound: container -> Worker /img) ---
CF_UPLOAD_SECRET=YOUR_CF_UPLOAD_SECRET_HERE
CF_IMG_BASE_URL=https://ai-agent-edge-server.YOUR_ACCOUNT.workers.dev

# --- Dashboard sidecar (bearer the edge Worker sends on /events/stream + /sessions) ---
DASHBOARD_INGEST_TOKEN=YOUR_DASHBOARD_INGEST_TOKEN_HERE

# --- Curator cron (bearer the edge Worker sends on /admin/curator) ---
# Generate with: openssl rand -hex 32
CURATOR_TOKEN=YOUR_CURATOR_TOKEN_HERE

# --- Supabase persistence (new project: agent-runtime-prod) ---
# URL format: https://<project-ref>.supabase.co
SUPABASE_URL=https://YOUR_SUPABASE_PROJECT_REF.supabase.co
# Service-role key; never expose to the browser. Found under
# Supabase project → Project settings → API → service_role secret.
SUPABASE_SERVICE_KEY=YOUR_SUPABASE_SERVICE_KEY_HERE

# --- Langfuse observability (consumed by Mastra OTel exporter) ---
# Create keys at: Langfuse → project settings → API Keys.
# If omitted, Mastra falls back to no-op (no error).
LANGFUSE_SECRET_KEY=YOUR_LANGFUSE_SECRET_KEY_HERE
LANGFUSE_PUBLIC_KEY=YOUR_LANGFUSE_PUBLIC_KEY_HERE
LANGFUSE_BASE_URL=https://jp.cloud.langfuse.com

# --- Playwright / GitHub MCP local install controls (optional) ---
# Set to "1" to skip the postinstall Chromium download (CI, Dockerfile build).
# PLAYWRIGHT_SKIP_BROWSER_INSTALL=1
# Set to "1" to download the GitHub MCP binary into node_modules/.bin/
# during `npm install` on a dev machine. Default unset; the Dockerfile
# installs the binary to /usr/local/bin/ regardless of this var.
# INSTALL_GITHUB_MCP_LOCALLY=1
# Override the GitHub MCP binary path (otherwise resolved from PATH).
# GITHUB_MCP_BIN=/usr/local/bin/github-mcp-server
```

### Step 2: `edge/.dev.vars.example` — add 2 vars, keep the rest

**What's ADDED:**

- `CURATOR_TOKEN` — the bearer the Worker's weekly cron sends to the
  agent-runtime's `POST /admin/curator`. Must match the value in
  `agent-runtime/.env`'s `CURATOR_TOKEN`.

`AGENT_RUNTIME_URL` is **not** needed — the cron handler reuses the
existing `GATEWAY_BASE_URL` from `wrangler.toml [vars]` since the
agent-runtime and LINE webhook gateway are the same HF Space host.

**What's KEPT:** all 5 existing vars unchanged.

**Final `edge/.dev.vars.example` content:**

```bash
# Cloudflare Worker local secrets. Copy to `.dev.vars` (gitignored) for `wrangler dev`.
# In production these are set via `wrangler secret put <NAME>`.
# Never commit real secrets. Placeholders use the *_HERE suffix per ShopBack security policy.

# --- LINE webhook verification (edge fast-fail; agent re-verifies) ---
LINE_CHANNEL_SECRET=YOUR_LINE_CHANNEL_SECRET_HERE
LINE_CHANNEL_ACCESS_TOKEN=YOUR_LINE_CHANNEL_ACCESS_TOKEN_HERE
# Comma-separated LINE userIds. During bootstrap only, may temporarily be `*`.
LINE_ALLOWED_USER_IDS=Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx,Uyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy

# --- Worker <-> container sidecar (dashboard endpoints) ---
DASHBOARD_INGEST_TOKEN=YOUR_DASHBOARD_INGEST_TOKEN_HERE

# --- Worker <-> KV image uploads (container -> Worker PUT /img) ---
CF_UPLOAD_SECRET=YOUR_CF_UPLOAD_SECRET_HERE

# --- Dashboard frontend <-> Worker ---
# Bearer the dashboard pastes into /dashboard/login and sends as Authorization.
DASHBOARD_TOKEN=YOUR_DASHBOARD_TOKEN_HERE

# --- Curator cron (Worker -> agent-runtime POST /admin/curator) ---
# Must match the agent-runtime's CURATOR_TOKEN exactly.
CURATOR_TOKEN=YOUR_CURATOR_TOKEN_HERE
```

### Step 3: `frontend/.env.example` — no change

The dashboard talks to the Worker; the Worker proxies to the
agent-runtime. The frontend has no direct knowledge of Supabase,
Langfuse, or any FEAT-4 internal. `NEXT_PUBLIC_WORKER_URL` stays.

Future admin UI (system prompt editor — explicitly out of scope per
`prd.md` §"Out of Scope") may add a token var; not in FEAT-4.

**`frontend/.env.example` content remains:**

```bash
# Frontend env. Copy to `.env.local` (gitignored) for local dev.
# Never commit real secrets.

# Cloudflare Worker base URL — every dashboard call (REST + SSE) goes here.
# Set after `wrangler deploy`; defaults to "" which makes the dashboard call
# relative URLs on the Pages origin (broken — only useful for local dev with
# the Worker proxied through `wrangler dev` on the same origin).
NEXT_PUBLIC_WORKER_URL=https://ai-agent-edge-server.YOUR_ACCOUNT.workers.dev
```

## Cross-workspace consistency checks

These pairs MUST hold the same value across files:

| Value | `agent-runtime/.env` | `edge/.dev.vars` | Frontend |
|---|---|---|---|
| `LINE_CHANNEL_SECRET` | ✓ | ✓ | — |
| `LINE_CHANNEL_ACCESS_TOKEN` | ✓ | ✓ | — |
| `DASHBOARD_INGEST_TOKEN` | ✓ | ✓ | — |
| `CF_UPLOAD_SECRET` | ✓ | ✓ | — |
| `CURATOR_TOKEN` (new) | ✓ | ✓ | — |

Mismatch symptoms:

- `DASHBOARD_INGEST_TOKEN` mismatch → Worker calls to
  `/events/stream` return 401; dashboard goes blank.
- `CF_UPLOAD_SECRET` mismatch → `deliver-line-image.sh` 401s; LINE
  image replies fail silently.
- `CURATOR_TOKEN` mismatch → weekly cron 401s; check
  `curator_runs` table for the missing rows.
- `LINE_CHANNEL_SECRET` mismatch → one of edge / agent rejects the
  webhook (defence-in-depth — both verify); LINE retries 3× then
  drops.

## Secret generation

```sh
# Any *_TOKEN / *_SECRET we own (not LINE / Supabase / Anthropic):
openssl rand -hex 32

# Specific:
CURATOR_TOKEN     — generate fresh per environment (dev/staging/prod)
DASHBOARD_TOKEN   — generate fresh; rotate if a teammate leaves
DASHBOARD_INGEST_TOKEN — generate fresh; rotate on container compromise
CF_UPLOAD_SECRET  — generate fresh; rotate independently of others
```

## Cutover checklist (week 5)

In order:

1. Generate new `SUPABASE_URL` and `SUPABASE_SERVICE_KEY` from the
   new `agent-runtime-prod` Supabase project (see `persistence.md`
   step 1).
2. Generate fresh `CURATOR_TOKEN` (openssl rand -hex 32).
3. Set the **HF Space** secrets (production agent-runtime values):
   ```sh
   # Via HF Space Settings → Variables and secrets, set:
   #   SUPABASE_URL, SUPABASE_SERVICE_KEY,
   #   ANTHROPIC_API_KEY, OPENAI_API_KEY,
   #   CURATOR_TOKEN
   # Keep existing: LINE_*, GEMINI_API_KEY, GITHUB_TOKEN, CF_*, DASHBOARD_INGEST_TOKEN, LANGFUSE_*
   # Remove: GATEWAY_TOKEN (no longer used)
   ```
4. Set the **Cloudflare Worker** secrets (production edge values):
   ```sh
   cd edge/
   wrangler secret put CURATOR_TOKEN       # paste same value as step 2
   # AGENT_RUNTIME_URL is not needed — cron uses GATEWAY_BASE_URL from wrangler.toml
   ```
5. Verify with `wrangler secret list` (Cloudflare) and HF Space
   Settings (HF) — each should list everything in the corresponding
   `.example` file.
6. Trigger the cron once manually:
   `wrangler triggers trigger` (or `curl -X POST -H "Authorization:
   Bearer $CURATOR_TOKEN" https://andy770921-ai-agent.hf.space/admin/curator`).
   Expect 200 + a row in `curator_runs` with `phase = 'cron-success'`.

## Local dev quick start

```sh
# Once per dev:
cp agent-runtime/.env.example agent-runtime/.env
cp edge/.dev.vars.example edge/.dev.vars
cp frontend/.env.example frontend/.env.local
# Fill in real values; for local Supabase: npx supabase start (see persistence.md)

# Per session:
npx supabase start                            # local Postgres on :54322
cd agent-runtime && npm run dev               # :7860
cd edge && npm run dev                         # :8787 (wrangler dev)
cd frontend && npm run dev                     # :3001
```

Local dev does NOT exercise the cron path. Test the cron against
staging or by `curl`-ing the agent's `/admin/curator` directly.

## Testing Steps

1. After step 1/2 edits land: `grep -r "GATEWAY_TOKEN\|OPENAB_\|GEMINI_TELEMETRY_" agent-runtime/`
   → should return zero hits.
2. `diff agent-runtime/.env.example` against this doc's "Final
   content" block — must match exactly (placeholders included).
3. CI lint: a tiny script in `.github/workflows/env-lint.yml` that
   asserts every `process.env.X` in `agent-runtime/src/` and
   `edge/src/` has a matching key in the corresponding `.example`
   file.

## Dependencies

- Depends on: `container-deploy-cutover.md` (step 3 is now governed by
  this doc), `curator.md` (curator endpoint), `persistence.md`
  (Supabase project)
- Must complete before: cutover (week 5)

## Notes

- ShopBack security policy says **never** push to non-ShopBack
  remotes. The HF Space repo is allowed because it is operated by the
  team and hosts only container artefacts (no source secrets — those
  live in HF Space variables/secrets).
- Do NOT commit `agent-runtime/.env`, `edge/.dev.vars`, or
  `frontend/.env.local`. They're already in `.gitignore`; verify with
  `git check-ignore -v agent-runtime/.env`.
- If you add a new env var, update this doc in the same PR. The
  `.example` files alone are not sufficient — this doc is what
  reviewers grep.
