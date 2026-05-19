# Implementation Plan: OpenAB Removal & Mastra Cutover

## Overview

All Mastra `src/` code is already written and functional:
- `src/server.ts` — Hono server on `:7860` with all routes
- `src/agent/` — Mastra Agent + multi-provider (Gemini, Anthropic, OpenAI)
- `src/mcp/subagentRunner.ts` — Mastra-native subagent (NOT Gemini CLI)
- `src/mcp/mcpClients.ts` — MCP client instantiation
- `src/line/` — LINE webhook, HMAC, reply/push
- `src/db/` — Supabase persistence
- `src/observability/` — Event bus, SSE, ring buffer
- `src/memory/` — Memory extraction pipeline
- `src/skills/` — Skill auto-creation
- `src/curator/` — Weekly curator cron

**Remaining work is infrastructure cutover only:**
1. Rewrite Dockerfile (remove Rust/OpenAB/Gemini CLI)
2. Rewrite entrypoint.sh (just start Node)
3. Delete obsolete files
4. Update system prompt seed migration
5. Update `.env.example`
6. Apply Supabase migrations
7. Verify build + deploy

## Files to Delete

### OpenAB stack (entire Rust runtime)
- `agent-runtime/config/openab.toml` — OpenAB config, replaced by Mastra
- `agent-runtime/gemini/settings.json` — Gemini CLI settings
- `agent-runtime/gemini/system.md` — moved to Supabase `agent_config` table
- `agent-runtime/gemini/policies/tool-allowlist.toml` — replaced by Mastra tool config

### Obsolete scripts (replaced by `src/` TypeScript)
- `agent-runtime/scripts/render-config.sh` — rendered OpenAB TOML
- `agent-runtime/scripts/render-mcp-config.sh` — merged MCP servers into Gemini CLI
- `agent-runtime/scripts/events-emitter.js` — tailed Gemini telemetry; replaced by `src/observability/bus.ts`
- `agent-runtime/scripts/healthz.js` — sidecar on :8081; replaced by `src/server.ts` routes
- `agent-runtime/scripts/hf-proxy.js` — reverse proxy :7860→:8080/:8081; unnecessary since `src/server.ts` listens on :7860 directly

### Obsolete script libraries (replaced by `src/observability/`)
- `agent-runtime/scripts/lib/agentEventBus.js` → `src/observability/bus.ts`
- `agent-runtime/scripts/lib/jsonLineDecoder.js` → not needed (no file tailing)
- `agent-runtime/scripts/lib/langfuseSink.js` → `src/observability/` + Mastra OTel
- `agent-runtime/scripts/lib/ringBufferSink.js` → `src/observability/ringBufferSink.ts`
- `agent-runtime/scripts/lib/sseFanoutSink.js` → `src/observability/sse.ts`

### Kept (NOT deleted)
- `agent-runtime/scripts/deliver-line-image.sh` — still used by `src/mcp/parentTools.ts`
- `agent-runtime/scripts/install-mcp-deps.cjs` — postinstall for Chromium
- `agent-runtime/mcp/servers.json` — reference only (mcpClients.ts is canonical)
- `agent-runtime/supabase/migrations/` — apply to Supabase
- `agent-runtime/src/` — the new Mastra runtime
- `agent-runtime/tests/` — acceptance tests

## Files to Rewrite

### Dockerfile

**Current:** Two-stage build (Rust + Node), ~120 lines.
**New:** Single-stage Node build, ~60 lines.

Remove:
- Stage 1: `rust:1.95-slim-bookworm` (OpenAB build)
- Gemini CLI install (`npm install -g @google/gemini-cli`)
- OpenAB binary copies (`COPY --from=openab-build ...`)
- OpenAB config copies (`COPY config/openab.toml`, `COPY gemini/...`)
- OpenAB directories (`/var/lib/openab/sessions`, `/var/log/openab`, `/etc/openab`)
- Script copies for deleted scripts
- `ripgrep` and `gettext-base` (only used by Gemini CLI / render-config.sh)

Keep:
- Node 22 base
- Playwright MCP + Chromium
- GitHub MCP server binary
- Langfuse SDK
- `gh` CLI (operator tool)
- `tini` process supervisor
- `ca-certificates`, `curl`, `procps`
- `deliver-line-image.sh`, `install-mcp-deps.cjs`

Add:
- `npm install` for agent-runtime dependencies (NOT `npm ci` — see note below)
- `npm run build` (TypeScript compilation)
- Copy `dist/` to runtime

**npm install vs npm ci:** `agent-runtime` is listed in the root `package.json`
workspaces but has no standalone `package-lock.json` (the lock file lives at the
monorepo root, which is NOT copied to the HF Space).  The Dockerfile must use
`npm install` instead of `npm ci`.  This is acceptable for a single-deployer
project.  Future improvement: generate a standalone lock file or remove
agent-runtime from the workspace array.

### entrypoint.sh

**Current:** 78 lines — validates env, renders OpenAB config, starts 4 processes.
**New:** ~20 lines — validates env, starts Node server.

```sh
#!/bin/sh
set -eu

# Validate required env vars
: "${LINE_CHANNEL_SECRET:?missing}"
: "${LINE_CHANNEL_ACCESS_TOKEN:?missing}"
: "${SUPABASE_URL:?missing}"
: "${SUPABASE_SERVICE_KEY:?missing}"
: "${DASHBOARD_INGEST_TOKEN:?missing}"
: "${CF_UPLOAD_SECRET:?missing}"
: "${CF_IMG_BASE_URL:?missing}"

# Start the single Node process
exec node --enable-source-maps dist/server.js
```

### System prompt seed migration

**File:** `agent-runtime/supabase/migrations/20260516_001_seed_config.sql`

Update the `system_prompt` value to include the Mastra-appropriate prompt:
- Remove references to Gemini CLI built-in tools (they don't exist in Mastra)
- Keep LINE persona, conciseness rules, sender_context format
- Reference the 3 parent tools: `task_browser`, `task_github`, `send_image`
- Keep `deliver-line-image.sh` usage instructions
- Keep GitHub limits (no push to default branches)

Update `default_model` to `gemini-2.5-flash` (or the current preferred model).

### .env.example

**File:** `agent-runtime/.env.example`

Add:
- `SUPABASE_URL=`
- `SUPABASE_SERVICE_KEY=`
- `ANTHROPIC_API_KEY=`
- `OPENAI_API_KEY=`
- `CURATOR_TOKEN=`
- `LINE_ALLOWED_USER_IDS=`

Keep:
- `LINE_CHANNEL_SECRET=`
- `LINE_CHANNEL_ACCESS_TOKEN=`
- `GEMINI_API_KEY=`
- `GITHUB_TOKEN=`
- `CF_UPLOAD_SECRET=`
- `CF_IMG_BASE_URL=`
- `DASHBOARD_INGEST_TOKEN=`
- `LANGFUSE_SECRET_KEY=`
- `LANGFUSE_PUBLIC_KEY=`
- `LANGFUSE_BASE_URL=`

Remove:
- `GATEWAY_TOKEN=`
- `GEMINI_TELEMETRY_*`
- `GEMINI_CLI_TRUST_WORKSPACE=`
- `OPENAB_*`

## Step-by-Step Implementation

### Step 1: Delete obsolete files

```bash
# OpenAB config
rm agent-runtime/config/openab.toml
rmdir agent-runtime/config/

# Gemini CLI config
rm -r agent-runtime/gemini/

# Obsolete scripts
rm agent-runtime/scripts/render-config.sh
rm agent-runtime/scripts/render-mcp-config.sh
rm agent-runtime/scripts/events-emitter.js
rm agent-runtime/scripts/healthz.js
rm agent-runtime/scripts/hf-proxy.js

# Obsolete script libraries
rm -r agent-runtime/scripts/lib/
```

**Rationale:** Clean slate before rewriting Dockerfile (avoids COPY errors for
deleted files).

### Step 2: Rewrite Dockerfile

See "Files to Rewrite" section above.  Key structure:

```dockerfile
FROM node:22-bookworm-slim

# System deps (Chromium libs, curl, tini, etc.)
RUN apt-get update && apt-get install -y ...

# Playwright MCP + Chromium
RUN npm install -g @playwright/mcp@0.0.30
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx --yes playwright install chromium

# GitHub MCP server binary
RUN curl -fsSL "https://github.com/..." | tar -xz ...

# Langfuse SDK (for sidecar compat — may remove later)
RUN mkdir -p /opt/sidecar && cd /opt/sidecar && npm init -y && npm install langfuse@3
ENV NODE_PATH=/opt/sidecar/node_modules

# gh CLI
RUN ...

# App dependencies
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

# Build TypeScript
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# Scripts
COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY scripts/deliver-line-image.sh /usr/local/bin/deliver-line-image.sh
COPY scripts/install-mcp-deps.cjs /usr/local/bin/install-mcp-deps.cjs
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/deliver-line-image.sh

# Runtime
ENV NODE_ENV=production
EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
    CMD curl -fsS http://127.0.0.1:7860/healthz || exit 1

USER node
ENTRYPOINT ["tini", "--", "/usr/local/bin/entrypoint.sh"]
```

**Rationale:** Single stage, no Rust, ~50% smaller image.

### Step 3: Rewrite entrypoint.sh

Replace the 78-line script with the ~12-line version shown above.

**Rationale:** One process, no orchestration needed.

### Step 4: Update .env.example

Rewrite with the variable list above.

**Rationale:** Remove confusion about which vars are needed.

### Step 5: Update system prompt seed migration

Create a new migration file or update the seed:
`agent-runtime/supabase/migrations/20260519_004_update_system_prompt.sql`

The prompt should reference Mastra's tool names (`task_browser`, `task_github`,
`send_image`) instead of Gemini CLI tools.

### Step 6: Apply Supabase migrations

Run migrations against the production Supabase project.  The existing migrations
create: `users`, `messages`, `memories`, `skills`, `agent_config`, `curator_runs`,
`curator_backups` + RPCs + triggers.

### Step 7: Set HF Space secrets

Add new secrets via HF Space Settings:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`
- `ANTHROPIC_API_KEY` (optional — only if using Claude)
- `OPENAI_API_KEY` (optional — only if using GPT-4o)
- `CURATOR_TOKEN`

Remove old secrets:
- `GATEWAY_TOKEN`
- `GEMINI_TELEMETRY_*`

### Step 8: Verify build + deploy

1. Push to `main` → HF sync triggers container rebuild
2. Check HF Space logs for `agent-runtime listening on :7860`
3. Send LINE test message
4. Check Langfuse for traces
5. Check dashboard SSE stream

## Testing Steps

### Pre-deployment (local)
1. `cd agent-runtime && npm run build` — verify TypeScript compiles
2. `npm test` — verify unit tests pass

### Post-deployment
3. Send LINE message: "Hello" — verify reply
4. Send LINE message: "Screenshot google.com" — verify Playwright works
5. Check Langfuse dashboard for traces
6. Check `/healthz` endpoint returns 200
7. Check `/events/stream` SSE delivers events
8. Check `/sessions` returns session list

### Negative tests
9. Send unsigned webhook → expect 401
10. Hit `/admin/curator` without token → expect 401

## Pre-Flight Checklist

Before deploying:

- [ ] Supabase project exists with all 4 migrations applied + system prompt updated
- [ ] `.env.example` updated (no GATEWAY_TOKEN, no GEMINI_TELEMETRY_*)
- [ ] `npm run build` compiles TypeScript without errors
- [ ] `npm test` passes
- [ ] HF Space secrets set (SUPABASE_URL, SUPABASE_SERVICE_KEY, etc.)
- [ ] Old HF Space secrets removed (GATEWAY_TOKEN, GEMINI_TELEMETRY_*)
- [ ] `pre-feat-4` backup branch created in HF Space repo before push
- [ ] CLAUDE.md updated to remove OpenAB references from architecture section

## Dependencies

- Supabase project must exist with migrations applied (Step 6)
- HF Space secrets must be set (Step 7)
- `.github/workflows/hf-sync.yml` does NOT need changes — it copies `agent-runtime/*`
  to the HF Space repo root (line 36: `cp -r ../agent-runtime/* .`), so deleted files
  are naturally excluded
- Edge Worker does NOT need changes — `gatewayForwarder.ts` already forwards to
  `/webhook/line` which is the same path on the new Hono server

## Rollback Plan

1. Create `pre-feat-4` backup branch in HF Space repo **before** cutover
2. If cutover fails: `git revert` the commit on `main`
3. HF Spaces auto-redeploys the old OpenAB image
4. Re-add removed HF Space secrets (`GATEWAY_TOKEN`, etc.)
5. Supabase migrations persist (DB is not rolled back) — this is safe because the
   old image doesn't touch Supabase
6. Estimated rollback time: ~10 minutes

## Notes

- The `mcp/servers.json` file is kept as documentation but is no longer used at
  runtime — `src/mcp/mcpClients.ts` is the canonical MCP configuration.
- `deliver-line-image.sh` is the only shell script that survives. It's called by
  `sendImageTool` in `src/mcp/parentTools.ts` via `execFile()`.
- The `scripts/install-mcp-deps.cjs` postinstall hook survives for local dev
  (downloads Chromium on `npm install`).
- The shared `@repo/shared` types package is kept — `AgentEvent` union is still
  used by `src/observability/`.
- `PROVIDERS` in `src/agent/index.ts` still lists `gemini-2.5-flash` and
  `gemini-2.5-pro`. These should be updated if switching to `gemini-3-flash-preview`
  or newer models.
- The Dockerfile needs TypeScript as a devDependency for the build step. Since
  `npm install --omit=dev` skips devDeps, the build must happen in a separate step
  that includes devDeps. Use a multi-stage approach: `npm install` (full) → build →
  `npm prune --omit=dev` → copy to final layer.
- CLAUDE.md must be updated to remove OpenAB architecture references (request flow,
  dashboard event flow, HF Spaces port routing sections).
