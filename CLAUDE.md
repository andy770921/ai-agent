# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Project Overview

FEAT-1 — a LINE-driven LLM agent system. Three independently-deployed
components plus a Docker container:

```
├── frontend/        # Next.js 15 — dashboard (Cloudflare Pages, static export)
├── shared/          # @repo/shared — AgentEvent / SessionSummary / health types
├── edge/            # Cloudflare Worker — webhook + KV-hosted images + dashboard BFF
├── agent-runtime/   # Docker container for Northflank (NOT an npm workspace)
├── documents/       # Per-ticket plans (PRDs + implementation docs)
├── .claude/         # Custom slash commands
├── turbo.json       # Turborepo task graph
└── package.json     # npm workspaces root (frontend + shared + edge)
```

The original NestJS `backend/` workspace was removed when the boilerplate was
repurposed for FEAT-1; the dashboard talks directly to the Cloudflare Worker.

## Commands

```bash
npm install                          # install all workspace deps
npm run dev --workspace=frontend     # dashboard at http://localhost:3001
npm run dev --workspace=@repo/edge   # Worker via `wrangler dev`
npm run build                        # build everything via turbo
npm run test --workspace=@repo/edge  # Vitest tests for the Worker
npm run lint                         # eslint across all workspaces
```

**Run a single Worker test:**
```bash
cd edge && npx vitest run test/lineWebhook.test.ts
```

**Frontend tests (Jest):**
```bash
cd frontend && npx jest src/path/to/file.spec.ts
```

**Build the dashboard for Cloudflare Pages:**
```bash
npm run build:pages --workspace=frontend
# Output: frontend/out/  (deploy via `npm run pages-deploy --workspace=frontend`)
```

## Architecture

### Request flow (LINE → agent → LINE)

1. LINE Platform POSTs the webhook to the Cloudflare Worker (`edge/`).
2. Worker verifies `X-Line-Signature` (fast-fail pre-check), dedupes
   `webhookEventId` via KV, and forwards `rawBody` unchanged to
   `https://<container>.northflank.app/webhook/line`.
3. `openab-gateway` (Rust) re-verifies HMAC, generates an `event_id`, caches
   `event_id → replyToken` for 50 s, and pushes the event over a loopback
   WebSocket to `openab` core.
4. `openab` spawns (or reuses) a `gemini --acp` subprocess for the LINE
   userId's session. Gemini uses Playwright MCP / GitHub MCP as needed.
5. The agent's text reply travels back the same path; the gateway uses LINE
   Reply API while the `replyToken` is fresh and falls back to Push API.
6. Image replies bypass the gateway: the agent runs `post-screenshot.sh`
   (uploads to the KV image store via the Worker) and `send-line-image.sh` (POSTs LINE Push
   API directly using the `LINE_CHANNEL_ACCESS_TOKEN` exposed via
   `openab.toml` `[agent].env`).

### Dashboard event flow

- Gemini CLI writes JSON-line telemetry to `$GEMINI_TELEMETRY_OUTFILE`.
- A Node sidecar inside the container tails the file and reshapes each event
  to the `AgentEvent` shape (`shared/src/types/agent-events.ts`).
- The sidecar serves `GET /events/stream` (SSE) + `/sessions` + history at
  port 8081, auth-gated by `DASHBOARD_INGEST_TOKEN`.
- The Cloudflare Worker proxies `/api/sessions/stream` etc. with a separate
  `DASHBOARD_TOKEN` bearer so a frontend-token leak doesn't grant container
  access.
- The Next.js dashboard consumes SSE via a `fetch`-based reader (not
  `EventSource`) so the bearer travels via the `Authorization` header instead
  of the URL.

### Shared types

`shared/src/types/`:

- `agent-events.ts` — `AgentMessageIn | AgentToolCall | AgentToolResult | AgentMessageOut` union, plus `SessionSummary`.
- `health.ts`, `api.ts` — generic boilerplate types kept for future use.

Import as `import { AgentEvent } from '@repo/shared'`.

### Environment variables

Each workspace has its own `.env.example`:

- `frontend/.env.local` — `NEXT_PUBLIC_WORKER_URL` for the dashboard.
- `edge/.dev.vars` — Cloudflare Worker secrets (`LINE_CHANNEL_SECRET`,
  `LINE_ALLOWED_USER_IDS`, `CF_UPLOAD_SECRET`, `DASHBOARD_INGEST_TOKEN`,
  `DASHBOARD_TOKEN`). Production values via `wrangler secret put`.
- `agent-runtime/.env` — container env (LINE channel creds, `GEMINI_API_KEY`,
  `GITHUB_TOKEN`, `CF_UPLOAD_SECRET`, etc.). Production values via the
  Northflank secret manager.

The complete env-var table with who-reads-what is in
`documents/FEAT-1/development/gemini-cli-tools.md` Step 6.

## Upstream verification

Before making non-trivial changes to `agent-runtime/`, read
`documents/FEAT-1/development/openab-upstream-findings.md`. It documents
five upstream truths that override the PRD where they disagree:

1. `openab` and `openab-gateway` are **two separate binaries / crates**.
2. OpenAB TOML uses **singular** `[gateway]` and `[agent]` (not `[gateways.line]` etc.).
3. Hybrid Reply/Push is built into `openab-gateway`; we do NOT implement it.
4. OpenAB **does not relay images**; the agent calls LINE Push API directly.
5. Gemini CLI v0.41.x uses the **Policy Engine TOML** at `~/.gemini/policies/`,
   not `tools.core` / `tools.exclude` / `tools.allowed` keys in `settings.json`.

## Code style

- **Prettier**: semi, 2-space tabs, 100 print width, single quotes, trailing commas.
- **ESLint**: unified root `.eslintrc.js` — TypeScript, Next.js, Prettier.
- **TypeScript**: strict; frontend uses `moduleResolution: bundler`; edge uses
  `moduleResolution: Bundler` + Cloudflare Workers types; shared uses
  CommonJS so it's consumable by both.

## Documentation pattern

Work is tracked in `documents/[TICKET-NUMBER]/`:

```
documents/FEAT-1/
├── plans/        # PRDs, design decisions
└── development/  # Per-component implementation docs + upstream-findings + e2e runbook
```

## Custom slash commands

Located in `.claude/commands/[skill-name]/SKILL.md`. Replace `[TICKET]` with
the ticket ID (e.g. `FEAT-1`).

| Command                                   | Description                                 |
| ----------------------------------------- | ------------------------------------------- |
| `/write-a-prd [TICKET]`                   | Create a PRD through systematic discovery   |
| `/grill-me [TICKET]`                      | Stress-test a plan through questioning      |
| `/tdd [TICKET]`                           | Implement with test-driven development      |
| `/triage-issue [TICKET]`                  | Investigate bugs and create fix plans       |
| `/improve-codebase-architecture [TICKET]` | Find architectural improvements             |
| `/deploy-vercel [TICKET]`                 | Vercel deploy walkthrough (legacy; FEAT-1 deploys to Northflank + Cloudflare instead) |

## Deployment

- **Cloudflare Worker**: `cd edge && wrangler deploy` (after the two KV
  namespaces `WEBHOOK_DEDUP` and `IMG_KV` are created and their IDs are pasted
  into `edge/wrangler.toml`, plus the five Worker secrets are set via
  `wrangler secret put` — see
  `documents/FEAT-1/development/phase0-e2e-spike-runbook.md` §1).
- **Dashboard**: `npm run pages-deploy --workspace=frontend` (deploys
  `frontend/out/` to Cloudflare Pages project `ai-agent-dashboard`).
- **Container**: build `agent-runtime/Dockerfile` and push to Northflank
  per `agent-runtime/.northflank/service.yaml`.

The Phase 0.3 e2e spike runbook (`documents/FEAT-1/development/phase0-e2e-spike-runbook.md`)
documents the full deploy + verification sequence.
