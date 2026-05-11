# PRD: FEAT-1 — LINE-Driven LLM Agent on Northflank (OpenAB + Gemini + Playwright + GitHub) + Live Dashboard

> **Status note:** The previous `FEAT-1` ("init-fullstack-project") was retired before this work began (see `git status` showing those files deleted). This PRD reuses `FEAT-1` for the new initiative.

> **Naming clarification:** "Cloudinary" in the original brief is read as a typo for **Cloudflare**. All image hosting in this PRD is on Cloudflare via the same Cloudflare Worker that proxies LINE webhooks. The original plan targeted Cloudflare R2; during the live deploy we switched to **Cloudflare Workers KV** because R2 requires a credit card on file. KV's free tier (1 GB storage, 25 MB per value, 24h `expirationTtl` native) comfortably fits ≤5-user screenshot traffic. See `documents/FEAT-1/development/cloudflare-webhook.md` → "Why KV instead of R2" for the trade-off and the migration path back to R2 if usage outgrows KV.

## Problem Statement

I want a **personal AI agent that I can talk to from LINE** at any time, day or night. It should be able to:

1. Read text I send on LINE and act on it.
2. **Read my GitHub repos** and **comment on / open PRs** when I ask.
3. **Drive a real browser** (e.g., navigate to a URL and screenshot it) and **send the screenshot back to me on LINE**.
4. Stay online 24/7 without me running anything on my laptop.
5. **(v1.5)** Let me open a web page on my laptop that **shows me what the agent is doing in real time** — which user is talking to it, which sub-agents (MCP tools) it's calling, and what it just replied. This is critical because LINE alone hides the agent's reasoning.

Owning a server, wiring a custom Slack/Discord bot, or shipping my own ACP harness is too much yak-shaving. [OpenAB](https://github.com/openabdev/openab) already solves the chat ↔ coding-agent bridge (LINE is supported via its Custom Gateway), so the work is mostly **deployment + config + glue**, not net-new code.

## Solution Overview

End-to-end flow (single platform on the edge: **everything that's not Northflank is Cloudflare**). The topology has been corrected per `documents/FEAT-1/development/openab-upstream-findings.md` — OpenAB is two binaries, not one, and we run both inside the single Northflank container as separate processes.

```
                                 ┌────────────────────────────────────────────────┐
                                 │              Northflank (24/7)                 │
LINE app  ─►  LINE Platform ──►  │  agent-runtime container (3 processes):        │
   ▲         (Messaging API)     │   • openab-gateway (:8080)                     │
   │                             │     - LINE webhook + HMAC verify               │
   │   image reply               │     - hybrid replyToken/Push dispatch (50s)    │
   │   (https URL via Push API)  │   • openab core (Rust ACP harness)             │
   │                             │     ↕ WebSocket on 127.0.0.1:8080/ws           │
   │                             │     ↓ spawns one Gemini CLI per session        │
   │                             │   • gemini --acp (Node, JSON-RPC over stdio)   │
   │                             │     ├─ MCP: Playwright (Chromium)              │
   │                             │     └─ MCP: GitHub (PAT)                       │
   │                             │   • Node sidecar (:8081)                       │
   │                             │     - /healthz, /events/stream, /sessions      │
   │                             │     - tails $GEMINI_TELEMETRY_OUTFILE          │
   │                             │   • Persistent volume: ACP sessions            │
   │                             └──────────────────▲─────────────────────────────┘
   │                                                │ HTTPS to :8080 and :8081
   │                                                │
   │   ┌────────────────────────────────────────────┴───────────────────────┐
   │   │            Cloudflare (free tier — single account)                 │
   └───┤  edge/ — ONE Worker doing everything edge-side:                    │
       │    • POST /line/webhook                  (LINE → gateway :8080)    │
       │    • PUT  /img/:id  (auth)               (container → IMG_KV)     │
       │    • GET  /img/:id                       (IMG_KV → LINE CDN)      │
       │    • GET  /api/sessions/stream  (SSE)    ◄── proxies sidecar :8081 │
       │    • GET  /api/sessions                  ◄── proxies sidecar :8081 │
       │    • GET  /api/sessions/:userId/history  ◄── proxies sidecar :8081 │
       │  + KV namespace IMG_KV: 24h TTL screenshots (native expirationTtl) │
       │  + KV namespace: webhookEventId dedup, 10 min TTL                  │
       │                                                                    │
       │  frontend/ — Cloudflare Pages (static export)                      │
       │    • /dashboard                                                    │
       │      - live event feed (EventSource-over-fetch)                    │
       │      - per-session timeline                                        │
       │      - sub-agent (MCP) view                                        │
       └────────────────────────────────────────────────────────────────────┘
```

**Note on single-container deviation from upstream.** OpenAB's Helm chart pattern runs `openab-gateway` and `openab` core in **separate pods**. We bundle them into one container as a deliberate v1 cost optimisation (one Northflank `nf-compute-100-2` slot at ~$24/mo vs. two at ~$48/mo). The processes communicate over loopback WebSocket inside the pod. Documented in `northflank-container.md` Step 5 with a v2 path to split them.

**Why this shape:**

- **OpenAB** does all the hard work of multiplexing chat → ACP coding-agent CLI. We avoid writing our own bot.
- **Gemini CLI** (Google's official ACP-compatible CLI) plugs into OpenAB and natively supports MCP servers, which is how Playwright and GitHub access are added.
- **Single Northflank container** keeps cost as low as Chromium 24/7 allows. The previous draft cited `nf-compute-20` as "1 vCPU / 2 GB ~$13/mo" — that was wrong (per `plans/review.md` finding #4): Northflank's `nf-compute-20` is 0.2 shared vCPU / 512 MB / ~$5.40/mo, which will OOM the instant Chromium launches. The smallest SKU that meets the memory budget is `nf-compute-100-2` (1 dedicated vCPU / 2 GB) at ~$24/mo. Original <$10/mo target is therefore not achievable with Chromium 24/7. Revised cost estimate: **~$29/mo** ($24 Northflank + $5 Cloudflare Workers Paid plan for SSE). Splitting Playwright into a sidecar would double container cost.
- **Single Cloudflare Worker** absorbs LINE webhook proxying, KV-backed image hosting (`IMG_KV` namespace), AND the dashboard BFF (SSE proxy + REST proxies). One TypeScript codebase, one deploy, one bearer-token auth model. The boilerplate's existing `backend/` (NestJS / Vercel) is **not used** for FEAT-1; it stays in the repo for future features.
- **Cloudflare Pages** hosts the Next.js dashboard as a **static export** (`output: 'export'`). The dashboard is client-driven (EventSource + auth'd `fetch`), so it does not need SSR or serverless functions; static-on-Pages is the cheapest, fastest path. Single Cloudflare account = single billing/observability for everything that's not Northflank.

## Repository Topology

This whole feature lives in **the existing monorepo** (`claude-code-fullstack-boilerplate/`). We do **not** create a separate repo. Rationale: shared TypeScript types reach the frontend, backend, and edge worker without publishing a package; one CI configuration covers everything; deployment per workspace is independent.

```
claude-code-fullstack-boilerplate/
├── frontend/             # Next.js 15 — REPURPOSED as the dashboard.
│                         # Build: `next build && next export` (output: 'export').
│                         # Deploy: Cloudflare Pages (NOT Vercel for FEAT-1).
│                         # vercel.json stays for future features but is unused here.
├── backend/              # UNUSED for FEAT-1.
│                         # The dashboard BFF role is absorbed by the edge Worker.
│                         # This package stays in the repo for future features.
├── shared/               # @repo/shared — extend with AgentEvent, SessionSummary types
│                         # (consumed by frontend AND edge worker).
├── agent-runtime/        # NEW — Dockerfile + OpenAB config + Gemini settings + scripts
│   ├── Dockerfile
│   ├── config/openab.toml
│   ├── gemini/
│   │   ├── settings.json
│   │   ├── system.md
│   │   └── policies/feat1.toml         # Policy Engine TOML (tool allowlist)
│   ├── scripts/
│   │   ├── entrypoint.sh
│   │   ├── render-config.sh
│   │   ├── healthz.js                  # /healthz + /events/stream + /sessions
│   │   ├── events-emitter.js           # tails $GEMINI_TELEMETRY_OUTFILE
│   │   ├── post-screenshot.sh
│   │   └── send-line-image.sh
│   └── .northflank/service.yaml
├── edge/                 # NEW — ONE Cloudflare Worker:
│   │                     #   • LINE webhook + KV-hosted images (v1)
│   │                     #   • dashboard BFF: SSE proxy + REST (v1.5)
│   ├── wrangler.toml
│   ├── src/
│   │   ├── index.ts
│   │   ├── lineWebhook.ts
│   │   ├── imageUpload.ts
│   │   ├── imageServe.ts
│   │   ├── allowlist.ts
│   │   ├── auth.ts
│   │   ├── dashboardSse.ts
│   │   └── dashboardRest.ts
│   └── test/
├── documents/FEAT-1/     # PRD + plans
├── package.json          # add edge/ to workspaces (agent-runtime is NOT a workspace)
└── turbo.json            # add edge:dev, edge:deploy, frontend:pages-deploy targets
```

**Workspace note:** `agent-runtime/` is **not** an npm workspace — it's a Docker build context with a Rust binary baked in. `edge/` IS a workspace (TypeScript, depends on `@repo/shared`). `frontend/` stays a workspace; only its deploy target changes (Cloudflare Pages instead of Vercel for FEAT-1). `backend/` remains a workspace untouched — unused by FEAT-1, kept for future features.

## User Stories

1. **As me**, I want to send `summarize the latest open PR on shopback/foo` from LINE and get back a Gemini-generated summary, **so that** I can triage on my phone without opening a laptop.
2. **As me**, I want to send `screenshot https://example.com` from LINE and receive the rendered homepage as a LINE image, **so that** I can verify a deploy or visually inspect a site from anywhere.
3. **As me**, I want to send a multi-turn conversation (e.g., reply "now open the PR with the suggested fix") and have the agent remember what it did 30 seconds ago, **so that** I can refine instructions naturally.
4. **As an invited user (≤5 people)**, I want my LINE userId allowlisted, **so that** I can use the bot but random strangers cannot.
5. **As me**, I want the agent to be able to **comment on or open PRs** in my repos, but **never push to `main` directly**, **so that** I keep human-in-the-loop control of merges.
6. **As me**, I want the bot to **survive a Northflank container restart** without losing my conversation thread, **so that** redeploys don't break in-flight work.
7. **(v1.5) As me**, I want to open `/dashboard` in my laptop browser and **see a live feed** of who is messaging the bot right now, what tools the agent is calling (e.g. "Playwright→navigate", "GitHub→list_pulls"), and the final reply that went back to LINE — **so that** I can debug bad replies, watch costs, and see when the agent is stuck.
8. **(v1.5) As me**, I want to **drill into a single LINE userId's session** and see a chronological timeline (LINE message in → MCP tool call → tool result → Gemini reply text → LINE message out) with timestamps and durations, **so that** I can post-mortem any weird interaction.

## Non-Goals (Out of Scope)

- **Multi-tenant SaaS / public bot.** Strictly allowlisted, ≤5 users.
- **Self-hosting an LLM model.** We use Gemini's hosted API, not vLLM/Ollama. ("24hr hosting LLM" in the original brief means hosting the *agent runtime* 24/7, not the model weights.)
- **Voice messages, image inputs, file uploads.** OpenAB supports STT but configuring it is out of scope for v1.
- **PR merging or any write to `main`.** Only `pull_requests:write` on selected repos; never push to default branches.
- **Cross-conversation state between users.** Each LINE userId has its own isolated session.
- **Persistent browser sessions** (e.g., logged-in scraping). Playwright runs ephemeral, fresh-context-per-task. No cookie jar persisted.
- **Building Hermes-Agent / Supabase-backed memory.** Tracked as a follow-up feature; v1 uses Northflank's persistent volume only.
- **Dashboard auth via SSO.** The dashboard uses a single shared bearer token in v1.5 (single user). Multi-user dashboard auth is v2.
- **Dashboard write actions** (kill session, delete history, send a manual reply). v1.5 is read-only.

## Implementation Decisions

### Modules (deep modules, listed in dependency order)

| # | Module | Folder | Owns | Interface (in / out) | Phase |
|---|--------|--------|------|----------------------|-------|
| 1 | **agent-runtime container** | `agent-runtime/` | The single Docker image running `openab-gateway` + `openab` core + Gemini CLI + Chromium + Playwright MCP + Node sidecar. Two HTTP-listening processes (`:8080` gateway, `:8081` sidecar) plus the agent subtree. Sources dashboard events from `$GEMINI_TELEMETRY_OUTFILE`. | In: HTTPS POST from CF Worker (gateway side); HTTPS from CF Worker (sidecar dashboard endpoints). Out: LINE Messaging API; outbound HTTPS to Gemini, GitHub, target browser pages. | v1 + v1.5 |
| 2 | **OpenAB Config** | `agent-runtime/config/` | TOML config wiring LINE Custom Gateway to Gemini agent. | In: env vars. Out: spawns Gemini CLI processes. | v1 |
| 3 | **Gemini CLI Tools** | `agent-runtime/gemini/` | MCP-server wiring: Playwright + GitHub. | In: `settings.json`, `GITHUB_TOKEN`, `GEMINI_API_KEY`. Out: tool calls. | v1 |
| 4 | **Cloudflare Edge Worker** | `edge/` | (v1) LINE webhook signature verify + allowlist + forward; image upload (auth) + serve (public). (v1.5) Dashboard BFF: SSE proxy + REST proxies, all auth-gated. | In: LINE webhook, container PUT, dashboard fetch. Out: HTTPS to Northflank, KV reads/writes (`IMG_KV` for images, `WEBHOOK_DEDUP` for idempotency), SSE to frontend. | v1 + v1.5 |
| 5 | **LINE Channel Setup** | (LINE Console) | LINE Messaging API channel: webhook URL config, channel secret/token, allowlist. | In: messages. Out: API calls from container. | v1 |
| 6 | **Shared Types** | `shared/src/types/` | `AgentEvent`, `SessionSummary`, `McpToolCall` — the contract between agent-runtime, edge Worker, and frontend. | Type-only. | v1.5 |
| 7 | **Dashboard UI** | `frontend/` | Next.js (static-export) page at `/dashboard` showing live event feed + per-session timeline. Deployed on **Cloudflare Pages**. | In: SSE + REST from edge Worker. Out: human eyeballs. | v1.5 |

> ⓘ The "Dashboard BFF" originally listed as module #7 has been **collapsed into the edge Worker (module #4)**. The boilerplate's `backend/` (NestJS) is unused by FEAT-1.

### Architecture Decisions

- **Single container for v1.** Chromium + Rust + Node Gemini CLI in one image. ~1.2 GB image. Steady-state RAM ~700 MB idle, ~1.4 GB peak with one Playwright session. Northflank SKUs below `nf-compute-100-2` (1 dedicated vCPU / 2 GB / ~$24/mo) — including `nf-compute-20` (0.2 shared vCPU / 512 MB) and `nf-compute-50` (0.5 vCPU / 1 GB) — will OOM under Playwright; see Risks.
- **Gemini CLI as the ACP backend** (not Claude Code, Codex, etc.) because the user explicitly chose Gemini and because Google AI Studio's free tier is sufficient for ≤5 personal users.
- **Persistent storage = Northflank volume mount** at `/var/lib/openab/sessions`. v2 will migrate this to Supabase or a Hermes-Agent-backed store.
- **Cloudflare Worker as the public edge.** Northflank's container public URL is reachable but unprotected; putting a Worker in front gives us free signature-verification and allowlist enforcement without adding a paid WAF.
- **Image replies via Cloudflare KV + Worker route.** LINE's `image` message type requires `originalContentUrl` and `previewImageUrl` to be public HTTPS URLs (base64 / data: URIs are rejected by LINE), so the screenshot must live at some Cloudflare-hosted URL. We host the bytes in the `IMG_KV` namespace with `expirationTtl: 86400`. R2 would have been the canonical choice but was skipped to keep the deploy credit-card-free; see `cloudflare-webhook.md` for the migration path back to R2.
- **GitHub auth = fine-grained PAT** stored in Northflank secret. Read-only on all repos owned by the user + `pull_requests:write` on a selected list.
- **No multi-region.** Single Northflank region, single Worker. Latency from LINE Tokyo → CF edge → Northflank acceptable for chat.

### Decisions Specific to the Dashboard (v1.5)

- **Real-time transport = SSE, not WebSocket.** Cloudflare Workers natively support long-lived streaming responses; SSE is "just" a `Response` whose body is a never-closing `ReadableStream`. WebSocket support exists too but is unnecessary complexity for one-way live updates.
- **Event source of truth = Gemini CLI telemetry file.** Gemini CLI writes JSON-line events to `$GEMINI_TELEMETRY_OUTFILE` when `GEMINI_TELEMETRY_ENABLED=true GEMINI_TELEMETRY_TARGET=local` (documented in `node_modules/@google/gemini-cli/bundle/docs/cli/acp-mode.md`). A small Node sidecar in `agent-runtime/scripts/healthz.js` + `events-emitter.js` tails the file, reshapes each event into the canonical `AgentEvent` contract, and re-emits on `GET /events/stream` as SSE. We pick this over OpenAB stdout (textual `tracing` logs, no documented JSON channel) or a separate Redis/NATS bus because: (a) free, (b) no extra infrastructure, (c) Gemini-native, no upstream patches, (d) "events that survive restart" is explicitly **not** a requirement — dashboard shows live + recent history only.
- **History query = read the persistent volume.** The Worker's `GET /api/sessions/:userId/history` is a thin proxy of the container's `/sessions/:userId/history` endpoint exposed by the same Node sidecar. **Tradeoff:** ties dashboard history to the Northflank container being up. Acceptable for v1.5; v2 (Supabase/Hermes) decouples this.
- **Auth for the dashboard = single shared bearer token.** The user pastes the token into a `/dashboard/login` field on first visit; it's stored in `localStorage`. The Worker validates against `DASHBOARD_TOKEN` (set via `wrangler secret put`). The Worker uses a *separate* `DASHBOARD_INGEST_TOKEN` to talk to the container — so a leaked frontend token doesn't grant direct container access.
- **Frontend deploy = Cloudflare Pages.** `next build && next export` produces a static site (`output: 'export'` in `next.config.js`). Deploy via `wrangler pages deploy out/` or via Pages' Git integration. No serverless functions on Pages — all dynamic behavior lives client-side and talks to the Worker.
- **Backend deploy = none.** The boilerplate's `backend/` is not deployed for FEAT-1.

### APIs / Interfaces

#### A. LINE → Cloudflare Worker → openab-gateway

```
LINE → POST https://<edge>.workers.dev/line/webhook
       (X-Line-Signature: HMAC-SHA256(channelSecret, body))
Worker (verifies HMAC, KV-dedupes, fast-fail allowlist)
       → POST https://<container>.northflank.app/webhook/line
         X-Line-Signature: <forwarded unchanged>
         idempotency-key: <webhookEventId>
openab-gateway re-verifies HMAC against the raw body (authoritative check),
then forwards via outbound WebSocket on 127.0.0.1:8080/ws to openab core.
```

#### B. openab-gateway → LINE outbound (text replies)

`POST https://api.line.me/v2/bot/message/{reply,push}` — handled inside `openab-gateway` with the hybrid Reply/Push strategy (50 s replyToken cache, see ADR `line-adapter.md`). Image messages are sent **directly from the agent** via `send-line-image.sh` calling LINE Push API (OpenAB does not relay images).

#### C. Screenshot upload (existing)

```
PUT https://<edge>.workers.dev/img/<uuid>.png
Headers: Authorization: Bearer <CF_UPLOAD_SECRET>, Content-Type: image/png
```

#### D. agent-runtime → edge Worker (live events, NEW v1.5)

```
GET https://<container>.northflank.app/events/stream
Headers: Authorization: Bearer <DASHBOARD_INGEST_TOKEN>
Accept: text/event-stream

# Server emits one SSE event per JSON line. Event types:
event: message_in
data: {"sessionUserId":"U123","ts":"2026-05-08T10:00:00Z","text":"summarize PR #42"}

event: tool_call
data: {"sessionUserId":"U123","ts":"...","tool":"github.list_pulls","args":{...}}

event: tool_result
data: {"sessionUserId":"U123","ts":"...","tool":"github.list_pulls","durationMs":420,"ok":true}

event: message_out
data: {"sessionUserId":"U123","ts":"...","text":"...","kind":"text|image","imageUrl":"..."}
```

The Worker also calls `GET /sessions` and `GET /sessions/:userId/history` on the same container with the same `DASHBOARD_INGEST_TOKEN`.

#### E. edge Worker → Frontend (NEW, v1.5)

```
GET /api/sessions/stream                     # SSE proxy of (D), live events
GET /api/sessions                             # list active sessions {userId, lastSeen, msgCount}
GET /api/sessions/:userId/history?limit=50    # recent events for a user
```

All require `Authorization: Bearer <DASHBOARD_TOKEN>`. **Note:** `DASHBOARD_TOKEN` (frontend ↔ Worker) and `DASHBOARD_INGEST_TOKEN` (Worker ↔ container) are intentionally **different** so a leaked frontend token cannot directly poke the Northflank container.

#### F. Shared types (NEW, v1.5)

`shared/src/types/agent-events.ts`:

```ts
export type AgentEventBase = {
  sessionUserId: string;
  ts: string;
};
export type AgentMessageIn  = AgentEventBase & { type: 'message_in'; text: string };
export type AgentToolCall   = AgentEventBase & { type: 'tool_call'; tool: string; args: unknown };
export type AgentToolResult = AgentEventBase & { type: 'tool_result'; tool: string; durationMs: number; ok: boolean; error?: string };
export type AgentMessageOut = AgentEventBase & { type: 'message_out'; text: string; kind: 'text' | 'image'; imageUrl?: string };
export type AgentEvent = AgentMessageIn | AgentToolCall | AgentToolResult | AgentMessageOut;

export type SessionSummary = {
  userId: string;
  lastSeen: string;
  msgCount: number;
  lastEvent?: AgentEvent;
};
```

These are imported by both `frontend/` and `backend/`.

### Module: Per-user session keying

Sessions are keyed by **LINE `userId`** (a stable per-channel identifier from LINE). Multi-turn context works; different invited users get isolated sessions; we do not key by LINE `groupId` in v1.

## Testing Strategy

### Manual end-to-end smoke (gating release)

| # | Test | Phase | Expected |
|---|------|-------|----------|
| 1 | Send `ping` from a non-allowlisted LINE account. | v1 | No reply. Worker logs the dropped event. |
| 2 | Send `ping` from the owner's LINE account. | v1 | Gemini text reply within ~5s. |
| 3 | Send `summarize PR #N on owner/repo`. | v1 | Reply contains PR title + 1–3 bullet summary. |
| 4 | Send `screenshot https://example.com`. | v1 | Image message arrives in LINE. |
| 5 | Multi-turn follow-up uses prior context. | v1 | Yes. |
| 6 | Trigger a Northflank redeploy mid-conversation. | v1 | Volume-backed session survives. |
| 7 | Try to make the agent push to `main`. | v1 | Refused or 403. |
| 8 | Open `/dashboard` while sending a LINE message. | v1.5 | Event feed shows `message_in` → `tool_call(s)` → `tool_result(s)` → `message_out` in real time. |
| 9 | Drill into a userId session in `/dashboard`. | v1.5 | Timeline shows correct chronological events. |
| 10 | Restart the agent-runtime container while the dashboard is open. | v1.5 | SSE reconnects automatically; live feed resumes. |

### Automated checks (lightweight)

- **Worker unit tests** (Vitest in `edge/test/`): signature verification, allowlist drop, forwarding shape.
- **Container healthcheck**: HTTP `GET /healthz` returning `200`.
- **BFF integration tests** (`backend/test/`): SSE proxy passes events through; auth gate rejects bad tokens.
- **Frontend component tests** (`frontend/`): event-feed renders given a fixture event stream.
- **No CI for the agent's reasoning.** Gemini behavior is tested by manual smoke tests only.

## Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| **<$10/mo budget cannot fit Chromium 24/7** — Northflank's smaller shared-vCPU SKUs (`nf-compute-20` = 0.2 vCPU / 512 MB / ~$5.40; `nf-compute-50` = 0.5 vCPU / 1 GB) will OOM under Playwright | High | High | Two paths: (a) accept ~$24/mo for `nf-compute-100-2` (1 dedicated vCPU / 2 GB); or (b) keep Playwright lazy — only spawn Chromium on demand, kill after each task. Plan documents (a) as the baseline; the corrected total fixed cost is ~$29/mo (incl. Workers Paid). |
| Northflank free/starter has cold-start or container sleep | Medium | Medium | Confirm chosen plan supports always-on; otherwise accept first-message latency as wake-up cost. |
| Gemini AI Studio free-tier RPM throttling | Low (≤5 users) | Low | Surface 429s as polite "I'm rate-limited, try again in a minute". |
| LINE webhook 1s timeout while Northflank cold-starts | Medium | Medium | Worker returns `200` to LINE *before* awaiting Northflank (`event.waitUntil`). Container processes async; replies via `pushMessage`. |
| `replyToken` expires while agent is "thinking" | High | Medium | Switch to `pushMessage` after ~25s. |
| GitHub PAT leak from container env | Low | High | Northflank secret-mount only; never log env; PAT is fine-grained. |
| Playwright misuse → site IP-block | Low | Medium | Polite UA, no concurrent browsers, `max_sessions=1` for browser MCP. |
| Northflank volume loss during plan migration | Low | Medium | Periodic dump of session state to Cloudflare KV / R2 (whichever is enabled). v2 Supabase migration removes this. |
| ~~**(v1.5) OpenAB doesn't expose structured event stream out of the box**~~ — **RESOLVED** in Phase 0.2 | — | — | Use `$GEMINI_TELEMETRY_OUTFILE` (documented in `bundle/docs/cli/acp-mode.md`) — Gemini CLI writes JSON-line events directly when `GEMINI_TELEMETRY_ENABLED=true GEMINI_TELEMETRY_TARGET=local`. `events-emitter.js` tails this file. See `openab-upstream-findings.md` §10.5. |
| **(v1.5) Dashboard exposes sensitive PR contents/screenshots if token leaks** | Low | High | Single-user use; rotate token on suspicion; do NOT include the bearer token in URLs (use `Authorization` header only). Two-token model (`DASHBOARD_TOKEN` ≠ `DASHBOARD_INGEST_TOKEN`) limits blast radius. |
| **(v1.5) Cloudflare Pages static export incompatible with some Next.js features** (e.g., `getServerSideProps`, image optimization, server actions) | Medium | Low | Dashboard is intentionally client-side only — design pages around `'use client'` + `fetch`/`EventSource`. Disable next/image optimization or use `unoptimized: true`. |
| **(v1.5) CORS blocks dashboard → Worker requests** | High | High | Dashboard (Pages) and Worker are on different origins. Without CORS headers + OPTIONS preflight on `/api/*`, every browser fetch fails. See `cloudflare-webhook.md` Step 2.5. |
| **(v1.5) SSE proxy hangs silently on upstream disconnect** | Medium | Medium | If the Northflank container restarts, the Worker's SSE proxy body stops emitting but doesn't close. The frontend detects this via heartbeat staleness (no data for 30s → reconnect). Requires the Node sidecar to emit `event: heartbeat` every 15s. See `northflank-container.md` Step 6 and `dashboard-ui.md` Step 6. |
| **Cloudflare Workers free tier CPU limit (10ms) blocks SSE proxy** | High | High | Long-lived SSE streaming requires the Workers Paid plan ($5/mo, 30s CPU time). Total cost estimate: ~$29/mo ($24 Northflank `nf-compute-100-2` + $5 Workers). |
| **Gemini CLI tool policy uses undocumented config keys → prompt-injection can exfiltrate secrets** (`plans/review.md` #1) | Medium | High | **Updated approach (per `openab-upstream-findings.md` §10.2):** tool gating now lives in a TOML Policy Engine file (`gemini/policies/feat1.toml`), not `settings.json` keys. `allow` only `post-screenshot.sh` + `send-line-image.sh`; `deny` everything else (including `web_fetch`, `web_search`, `save_memory`). MCP servers whitelisted by `mcpName`. Sandbox + `security.disableYoloMode` belt-and-braces in `settings.json`. Do NOT pass `--yolo` or `--trust-all-tools`. See `gemini-cli-tools.md` Step 3 + Step 3b. |
| **LINE webhook ingress can lose or replay events** (`plans/review.md` #2) | Medium | High | Persist `webhookEventId` in Cloudflare KV with TTL before forwarding; honour `deliveryContext.isRedelivery`. **Two-ring dedup:** Worker KV is the outer ring (10 min TTL); `openab-gateway` is the inner ring (50s `event_id → replyToken` cache). Outbound: gateway adds `X-Line-Retry-Key` on Push API calls per ADR `line-adapter.md`. Our `send-line-image.sh` does the same for image messages. See `cloudflare-webhook.md` Step 3 + `line-integration.md` Step 5. |
| ~~**OpenAB seams (LINE ingress, agent spawn, session restore) are unverified**~~ — **PARTIALLY RESOLVED** | Low (was High) | High | **Phase 0.1 + 0.2 complete** (`openab-upstream-findings.md`). LINE ingress is `openab-gateway` (separate binary, well-documented in `gateway/README.md` + ADR `line-adapter.md`). Agent spawn is `gemini --acp` (native, upstream-supported). Session restore: ACP transcripts on persistent volume, verified during Phase 0.3 e2e spike. |
| ~~**Gemini CLI may not support ACP protocol**~~ — **RESOLVED** | — | — | `gemini --acp` confirmed in `gemini --help` and `bundle/docs/cli/acp-mode.md`. Upstream's own `Dockerfile.gemini` ships with `args = ["--acp"]`. |
| **OpenAB Rust build from source adds ~8 min to Docker builds** | High (no pre-built binaries) | Low | Confirmed upstream does not publish pre-built Linux x86_64 binaries (Phase 0.1). The Rust build stage is cached by Docker after the first run; CI / production rebuilds only pay the cost on `OPENAB_REF` change. See `northflank-container.md` Step 1. |
| **Dynamic route `[userId]` incompatible with Next.js static export** | Medium | Low | Use query param (`?user=U123`) instead of path segment. See `dashboard-ui.md` Step 2. |

## Future Work (Explicitly Deferred)

- **v2 — Persistent memory:** migrate session store from Northflank volume to Supabase or [hermes-agent](https://github.com/nousresearch/hermes-agent).
- **v2 — Voice input:** turn on OpenAB's STT (Groq / OpenAI / local Whisper).
- **v2 — Group chat support.**
- **v2 — More tools:** Confluence MCP, Slack MCP, file MCP for personal notes.
- **v2 — Dashboard write actions:** kill a session, send a manual LINE reply, edit allowlist from UI.
- **v2 — Dashboard SSO:** GitHub OAuth, replacing the bearer token.
- **v2 — Dashboard cost panel:** Gemini token usage per session, KV/R2 storage usage.

## Status

- [x] Planning
- [ ] In Development (v1)
- [ ] v1 Complete
- [ ] In Development (v1.5 — dashboard)
- [ ] v1.5 Complete

## Implementation Order

> **The dependency ordering stated in individual docs is circular in places.** This section defines the canonical build sequence.

### Phase 0: Upstream Verification + End-to-End Feasibility Spike

> **Phase 0.1 and 0.2 are DONE** (see `documents/FEAT-1/development/openab-upstream-findings.md`). Phase 0.3 (live e2e spike) is the remaining gate before declaring v1 ready.

1. ✅ **Verify OpenAB config schema** — done. Findings file documents `[gateway]` / `[agent]` singular shape, gateway-only env vars, hybrid Reply/Push dispatch, no IMG-prefix parser upstream.
2. ✅ **Verify Gemini CLI ACP + tool policy** — done. `--acp` is native; tool gating is the TOML Policy Engine (not `settings.json` keys); `$GEMINI_TELEMETRY_OUTFILE` provides structured events.
3. **Thin end-to-end spike (Phase 0.3)** — before declaring v1 ready, prove the critical seams in a deployed environment:
   - One real LINE message reaches `openab-gateway` and is forwarded over WebSocket to `openab` core.
   - `openab` spawns Gemini in ACP mode with our Policy Engine applied (try a denied shell command and confirm refusal).
   - The reply path survives a >50s turn (gateway falls back from Reply API to Push API; user still receives the reply).
   - The same LINE userId session is restored after a container restart from the volume mount.
   - `$GEMINI_TELEMETRY_OUTFILE` contains tool_call / tool_result events that the dashboard sidecar can parse.

> **Gate:** Do NOT promote v1 to production until all five are demonstrably working in a live Northflank + Cloudflare deployment. If Phase 0.3 surfaces an integration blocker, stop and reassess — switching to a thinner custom Gemini orchestrator is still on the table as a v1 alternative.

### Phase 1: Config Files (no deployment needed)

3. `gemini-cli-tools.md` — author `gemini/settings.json` + `gemini/system.md` + `gemini/policies/feat1.toml` + `post-screenshot.sh` + `send-line-image.sh`
4. `openab-config.md` — author `config/openab.toml` (singular `[gateway]` + `[agent]`)

### Phase 2: Container Build & Deploy

5. `northflank-container.md` — Dockerfile + scripts + deploy to Northflank → get public URL

### Phase 3: Edge & LINE

6. `cloudflare-webhook.md` — Worker code + deploy → get Worker URL
7. `line-integration.md` — LINE Console setup, wire webhook URL, collect userIds

### Phase 4: Dashboard (v1.5)

8. `dashboard-ui.md` — shared types + frontend pages + Cloudflare Pages deploy

### Deploy Runbook (quick reference)

```sh
# 1. Build & push container to Northflank
cd agent-runtime && docker build -t openab-line-agent . && docker push <registry>

# 2. Deploy Cloudflare Worker
cd edge && wrangler deploy

# 3. Deploy dashboard to Cloudflare Pages
cd frontend && npm run build && wrangler pages deploy out --project-name=ai-agent-dashboard

# 4. Verify
curl https://<container>.northflank.app/healthz       # expect "ok"
curl -X POST https://<worker>.workers.dev/line/webhook # expect 401 (no sig)
```

## Open Questions

**Resolved (during Phase 0.1 + 0.2):**

1. ✅ Gemini CLI binary → `@google/gemini-cli@0.41.2` (matched to upstream `Dockerfile.gemini`). `--acp` is native.
2. ✅ Northflank plan SKU → `nf-compute-100-2` (1 dedicated vCPU / 2 GB / ~$24/mo). Smaller shared-vCPU SKUs OOM under Chromium.
5. ✅ Structured events → tail `$GEMINI_TELEMETRY_OUTFILE` (Gemini-native JSON line stream). No upstream wrapping needed.
6. ✅ Cloudinary vs Cloudflare → confirmed Cloudflare (the brief said "Cloudinary" by typo). Original plan targeted Cloudflare R2; the live deploy switched to Cloudflare Workers KV (`IMG_KV`) to avoid R2's credit-card requirement; trade-offs documented in `documents/FEAT-1/development/cloudflare-webhook.md`.
7. ✅ OpenAB pre-built binaries → upstream does not publish them; we compile from source in the Docker build (cached after first run).
8. ✅ Gemini CLI ACP support → confirmed in `gemini --help` and bundled docs; upstream `Dockerfile.gemini` already uses `args = ["--acp"]`.
9. ✅ Cloudflare Workers free tier SSE → 10 ms CPU limit blocks long-lived SSE; Workers Paid ($5/mo) required for the proxy route.

**Still open (deferred to Phase 0.3 e2e spike):**

3. Final domain choice — `*.workers.dev` for v1; revisit if a custom domain becomes necessary.
4. GitHub MCP server vs `gh` CLI — both baked into the image; Policy Engine allows only MCP server by default. Can flip via policy edit.
10. CI/CD pipeline — GitHub Actions? Manual deploys? What triggers a redeploy?
11. **(NEW)** Does the gateway tolerate `TELEGRAM_BOT_TOKEN` being unset for LINE-only deploys, or do we need a placeholder env? (Phase 0.3 first-boot check.)
12. **(NEW)** Are Gemini telemetry event field names (`event`, `tool_name`, `duration_ms`, etc.) exactly what we coded in `events-emitter.js` `reshape()`? First real telemetry sample in Phase 0.3 confirms.
13. **(NEW)** Does `[gateway].allowed_users` interpret an empty array as "allow all" or "deny all"? Upstream `config.toml.example` says "auto-detected from list", but we want to be explicit. Phase 0.3 first-message check.
