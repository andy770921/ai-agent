# LINE AI Agent

A 24/7 personal AI agent reachable from LINE. The agent runs on Hugging Face
Spaces as a single Node.js process (Mastra + Vercel AI SDK), fronted by a
Cloudflare Worker for LINE webhook + image hosting + dashboard BFF, with a
static-export Next.js dashboard on Cloudflare Pages for live observability.

## Architecture

```
LINE Platform ──▶ Cloudflare Worker (edge/)  ──▶  HF Spaces container (agent-runtime/)
                  • LINE webhook + KV images        • Hono server on :7860
                  • Dashboard BFF (SSE + REST)       • Mastra agent (multi-provider)
                                                       ├─ task_browser (Playwright MCP)
                                                       ├─ task_github  (GitHub MCP)
                                                       └─ send_image   (LINE Push)
                                                     • In-process stores (no external DB)
                                                     • Langfuse (observability)
                              ▲
                              │ EventSource + REST
                              │
              Cloudflare Pages (frontend/) — /dashboard
```

## Workspaces

```
├── frontend/        # Next.js 15 — hosts the dashboard (Cloudflare Pages target)
├── shared/          # @repo/shared — AgentEvent, SessionSummary types
├── edge/            # Cloudflare Worker (TypeScript, Wrangler)
├── agent-runtime/   # Mastra agent container for HF Spaces (npm workspace)
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

# Agent-runtime tests:
cd agent-runtime && npx vitest run

# Build everything:
npm run build

# Build the dashboard for Cloudflare Pages:
npm run build:pages --workspace=frontend
```

## Configuration / Tokens

Tokens fall into three buckets. Each one lists where the value comes from
and where it has to be set.

### 1. Third-party tokens (fetch from external accounts)

| Token                       | Source                                                                                               | Where it goes                                                   |
| --------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `LINE_CHANNEL_SECRET`       | LINE Developers Console → your channel → **Basic settings**                                          | HF Space secret **and** the `edge/` Worker (as a secret)        |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Console → **Messaging API** tab → bottom → **Channel access token** → Issue                     | HF Space secret only                                            |
| `GEMINI_API_KEY`            | https://aistudio.google.com/apikey                                                                   | HF Space secret                                                 |
| `ANTHROPIC_API_KEY`         | https://console.anthropic.com/settings/keys (optional — only if using Claude)                        | HF Space secret                                                 |
| `OPENAI_API_KEY`            | https://platform.openai.com/api-keys (optional — only if using GPT-4o)                               | HF Space secret                                                 |
| `GITHUB_TOKEN`              | https://github.com/settings/tokens?type=beta — fine-grained PAT with **read** on all repos           | HF Space secret                                                 |
| `LINE_ALLOWED_USER_IDS`     | Capture `source.userId` from logs; comma-separated list (empty = allow all)                           | HF Space secret                                                 |

> Since FEAT-5 there is no Supabase / external database. Chat history,
> memories, skills, and the agent config all live in-process (see
> `agent-runtime/src/store/` and `src/config/`) and reset when the container
> restarts. The system prompt and default model are hardcoded constants in
> `src/config/agentConfig.ts`.

### 2. Self-generated tokens (random strings, ≥32 chars recommended)

Generate each one independently — for example with `openssl rand -hex 32`.

| Token                    | Purpose                                                                          | Set in                                                           |
| ------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `CF_UPLOAD_SECRET`       | Bearer the container uses when `PUT`ing images to the Worker's `/img/*` route    | **Both** HF Space secret and the `edge/` Worker (must match)     |
| `DASHBOARD_INGEST_TOKEN` | Bearer the Worker sends when proxying `/events/stream` + `/sessions`             | **Both** HF Space secret and the `edge/` Worker (must match)     |
| `DASHBOARD_TOKEN`        | Bearer the dashboard frontend sends on every `/api/*` Worker call                | `edge/` Worker only                                              |

### 3. Observability tokens (optional — Langfuse)

| Token                | Source                                                        | Where it goes    |
| -------------------- | ------------------------------------------------------------- | ---------------- |
| `LANGFUSE_SECRET_KEY`| Langfuse → project settings → API Keys (`sk-lf-...`)         | HF Space secret  |
| `LANGFUSE_PUBLIC_KEY`| Same page (`pk-lf-...`)                                      | HF Space secret  |
| `LANGFUSE_BASE_URL`  | Fixed per region: `https://jp.cloud.langfuse.com`             | HF Space secret  |

If these are not set, the agent runs without Langfuse (no error).

### 4. Post-deploy URLs

| Variable                            | File                          | Source of the real value                                                                         |
| ----------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------ |
| `WEBHOOK_DEDUP` `id` + `preview_id` | `edge/wrangler.toml`          | Run `wrangler kv:namespace create WEBHOOK_DEDUP` and the same command with `--preview` once each |
| `GATEWAY_BASE_URL`                  | `edge/wrangler.toml` `[vars]` | HF Spaces URL: `https://andy770921-ai-agent.hf.space`                                           |
| `SIDECAR_BASE_URL`                  | `edge/wrangler.toml` `[vars]` | Same HF Spaces URL                                                                              |
| `DASHBOARD_ORIGIN`                  | `edge/wrangler.toml` `[vars]` | The deployed Pages URL, e.g. `https://ai-agent-dashboard.pages.dev`                              |
| `CF_IMG_BASE_URL`                   | HF Space variable             | The Worker URL, e.g. `https://ai-agent-edge-server.<account>.workers.dev`                        |
| `NEXT_PUBLIC_WORKER_URL`            | `frontend/.env.local`         | Same as `CF_IMG_BASE_URL`                                                                        |

### Cloudflare resources to create up-front

- **KV namespace** `IMG_KV` for image hosting (24h TTL)
- **KV namespace** `WEBHOOK_DEDUP` for LINE webhook dedup
- **Cloudflare Pages project** `ai-agent-dashboard`

## Deploying

1. **Cloudflare**: create KV namespaces; `wrangler secret put` for
   each Worker secret; `wrangler deploy` from `edge/`.
2. **HF Spaces**: set all env vars as HF Space secrets;
   push `agent-runtime/` contents to the Space via GitHub Actions or manually.
   The container builds TypeScript and listens on `:7860`.
3. **LINE Console**: point the Messaging API webhook at
   `https://<worker>.workers.dev/line/webhook` and click Verify.
4. **Cloudflare Pages**: `npm run pages-deploy --workspace=frontend`.

See `documents/FEAT-4/development/cutover-execution.md` for the full
cutover playbook.

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
- **Cloudflare Workers** (free plan) — $0. 100,000 requests/day.
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

## Documentation

- `CLAUDE.md` — guidance for Claude Code working in this repo.
- `documents/FEAT-4/` — Mastra rewrite PRD + implementation plans (current architecture).
- `documents/FEAT-1/` — original LINE agent build (historical — OpenAB + Gemini CLI).
- `documents/FEAT-2/` — HF Spaces migration.
- `documents/FIX-2/` — Gemini tool routing fix (superseded by FEAT-4).
- `documents/REFACTOR-1/` — deep-modules refactor RFC.

## License

MIT
