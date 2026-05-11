# OpenAB LINE Agent (FEAT-1)

A 24/7 personal AI agent reachable from LINE. The agent runs on Northflank,
fronted by a Cloudflare Worker for LINE webhook + image hosting + dashboard
BFF, with a static-export Next.js dashboard on Cloudflare Pages for live
observability.

This repository was repurposed from a Next.js + NestJS fullstack boilerplate.
The original `backend/` workspace has been removed; the only Next.js role now
is to host the `/dashboard` views.

## Architecture

```
LINE Platform ──▶ Cloudflare Worker (edge/)  ──▶  Northflank container (agent-runtime/)
                  • LINE webhook + R2 images       • openab-gateway  (LINE protocol)
                  • Dashboard BFF (SSE + REST)     • openab core     (ACP harness)
                                                   • gemini --acp    (per-session)
                                                     ├─ Playwright MCP
                                                     └─ GitHub MCP
                                                   • Node sidecar    (dashboard endpoints)
                                ▲
                                │ EventSource + REST
                                │
                Cloudflare Pages (frontend/) — /dashboard
```

See `documents/FEAT-1/plans/prd.md` for the full PRD and
`documents/FEAT-1/development/openab-upstream-findings.md` for the canonical
upstream truths the design was reconciled against.

## Workspaces

```
├── frontend/        # Next.js 15 — hosts the dashboard (Cloudflare Pages target)
├── shared/          # @repo/shared — AgentEvent, SessionSummary types
├── edge/            # Cloudflare Worker (TypeScript, Wrangler)
├── agent-runtime/   # NOT a workspace — Docker build context for Northflank
├── documents/       # Per-ticket plans + development docs
└── .claude/         # Claude Code commands
```

## Quick start

```bash
npm install                          # install workspace deps

# Run the dashboard frontend locally:
npm run dev --workspace=frontend     # http://localhost:3001

# Local Worker dev (after `cp edge/.dev.vars.example edge/.dev.vars`):
npm run dev --workspace=@repo/edge   # wrangler dev

# Worker unit tests:
npm run test --workspace=@repo/edge

# Build everything (TypeScript + dry-run wrangler deploy):
npm run build

# Build the dashboard for Cloudflare Pages:
npm run build:pages --workspace=frontend
```

## Configuration / Tokens

Tokens fall into three buckets. Each one lists where the value comes from
and where it has to be set.

### 1. Third-party tokens (fetch from external accounts)

| Token                       | Source                                                                                                                                                                                | Where it goes                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `LINE_CHANNEL_SECRET`       | LINE Developers Console → your channel → **Basic settings**                                                                                                                          | `agent-runtime/.env` **and** the `edge/` Worker (as a secret)  |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Console → **Messaging API** tab → bottom → **Channel access token** → Issue                                                                                                     | `agent-runtime/.env` only (forwarded to both gateway and agent) |
| `GEMINI_API_KEY`            | https://aistudio.google.com/apikey — ⚠️ **revoke the key that was previously pasted into chat and generate a fresh one** before deploying                                            | `agent-runtime/.env`                                            |
| `GITHUB_TOKEN`              | https://github.com/settings/tokens?type=beta — fine-grained PAT with **read** on all repos + `pull_requests:write` on a curated list; **no** `actions / administration / workflows` | `agent-runtime/.env`                                            |
| `LINE_ALLOWED_USER_IDS`     | Bootstrap with `*`; each of the ≤5 invited users scans the bot QR; capture `source.userId` from `wrangler tail` logs; replace `*` with the comma-separated list                       | `agent-runtime/.env` **and** the `edge/` Worker (as a secret)  |

### 2. Self-generated tokens (random strings, ≥32 chars recommended)

Generate each one independently — for example with `openssl rand -hex 32` on
macOS / Linux.

| Token                    | Purpose                                                                                                | Set in                                                                       |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `GATEWAY_TOKEN`          | Authenticates the WebSocket link between `openab` core and `openab-gateway`                            | `agent-runtime/.env` only                                                    |
| `CF_UPLOAD_SECRET`       | Bearer the container uses when `PUT`ing screenshots to the Worker's `/img/*` route                     | **Both** `agent-runtime/.env` and the `edge/` Worker (must match)             |
| `DASHBOARD_INGEST_TOKEN` | Bearer the Worker sends when proxying `/events/stream` + `/sessions` to the Node sidecar               | **Both** `agent-runtime/.env` and the `edge/` Worker (must match)             |
| `DASHBOARD_TOKEN`        | Bearer the dashboard frontend pastes into `/dashboard/login` and sends on every `/api/*` Worker call   | `edge/` Worker only (kept distinct from `DASHBOARD_INGEST_TOKEN` on purpose) |

### 3. Post-deploy URLs (placeholder during build, real value after each service is up)

| Variable                          | File                            | Source of the real value                                                                          |
| --------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------- |
| `WEBHOOK_DEDUP` `id` + `preview_id` | `edge/wrangler.toml`            | Run `wrangler kv:namespace create WEBHOOK_DEDUP` and the same command with `--preview` once each |
| `GATEWAY_BASE_URL`                | `edge/wrangler.toml` `[vars]`   | Public URL of the Northflank container's port 8080 (openab-gateway)                              |
| `SIDECAR_BASE_URL`                | `edge/wrangler.toml` `[vars]`   | Public URL of the Northflank container's port 8081 (Node sidecar)                                |
| `DASHBOARD_ORIGIN`                | `edge/wrangler.toml` `[vars]`   | The deployed Pages URL, e.g. `https://openab-dashboard.pages.dev`                                |
| `CF_IMG_BASE_URL`                 | `agent-runtime/.env`            | The Worker URL printed by `wrangler deploy`, e.g. `https://openab-line-edge.<account>.workers.dev` |
| `NEXT_PUBLIC_WORKER_URL`          | `frontend/.env.local`           | Same as `CF_IMG_BASE_URL`                                                                         |

### Cloudflare resources to create up-front (not tokens but prerequisites)

- **R2 bucket** `openab-line-images` — create with `wrangler r2 bucket create openab-line-images`.
- **Cloudflare Pages project** `openab-dashboard` — auto-created on the first `npm run pages-deploy --workspace=frontend`.

## Deploying

The deploy sequence and live verification steps live in
`documents/FEAT-1/development/phase0-e2e-spike-runbook.md`. At a glance:

1. **Cloudflare**: create R2 bucket + KV namespace; `wrangler secret put` for
   each Worker secret; `wrangler deploy` from `edge/`.
2. **Northflank**: configure the secrets listed in
   `agent-runtime/.northflank/service.yaml`; trigger a Docker build of
   `agent-runtime/`. The container exposes ports 8080 (gateway) + 8081
   (sidecar).
3. **LINE Console**: point the Messaging API webhook at
   `https://<worker>.workers.dev/line/webhook` and click Verify.
4. **Cloudflare Pages**: `npm run pages-deploy --workspace=frontend` (set
   `NEXT_PUBLIC_WORKER_URL` first).

## Costs

Fixed cost target ~$29/mo:

- Northflank `nf-compute-100-2` (1 dedicated vCPU / 2 GB) — ~$24/mo. The
  smaller shared-vCPU SKUs OOM under Chromium.
- Cloudflare Workers Paid plan — $5/mo. The free tier's 10 ms CPU limit
  blocks the long-lived SSE proxy used by the dashboard.

## Claude Code commands

Slash commands live under `.claude/commands/`. Use the ticket ID in place of
`[TICKET]` (e.g. `FEAT-1`).

| Command                                   | Description                                 |
| ----------------------------------------- | ------------------------------------------- |
| `/write-a-prd [TICKET]`                   | Create a PRD through systematic discovery   |
| `/grill-me [TICKET]`                      | Stress-test a plan through questioning      |
| `/tdd [TICKET]`                           | Implement with test-driven development      |
| `/triage-issue [TICKET]`                  | Investigate bugs and create fix plans       |
| `/improve-codebase-architecture [TICKET]` | Find architectural improvements             |
| `/deploy-vercel [TICKET]`                 | Deploy to Vercel (legacy; FEAT-1 deploys to Northflank + Cloudflare) |

## Documentation

- `CLAUDE.md` — guidance for Claude Code working in this repo.
- `documents/FEAT-1/plans/prd.md` — product requirements.
- `documents/FEAT-1/development/*.md` — implementation plans + the upstream-verification findings file.

## License

MIT
