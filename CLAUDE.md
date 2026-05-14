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
├── agent-runtime/   # Docker container for HF Spaces (NOT an npm workspace)
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
cd edge && npx vitest run test/line/webhookHandler.test.ts
```

**Frontend tests (Jest):**
```bash
cd frontend && npx jest src/path/to/file.spec.ts
```

**Sidecar tests (Node built-in runner):**
```bash
cd agent-runtime && node --test scripts/lib/
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
   `https://andy770921-ai-agent.hf.space/webhook/line`.
3. `openab-gateway` (Rust) re-verifies HMAC, generates an `event_id`, caches
   `event_id → replyToken` for 50 s, and pushes the event over a loopback
   WebSocket to `openab` core.
4. `openab` spawns (or reuses) a `gemini --acp` subprocess for the LINE
   userId's session. Gemini uses Playwright MCP / GitHub MCP as needed.
5. The agent's text reply travels back the same path; the gateway uses LINE
   Reply API while the `replyToken` is fresh and falls back to Push API.
6. Image replies bypass the gateway: the agent runs `deliver-line-image.sh`,
   which uploads to the KV image store via the Worker then POSTs the resulting
   URL to LINE Push API directly using the `LINE_CHANNEL_ACCESS_TOKEN` exposed
   via `openab.toml` `[agent].env`. One operation, one status.

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

### HF Spaces port routing

HF Spaces only exposes port 7860. A reverse proxy (`hf-proxy.js`) routes:

- `/webhook/*`, `/health` → `:8080` (openab-gateway)
- everything else → `:8081` (Node sidecar)

The proxy always starts — no env var flag needed.

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
- HF Space secrets — container env (LINE channel creds, `GEMINI_API_KEY`,
  `GITHUB_TOKEN`, `CF_UPLOAD_SECRET`, `LANGFUSE_SECRET_KEY`,
  `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_BASE_URL`, etc.). Set via
  HF Space Settings → Repository secrets.
- `agent-runtime/.env.example` — all container env vars with placeholders.

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
documents/FEAT-1/    # original LINE agent build
documents/FEAT-2/    # HF Spaces migration
documents/FEAT-3/    # MCP env / Langfuse follow-ups
documents/FIX-1/     # one-off fixes
documents/REFACTOR-1/  # deep-modules refactor (Worker + sidecar + frontend SSE)

Each folder has:
  plans/             # PRDs, design decisions, RFCs
  development/       # Step-by-step implementation guides
```

`FEAT-*` = new product/feature work. `FIX-*` = bug fixes. `REFACTOR-*` =
internal restructure with no user-visible behavior change.

## Internal module organization (REFACTOR-1)

Deep modules are grouped under subfolders so the ports are obvious at a
glance:

- `edge/src/line/` — LINE webhook ports (`signatureVerifier`,
  `webhookDedupStore`, `gatewayForwarder`, `blockedUserReplier`) + the
  `webhookHandler` factory that composes them.
- `edge/src/ports/` — outbound adapters (`sidecarClient`, `imageStore`).
- `edge/src/router.ts` — tiny path/method/CORS router used by `index.ts`.
- `agent-runtime/scripts/lib/` — sidecar bus + sinks (`agentEventBus`,
  `ringBufferSink`, `sseFanoutSink`, `langfuseSink`, `jsonLineDecoder`).
- `frontend/src/lib/sse/` — `parseSseStream` (pure) +
  `reconnectingSseStream` (reconnect/heartbeat loop) consumed by
  `hooks/useEventStream`.

When adding a new outbound dependency: add a port under
`edge/src/ports/`. When adding a new observer to the sidecar event stream:
add a sink under `agent-runtime/scripts/lib/` and register it in
`healthz.js`. See `documents/REFACTOR-1/plans/prd.md` for the design
rationale and `development/deep-modules-implementation.md` for the build
order.

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
| `/deploy-vercel [TICKET]`                 | Deploy to Vercel (legacy)                   |

## Deployment

- **Cloudflare Worker**: `cd edge && wrangler deploy` (after the two KV
  namespaces `WEBHOOK_DEDUP` and `IMG_KV` are created and their IDs are pasted
  into `edge/wrangler.toml`, plus the five Worker secrets are set via
  `wrangler secret put` — see
  `documents/FEAT-1/development/phase0-e2e-spike-runbook.md` §1).
- **Dashboard**: `npm run pages-deploy --workspace=frontend` (deploys
  `frontend/out/` to Cloudflare Pages project `ai-agent-dashboard`).
- **Container**: pushed to HF Spaces via GitHub Actions
  (`.github/workflows/hf-sync.yml`). The workflow syncs `agent-runtime/`
  contents to the HF Space repo on every push to `main`.

The Phase 0.3 e2e spike runbook (`documents/FEAT-1/development/phase0-e2e-spike-runbook.md`)
documents the full deploy + verification sequence.
