# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Project Overview

A LINE-driven LLM agent system (FEAT-1 → FEAT-4). Three independently-deployed
components plus a Docker container:

```
├── frontend/        # Next.js 15 — dashboard (Cloudflare Pages, static export)
├── shared/          # @repo/shared — AgentEvent / SessionSummary / health types
├── edge/            # Cloudflare Worker — webhook + KV-hosted images + dashboard BFF
├── agent-runtime/   # Docker container for HF Spaces (Mastra + Hono, npm workspace)
├── documents/       # Per-ticket plans (PRDs + implementation docs)
├── .claude/         # Custom slash commands
├── turbo.json       # Turborepo task graph
└── package.json     # npm workspaces root (frontend + shared + edge + agent-runtime)
```

The `agent-runtime/` was rewritten in FEAT-4: OpenAB (Rust) + Gemini CLI replaced
with a single Node 22 TypeScript process using Mastra + Vercel AI SDK.

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

**Agent-runtime tests (Vitest):**
```bash
cd agent-runtime && npx vitest run
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
3. Hono server (`agent-runtime/src/server.ts`) re-verifies HMAC, calls
   `runTurn()` which invokes the Mastra agent with the user's message.
4. The Mastra agent has three parent-level tools: `task_browser` (Playwright
   MCP subagent), `task_github` (GitHub MCP subagent), `send_image`
   (deliver-line-image.sh). MCP tools are isolated in subagents so the
   parent context stays small.
5. The agent's text reply is sent via `replyOrPush()`: attempts LINE Reply
   API (free, 50 s replyToken window), falls back to Push API (paid).
6. Image replies: the `send_image` tool runs `deliver-line-image.sh`, which
   uploads to the KV image store via the Worker then POSTs the resulting URL
   to LINE Push API directly.

No WebSockets. No OpenAB. No external database — since FEAT-5 all persistence
(chat history, memories, skills, config) is in-process and resets on restart.
Single Node.js process listening on `:7860`.

### Dashboard event flow

- The Hono server emits `AgentEvent`s to an in-process event bus
  (`agent-runtime/src/observability/bus.ts`).
- A ring buffer sink stores the last 200 events per session for history
  queries.
- `GET /events/stream` (SSE) fans out live events to connected dashboards,
  auth-gated by `DASHBOARD_INGEST_TOKEN`.
- The Cloudflare Worker proxies `/api/sessions/stream` etc. with a separate
  `DASHBOARD_TOKEN` bearer so a frontend-token leak doesn't grant container
  access.
- The Next.js dashboard consumes SSE via a `fetch`-based reader (not
  `EventSource`) so the bearer travels via the `Authorization` header instead
  of the URL.

### HF Spaces port routing

HF Spaces only exposes port 7860. The Hono server (`src/server.ts`) listens
directly on `:7860` — no reverse proxy needed.

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
- `agent-runtime/.env.example` — all container env vars with placeholders
  (LINE creds, LLM provider keys, Langfuse, CF integration). No Supabase since
  FEAT-5. Production values set via HF Space Settings → Repository secrets.

The complete env-var table is in `agent-runtime/.env.example`.

## Code style

- **Prettier**: semi, 2-space tabs, 100 print width, single quotes, trailing commas.
- **ESLint**: unified root `.eslintrc.js` — TypeScript, Next.js, Prettier.
- **TypeScript**: strict; frontend uses `moduleResolution: bundler`; edge uses
  `moduleResolution: Bundler` + Cloudflare Workers types; shared uses
  CommonJS so it's consumable by both.

## Documentation pattern

Work is tracked in `documents/[TICKET-NUMBER]/`:

```
documents/FEAT-1/      # original LINE agent build (OpenAB + Gemini CLI — historical)
documents/FEAT-2/      # HF Spaces migration
documents/FEAT-3/      # MCP env / Langfuse follow-ups
documents/FEAT-4/      # Mastra rewrite — removed OpenAB, single TS process
documents/FEAT-5/      # removed Supabase — in-process stores + hardcoded config
documents/FIX-1/       # one-off fixes
documents/FIX-2/       # Gemini tool routing fix (superseded by FEAT-4)
documents/REFACTOR-1/  # deep-modules refactor (Worker + sidecar + frontend SSE)

Each folder has:
  plans/             # PRDs, design decisions, RFCs
  development/       # Step-by-step implementation guides
```

`FEAT-*` = new product/feature work. `FIX-*` = bug fixes. `REFACTOR-*` =
internal restructure with no user-visible behavior change.

## Internal module organization

Deep modules are grouped under subfolders so the ports are obvious at a
glance:

**Edge Worker (`edge/`):**
- `edge/src/line/` — LINE webhook ports (`signatureVerifier`,
  `webhookDedupStore`, `gatewayForwarder`, `blockedUserReplier`) + the
  `webhookHandler` factory that composes them.
- `edge/src/ports/` — outbound adapters (`sidecarClient`, `imageStore`).
- `edge/src/router.ts` — tiny path/method/CORS router used by `index.ts`.

**Agent runtime (`agent-runtime/src/`):**
- `src/agent/` — Mastra agent core (`runTurn`, `composeSystem`, provider routing).
- `src/line/` — LINE webhook handler, HMAC verifier, reply/push, replyToken store.
- `src/mcp/` — MCP subagent dispatch (`parentTools`, `subagentRunner`, `mcpClients`).
- `src/config/` — hardcoded agent config (`agentConfig`: system prompt, default
  model, feature flags). Replaced the Supabase `agent_config` table in FEAT-5.
- `src/store/` — in-process replacements for the old Supabase tables
  (`messageStore`, `memoryStore`, `skillStore`, `userStore`, `curatorRunStore`,
  `locks`). All state is per-container and resets on restart. Added in FEAT-5.
- `src/memory/` — Session-end memory extraction pipeline (5-gate trigger).
- `src/skills/` — Skill auto-creation pipeline.
- `src/observability/` — Event bus, ring buffer sink, SSE fan-out.
- `src/ports/` — healthz, image store upload.

**Frontend (`frontend/`):**
- `frontend/src/lib/sse/` — `parseSseStream` (pure) +
  `reconnectingSseStream` (reconnect/heartbeat loop) consumed by
  `hooks/useEventStream`.

When adding a new outbound dependency in edge: add a port under
`edge/src/ports/`. When adding a new module to agent-runtime: create a new
folder under `agent-runtime/src/` with a clear public interface.

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
  into `edge/wrangler.toml`, plus the Worker secrets are set via
  `wrangler secret put`).
- **Dashboard**: `npm run pages-deploy --workspace=frontend` (deploys
  `frontend/out/` to Cloudflare Pages project `ai-agent-dashboard`).
- **Container**: pushed to HF Spaces via GitHub Actions
  (`.github/workflows/hf-sync.yml`). The workflow syncs `agent-runtime/`
  contents to the HF Space repo on every push to `main`. The container
  builds TypeScript, installs Playwright + Chromium, and starts a single
  Node process on `:7860`.

See `documents/FEAT-4/development/cutover-execution.md` for the full
cutover playbook.
