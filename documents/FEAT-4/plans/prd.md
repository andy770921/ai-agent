# PRD: Agent Runtime Rewrite (FEAT-4)

> Status: **In Development** (cutover phase). Authored 2026-05-15, updated 2026-05-19. Owner: Andy.
> All Mastra `src/` code is written. Remaining work: Dockerfile rewrite,
> entrypoint simplification, OpenAB file deletion, Supabase migration apply,
> system prompt seed update.
> Companion: [design-decisions.md](./design-decisions.md) — read first for
> the architecture rationale and the alternatives that were rejected.

## Problem Statement

The current `agent-runtime/` (built in FEAT-1, evolved through FEAT-2/3)
is a Rust-and-Gemini-CLI stack glued together with shell scripts:

- The LLM is **hard-wired to Gemini 2.5 Flash**. Swapping to Claude or
  GPT-4o means deleting `openab-gateway`, rewriting LINE delivery
  semantics, and learning a new tool-policy system.
- The MCP gate (Gemini CLI Policy Engine) **only blocks tool execution
  at runtime** — denied tools' descriptions stay in the model's context.
  This is the root cause of the Playwright bug: the model sees
  `web_fetch` (which is denied), reasons about it, and never reaches
  for Playwright (which is allowed).
- There is **no persistent memory**. Conversation state lives on a
  Docker volume that does not survive HF Space rebuilds. Re-message the
  bot tomorrow and it knows nothing about you.
- The **system prompt is hard-coded** (`agent-runtime/gemini/system.md`).
  Editing the persona means a redeploy.
- The container assembles three foreground processes (Rust gateway, Rust
  core, Node sidecar) plus a port consolidator. **Operational surface is
  larger than the feature surface.**

The user wants a single TS runtime that swaps providers in one config
flip, hides MCP tools from the model unless they're actually needed,
persists per-user memory and skills with bounded growth, and ships with
the Langfuse + dashboard plumbing we already have.

## Solution Overview

Replace `agent-runtime/` end-to-end with a single Node 22 TypeScript
process built on [Mastra](https://github.com/mastra-ai/mastra) (Apache
2.0, 23.9 k stars), which internally uses the Vercel AI SDK (~5 M
weekly downloads, runs Vercel v0 in production). The new runtime:

- Speaks LINE webhook directly (drops `openab-gateway` and `openab`)
- Persists everything in a new Supabase Postgres project (no pgvector,
  no embeddings — `tsvector` GIN for full-text search)
- Exposes heavy MCP servers (Playwright, GitHub) via **subagent
  dispatch**: parent only sees `task_browser` / `task_github`; the
  subagent loads the MCP in isolation and returns a summary
- Auto-extracts long-term memory and auto-creates skills via background
  subagents triggered at session-end (5-gate trigger borrowed from
  cc-haha; eviction rules from Hermes curator)
- Emits OpenTelemetry to Langfuse via Mastra's first-party provider; the
  existing dashboard SSE stays alive via a thin
  `mastraToAgentEvent` shim
- All decisions live in `documents/FEAT-4/plans/design-decisions.md`

## Stakeholders

| Role | Person / Group | Interest |
|---|---|---|
| Engineer / owner | Andy | Builds, deploys, on-call |
| End user | Papa Bakery LINE chat user (single bot for now) | Reliable replies; bot remembers preferences across days |
| Future dev | Anyone reading `agent-runtime/` post-merge | Wants a one-stack TS surface, not Rust + Node hybrid |
| Observability consumer | Langfuse project (existing) | Continues to receive traces |
| Dashboard consumer | `frontend/` (Cloudflare Pages) | `AgentEvent` SSE stream must keep working |

## Success Criteria

Quantitative — each must be measurable on the new deployment:

1. **Provider swap** — flipping `agent_config.default_model` from
   `gemini-2.5-flash` to `claude-sonnet-4-6` to `gpt-4o` takes effect
   within one new session, **with zero code change**. Verified by
   sending the same LINE prompt to each model and confirming Langfuse
   traces show the chosen provider.
2. **Playwright works** — sending the LINE message `screenshot google.com`
   returns a PNG reply within 30 s. This is the regression that
   motivated FEAT-4; it must pass.
3. **MCP context hygiene** — running `await agent.getTools()` at the
   parent level returns ≤ 6 tools (the high-level `task_*` set), not
   the union of all MCP server tools.
4. **Memory persists** — message bot on day N with "I'm allergic to
   peanuts"; message bot on day N + 1; verify the system prompt
   injected into the day N + 1 session contains the peanut fact.
5. **Skill auto-create** — a session with ≥ 5 successful tool calls in
   a coherent pattern triggers an `INSERT` into `skills` with
   `created_by = 'agent'` within 60 s of session end. Verified via
   Supabase row + Langfuse subagent trace.
6. **Curator runs and prunes** — after the weekly cron, skills with
   `last_used_at < now() - interval '90 days' AND NOT pinned` have
   `state = 'archived'`. Verified on a seeded fixture.
7. **Dashboard parity** — the `/events/stream` SSE endpoint emits
   `AgentMessageIn | AgentToolCall | AgentToolResult | AgentMessageOut`
   for every turn, matching the existing `frontend/` consumer. No
   frontend code changes required.
8. **Container size** — final image ≤ 1.8 GB (current is ~1.5 GB; we
   add Mastra + AI SDK + Supabase client but drop Rust binaries +
   `openab` source). Failure means we have to split Playwright into a
   sidecar.
9. **Per-turn p95 latency** — Gemini 2.5 Flash baseline. New stack
   p95 reply latency (LINE message in → LINE reply out, no tool calls)
   ≤ current FEAT-3 p95 + 500 ms. Measured by sampling 100 messages
   per day for 3 days.

Qualitative:

- A second engineer can read `agent-runtime/src/` and understand the
  request path top-to-bottom in one session, without consulting OpenAB
  upstream docs.
- A non-engineer (with DB access) can change the bot persona by
  updating one Supabase row.

## Timeline

5 calendar weeks (one engineer, ~80% allocation; assumes no upstream
Mastra/AI SDK regressions).

| Week | Milestone |
|---|---|
| 1 | Scaffold TS workspace; Supabase project + schema; LINE webhook spike with hybrid Reply/Push; deploy to a throwaway HF Space |
| 2 | Mastra single-provider agent (Gemini); `task_browser` subagent with Playwright MCP loaded; first end-to-end LINE → Mastra → Playwright → screenshot reply |
| 3 | Persistence wiring: `messages`, `agent_config`; system prompt loaded from DB; background memory extraction subagent with 5-gate trigger |
| 4 | Skill auto-creation; curator Cloudflare cron; second provider (Claude) verified; Langfuse OTel adapter ships |
| 5 | Dashboard SSE shim (`mastraToAgentEvent`); cutover deploy to production HF Space; old `openab*` code archived; FEAT-1 deploy decommissioned |

Status checkpoint at each Friday; slip > 2 weeks triggers re-scope
conversation (likely cut: skill auto-creation or curator → FEAT-4.1).

## User Stories

1. As **the LINE end user**, I want the bot to **screenshot a webpage
   I name** so that I get the visual answer without leaving LINE
   (currently broken — Playwright bug).
2. As **the LINE end user**, I want the bot to **remember preferences
   across days** (allergies, language, name) so I don't repeat myself.
3. As **the owner**, I want to **swap the LLM provider with a DB row
   update** so that I can compare quality/cost without redeploys.
4. As **the owner**, I want to **edit the system prompt in Supabase**
   so that I can adjust persona without touching code.
5. As **the owner**, I want **traces in Langfuse for every turn,
   including subagent calls** so that I can debug failures.
6. As **the owner**, I want **auto-extracted memories and auto-created
   skills with eviction** so that the agent improves without manual
   curation and without growing forever.
7. As **a future dev**, I want **one TS process per container, not
   three foreground binaries**, so that I can debug in one stack trace.

## Implementation Decisions

### Modules (deep, with stable interfaces)

| Module | Path | Public interface | Hides |
|---|---|---|---|
| LINE adapter | `agent-runtime/src/line/` | `POST /webhook/line` + `replyOrPush(userId, message)` | HMAC verify, replyToken TTL, hybrid send, retry on 429 |
| Agent core | `agent-runtime/src/agent/` | `runTurn(userId, message): Promise<TurnResult>` | Mastra setup, provider routing, system prompt loading, working memory, compaction |
| MCP subagent dispatch | `agent-runtime/src/mcp/` | `task_browser(prompt)`, `task_github(prompt)` exposed as Mastra tools | MCP client spawn, browser lifecycle, summary extraction |
| Persistence | `agent-runtime/src/db/` | `messages.append(...)`, `memories.find(...)`, `skills.find(...)`, `agentConfig.get(key)` | Supabase client, RLS bypass via service role, fire-and-forget queue, `tsvector` query construction |
| Memory pipeline | `agent-runtime/src/memory/` | `onSessionEnd(userId, sessionId)` hook | 5-gate trigger, advisory lock, EXTRACT subagent, English-rewrite, categorisation |
| Skill pipeline | `agent-runtime/src/skills/` | `onSessionEnd(userId, sessionId)` hook | ≥ 5 tool-call heuristic, SKILL_CREATE subagent, `created_by` stamping |
| Curator | `agent-runtime/src/curator/{handler,runCurator}.ts` | `curatorHandler()` at `/admin/curator`; internally calls `runCurator()` | SQL state transitions, backup snapshot, memory consolidation, skill umbrella-building |
| Observability shim | `agent-runtime/src/observability/` | Mastra OTel exporter pre-wired to Langfuse; SSE bus that emits `AgentEvent` | OTel span → `AgentEvent` translation, ring buffer, fanout |
| HTTP server | `agent-runtime/src/server.ts` | Hono app: `/webhook/line`, `/events/stream`, `/sessions`, `/healthz`, `/img` | Process supervision, graceful shutdown, port binding |

Each module has unit tests against its public interface; integration
tests exercise the LINE → server → agent → MCP → reply path. Internal
helpers are not exported.

### Architecture

```
                  LINE Messaging API
                          │
                  HMAC verify (edge Worker, kept)
                          │
                          ▼
            ┌───────────────────────────────────┐
            │  HF Spaces container (one process)│
            │                                    │
            │   Hono server                      │
            │   ├── POST /webhook/line ──┐       │
            │   ├── GET  /events/stream  │       │
            │   ├── GET  /sessions       │       │
            │   └── GET  /healthz        │       │
            │                            │       │
            │   LINE adapter ◀───────────┘       │
            │       │                            │
            │       ▼                            │
            │   Mastra agent (parent)            │
            │       ├── tools: send_image,        │
            │       │          task_browser,     │
            │       │          task_github       │
            │       │                            │
            │       ▼ (on task_browser call)     │
            │   Subagent (isolated context)      │
            │       └── MCP: Playwright          │
            │            (Chromium, in-container)│
            │                                    │
            │   Observability shim               │
            │       ├── OTel → Langfuse          │
            │       └── AgentEvent → SSE bus     │
            └─────────────┬──────────────────────┘
                          │
                          ▼
                   Supabase Postgres
                   (messages, memories,
                    skills, agent_config,
                    curator_runs)
                          ▲
                          │ weekly cron
                          │
                   Cloudflare Cron Trigger
                   └── POST /admin/curator
```

### APIs / Interfaces

External (LINE / dashboard / cron):

| Endpoint | Method | Auth | Notes |
|---|---|---|---|
| `/webhook/line` | POST | LINE HMAC | Existing edge Worker pre-verifies; agent re-verifies (defence in depth) |
| `/events/stream` | GET | `DASHBOARD_INGEST_TOKEN` Bearer | SSE; reconnects supported |
| `/sessions` | GET | same | List active sessions for dashboard |
| `/sessions/:id/history` | GET | same | Last N turns for a session |
| `/img` | POST | `CF_UPLOAD_SECRET` Bearer | Existing image upload proxy, kept |
| `/healthz` | GET | none | Liveness for HF Spaces |
| `/admin/curator` | POST | `CURATOR_TOKEN` Bearer | Cloudflare cron triggers weekly (see note below) |
| `/admin/agent-config/:key` | PUT | `ADMIN_TOKEN` Bearer | Out of FEAT-4 scope (notes for FEAT-5) |

**Edge Worker changes for cron dispatch:** The existing Cloudflare
Worker (`edge/`) gains a `scheduled` export that fires once per week
(Sunday 02:00 UTC+8). It POSTs to the agent-runtime's `/admin/curator`
with `Authorization: Bearer $CURATOR_TOKEN`. Required file changes:

- `edge/wrangler.toml` — add `[triggers] crons`
- `edge/src/env.ts` — add `CURATOR_TOKEN`
- `edge/src/cron/curator.ts` — new cron handler (uses existing
  `GATEWAY_BASE_URL` from `wrangler.toml`, no separate URL var)
- `edge/src/index.ts` — export `scheduled` handler
- `edge/.dev.vars.example` — add `CURATOR_TOKEN`

See `documents/FEAT-4/development/curator.md` §5 for full code.

Internal — see module table above for TS function signatures.

### Database

New Supabase project. Schema canonical source: `design-decisions.md` §3.
Migrations live in `agent-runtime/supabase/migrations/`. Local dev runs
against a Supabase project named `agent-runtime-dev`; staging uses
`agent-runtime-staging`; prod uses `agent-runtime-prod`.

### Environment variables

Newly required:

- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
- `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` (Gemini key already present)
- `CURATOR_TOKEN` (Cloudflare cron auth)

Kept (moved from edge Worker to agent container):

- `LINE_ALLOWED_USER_IDS` (comma-separated; access control for the
  webhook handler — if empty, all LINE users accepted)

Removed:

- `GATEWAY_TOKEN`, `OPENAB_*`, `GEMINI_TELEMETRY_*`

`agent-runtime/.env.example` updated in step 1.

## Testing Strategy

Three layers:

1. **Unit tests** (Vitest) — per module, mocking external services.
   Threshold: 80 % line coverage on `agent/`, `memory/`, `skills/`,
   `curator/`.
2. **Integration tests** (Vitest, hits real Supabase test project +
   real Gemini API) — exercise `runTurn` end-to-end including DB
   write. Run in CI on a dedicated `agent-runtime-test` Supabase
   branch.
3. **Acceptance test fixtures** — a `tests/acceptance/` folder with
   scripted LINE webhook payloads + expected reply shapes, runnable
   against a local dev server. Each Success Criterion above maps to
   one acceptance fixture.

Manual smoke tests before cutover:

- The 9 quantitative Success Criteria, executed against the staging HF
  Space, results recorded in
  `documents/FEAT-4/development/cutover-checklist.md` (to be written
  in week 5).

## Out of Scope

Explicitly **not** in FEAT-4:

- Streaming responses (LINE doesn't support; punt forever)
- Per-user system prompts (one global prompt; user said no)
- Channel agnostic abstraction (LINE-only stays; multi-channel can
  reuse the module boundaries later but isn't designed-for now)
- Admin UI for editing `agent_config` (DB-level edit only; UI is
  FEAT-5 candidate)
- pgvector / RAG / embeddings (user explicitly excluded)
- Token-cost-aware truncation (user said don't bother)
- Self-evolution PR loop (Hermes companion repo's DSPy/GEPA flow;
  needs human review + git-per-user, neither applies here)
- Channel-as-MCP pattern (cc-haha's design; cool but not needed for
  single-LINE)
- Migration of existing FEAT-1 session state (clean break — user said
  no migration)
- Multi-tenant via Supabase Auth (LINE has no Supabase Auth mapping;
  service role + `WHERE user_id = $1` is enough)

## Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Mastra has a regression in the `@ai-sdk/provider` v3↔v4 aliasing | Medium | Blocks week 2 | Pin exact versions; fallback to VoltAgent (same SDK underneath) |
| Playwright MCP fails in container even after Mastra rewrite | Medium | Blocks Success Criterion #2 | First task in week 2; if it fails, split Playwright into a sidecar container with browserless image |
| HF Spaces 16 GB RAM not enough with Chromium + Node + Supabase client | Low | Blocks deploy | Measure in week 1; if tight, move to Cloudflare Containers (would shift week 5) |
| Subagent dispatch adds too much latency (extra LLM round-trip) | Medium | Hurts UX | Cache the subagent's "tool listing" prompt (Mastra supports prompt caching); measure in week 2 |
| Memory extraction subagent goes into a loop and burns tokens | Low | Cost | Hard `max_turns: 5` cap; per-user daily extraction budget |
| Supabase advisory lock leaked on crash | Low | Memory extraction blocked | Use `pg_try_advisory_xact_lock` (auto-released at txn end) |

## Status

- [x] Planning (this doc)
- [x] In Development — all `src/` Mastra code written; cutover in progress (2026-05-19)
- [ ] Complete

## References

- [Design decisions](./design-decisions.md) — every alternative and why
- [Mastra docs](https://mastra.ai/docs)
- [Vercel AI SDK](https://github.com/vercel/ai)
- [Langfuse + Mastra OTel provider](https://mastra.ai/reference/observability/otel-tracing/providers/langfuse)
- Prior art: `documents/FEAT-1/`, `documents/FEAT-3/`, `documents/REFACTOR-1/`
