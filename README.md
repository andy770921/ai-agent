# OpenAB LINE Agent

A 24/7 personal AI agent reachable from LINE. The agent runs on Hugging Face
Spaces, fronted by a Cloudflare Worker for LINE webhook + image hosting +
dashboard BFF, with a static-export Next.js dashboard on Cloudflare Pages for
live observability.

This repository was repurposed from a Next.js + NestJS fullstack boilerplate.
The original `backend/` workspace has been removed; the only Next.js role now
is to host the `/dashboard` views.

## Architecture

```
LINE Platform ──▶ Cloudflare Worker (edge/)  ──▶  HF Spaces container (agent-runtime/)
                  • LINE webhook + KV-hosted images       • openab-gateway  (LINE protocol)
                  • Dashboard BFF (SSE + REST)     • openab core     (ACP harness)
                                                   • gemini --acp    (per-session)
                                                     ├─ Playwright MCP
                                                     └─ GitHub MCP
                                                   • Node sidecar    (dashboard endpoints)
                                                   • hf-proxy.js     (:7860 reverse proxy)
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
├── agent-runtime/   # NOT a workspace — Docker build context for HF Spaces
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

| Token                       | Source                                                                                                                                                                              | Where it goes                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `LINE_CHANNEL_SECRET`       | LINE Developers Console → your channel → **Basic settings**                                                                                                                         | HF Space secret **and** the `edge/` Worker (as a secret)        |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Console → **Messaging API** tab → bottom → **Channel access token** → Issue                                                                                                    | HF Space secret only (forwarded to both gateway and agent)      |
| `GEMINI_API_KEY`            | https://aistudio.google.com/apikey                                                                                                                                                  | HF Space secret                                                 |
| `GITHUB_TOKEN`              | https://github.com/settings/tokens?type=beta — fine-grained PAT with **read** on all repos + `pull_requests:write` on a curated list; **no** `actions / administration / workflows` | HF Space secret                                                 |
| `LINE_ALLOWED_USER_IDS`     | Bootstrap with `*`; each of the ≤5 invited users scans the bot QR; capture `source.userId` from `wrangler tail` logs; replace `*` with the comma-separated list                     | HF Space secret **and** the `edge/` Worker (as a secret)        |

### 2. Self-generated tokens (random strings, ≥32 chars recommended)

Generate each one independently — for example with `openssl rand -hex 32` on
macOS / Linux.

| Token                    | Purpose                                                                                              | Set in                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `GATEWAY_TOKEN`          | Authenticates the WebSocket link between `openab` core and `openab-gateway`                          | HF Space secret only                                                         |
| `CF_UPLOAD_SECRET`       | Bearer the container uses when `PUT`ing screenshots to the Worker's `/img/*` route                   | **Both** HF Space secret and the `edge/` Worker (must match)                 |
| `DASHBOARD_INGEST_TOKEN` | Bearer the Worker sends when proxying `/events/stream` + `/sessions` to the Node sidecar             | **Both** HF Space secret and the `edge/` Worker (must match)                 |
| `DASHBOARD_TOKEN`        | Bearer the dashboard frontend pastes into `/dashboard/login` and sends on every `/api/*` Worker call | `edge/` Worker only (kept distinct from `DASHBOARD_INGEST_TOKEN` on purpose) |
| `HF_SPACE`               | Set to `1` to enable the reverse proxy on `:7860`                                                    | HF Space secret only                                                         |

### 3. Post-deploy URLs (placeholder during build, real value after each service is up)

| Variable                            | File                          | Source of the real value                                                                         |
| ----------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `WEBHOOK_DEDUP` `id` + `preview_id` | `edge/wrangler.toml`          | Run `wrangler kv:namespace create WEBHOOK_DEDUP` and the same command with `--preview` once each |
| `GATEWAY_BASE_URL`                  | `edge/wrangler.toml` `[vars]` | HF Spaces URL: `https://andy770921-ai-agent.hf.space`                                           |
| `SIDECAR_BASE_URL`                  | `edge/wrangler.toml` `[vars]` | Same HF Spaces URL (single-port proxy routes by path)                                           |
| `DASHBOARD_ORIGIN`                  | `edge/wrangler.toml` `[vars]` | The deployed Pages URL, e.g. `https://ai-agent-dashboard.pages.dev`                              |
| `CF_IMG_BASE_URL`                   | HF Space secret               | The Worker URL printed by `wrangler deploy`, e.g. `https://ai-agent-edge-server.<account>.workers.dev` |
| `NEXT_PUBLIC_WORKER_URL`            | `frontend/.env.local`         | Same as `CF_IMG_BASE_URL`                                                                        |

### Cloudflare resources to create up-front (not tokens but prerequisites)

- **KV namespace** `IMG_KV` for screenshot hosting (24h TTL) — created with `wrangler kv:namespace create IMG_KV`. We use KV instead of R2 to keep the deploy credit-card-free; see `documents/FEAT-1/development/cloudflare-webhook.md` for the trade-offs.
- **KV namespace** `WEBHOOK_DEDUP` for LINE webhook dedup — created with `wrangler kv:namespace create WEBHOOK_DEDUP`.
- **Cloudflare Pages project** `ai-agent-dashboard` — auto-created on the first `npm run pages-deploy --workspace=frontend`.

## Deploying

The deploy sequence and live verification steps live in
`documents/FEAT-1/development/phase0-e2e-spike-runbook.md`. At a glance:

1. **Cloudflare**: create KV namespaces (`WEBHOOK_DEDUP` + `IMG_KV`); `wrangler secret put` for
   each Worker secret; `wrangler deploy` from `edge/`.
2. **HF Spaces**: set all env vars as HF Space secrets (including `HF_SPACE=1`);
   push `agent-runtime/` contents to the Space via GitHub Actions or manually.
   The container exposes `:7860` (reverse proxy → gateway `:8080` + sidecar `:8081`).
3. **LINE Console**: point the Messaging API webhook at
   `https://<worker>.workers.dev/line/webhook` and click Verify.
4. **Cloudflare Pages**: `npm run pages-deploy --workspace=frontend` (set
   `NEXT_PUBLIC_WORKER_URL` first).

## CI/CD

GitHub Actions (`.github/workflows/hf-sync.yml`) handles:

- **Auto-sync**: on push to `main` touching `agent-runtime/**`, copies the
  directory contents to the HF Space git repo → triggers a Docker rebuild.
- **Keep-alive**: cron every 12 hours pings the Space URL to prevent the
  48-hour idle sleep.

Requires `HF_TOKEN` as a GitHub Actions secret (generate at
huggingface.co/settings/tokens with `write` permission).

## Costs

Fixed cost: **$0/mo** — fully free-tier stack.

- **Hugging Face Spaces** (Docker, `cpu-basic`) — $0. 2 vCPU / 16 GB RAM.
- **Cloudflare Workers** (free plan) — $0. The 10 ms limit is **CPU execution
  time only**; I/O waiting (including SSE streaming) does not count. A
  passthrough SSE proxy typically uses < 2 ms CPU per request, well within the
  limit. Key free-tier constraints:
  - 100,000 requests/day (each new SSE connection = 1 request; long-lived
    connections staying open are fine)
  - KV: 1 GB storage, 100k reads/day, 1k writes/day
- **Cloudflare Pages** — $0. Static export hosting, unlimited requests.

## Claude Code commands

Slash commands live under `.claude/commands/`. Use the ticket ID in place of
`[TICKET]` (e.g. `FEAT-1`).

| Command                                   | Description                             |
| ----------------------------------------- | --------------------------------------- |
| `/write-a-prd [TICKET]`                   | Create a PRD through systematic discovery |
| `/grill-me [TICKET]`                      | Stress-test a plan through questioning  |
| `/tdd [TICKET]`                           | Implement with test-driven development  |
| `/triage-issue [TICKET]`                  | Investigate bugs and create fix plans   |
| `/improve-codebase-architecture [TICKET]` | Find architectural improvements         |
| `/deploy-vercel [TICKET]`                 | Deploy to Vercel (legacy)               |

## Documentation

- `CLAUDE.md` — guidance for Claude Code working in this repo.
- `documents/FEAT-1/plans/prd.md` — product requirements.
- `documents/FEAT-1/development/*.md` — implementation plans + the upstream-verification findings file.
- `documents/FEAT-2/plans/prd.md` — HF Spaces migration PRD.
- `documents/FEAT-2/development/hf-spaces-migration.md` — migration implementation guide.

## License

MIT
