# FEAT-4 — Agent Runtime Rewrite: Design Decisions

> Status: Decided (open questions tracked at bottom). Authored 2026-05-15.
>
> This document captures the technology decisions for a full rewrite of
> `agent-runtime/`. The goals are: pluggable LLM providers
> (Gemini / OpenAI / Claude) behind one interface; selective MCP exposure to
> prevent context pollution; persistent long-term memory & auto-created
> skills with bounded growth; persisted system prompt + transcript in
> Supabase; LINE remains the only channel; LINE delivery semantics
> (hybrid Reply/Push) must keep working.

## Context

Current state (FEAT-1 → FEAT-3):

- Single agent: `gemini --acp` subprocess managed by `openab` (Rust)
- LINE webhook served by `openab-gateway` (separate Rust crate), which owns
  HMAC verification + hybrid Reply (50 s replyToken window) → Push fallback
- MCP gating done via Gemini CLI Policy Engine
  (`agent-runtime/gemini/policies/tool-allowlist.toml`) — Gemini-only
- No DB; session state on a Docker volume
  (`/var/lib/openab/sessions`)
- System prompt is a single hard-coded file (`agent-runtime/gemini/system.md`)
- Telemetry: Gemini CLI → JSONL file → Node sidecar
  (`agent-runtime/scripts/healthz.js`) → SSE for the dashboard, plus
  Langfuse traces

Hard requirements driving the rewrite:

1. Swap LLM providers without touching agent code
2. Unified message / tool I/O across providers
3. Selective MCP exposure (don't load all tools every turn)
4. Long-term memory + auto-created skills, both bounded
5. Persistence in Supabase (new project, no migration of legacy state)
6. Single global system prompt, editable from DB without redeploy
7. Keep Langfuse tracing
8. LINE only; no streaming (LINE doesn't support it)

## Decision Summary

| Layer | Decision |
|---|---|
| Agent framework | **Mastra** (Apache 2.0, TS) on top of Vercel AI SDK |
| LLM providers | `@ai-sdk/anthropic`, `@ai-sdk/openai`, `@ai-sdk/google` via Mastra |
| LINE adapter | **TS-native** (drop `openab-gateway` + `openab`) |
| Persistence | **Supabase Postgres only** — no `pgvector`, no embeddings |
| Full-text search | Postgres `tsvector` + GIN index |
| MCP gating | **Subagent dispatch** (Dive-into-CC "P2" pattern) |
| Memory extraction | Background subagent on session-end, 5-gate trigger |
| Skill auto-create | After ≥5 tool calls + success, `created_by='agent'` |
| Curator (eviction) | Idle-gated cron, 30 d stale → 90 d archive, pinned exempt |
| Observability | **Langfuse via OpenTelemetry** (Mastra first-party) |
| Container | Single Node 22 image, still on HF Spaces, Chromium retained |
| System prompt | Single row in `agent_config` table, hot-reloaded |

## 1. Framework: Mastra

### Decision

Use [Mastra](https://github.com/mastra-ai/mastra) (Apache 2.0,
[v1.33+](https://github.com/mastra-ai/mastra/releases), 23.9 k stars) as
the agent framework foundation. Add it as an npm dependency under a new
TS workspace; do not fork.

### Rationale

- Native multi-provider via the Vercel AI SDK underneath
  (Anthropic / OpenAI / Gemini are first-class)
- MCP client built in (`@mastra/mcp` — stdio + streamable HTTP/SSE
  transports), and Mastra can also expose its own tools as an MCP server
- First-party Langfuse provider for OpenTelemetry
  ([docs](https://mastra.ai/reference/observability/otel-tracing/providers/langfuse))
- Postgres storage adapter (we point it at Supabase via connection string)
- Three-tier memory primitives (working / conversation / semantic) we can
  use selectively without buying in to the semantic tier
- Same ecosystem as `frontend/` (npm workspaces, TS strict)

### API surface notes (verified against v1.33)

- Agents: `new Agent({ ... })` from `@mastra/core/agent` — NOT
  `mastra.createAgent()`. Agents are registered via `agents:` config
  and retrieved with `mastra.getAgent('id')`.
- `agent.generate(messages, { runtimeContext, maxSteps })` — the second
  arg is an options object. `RuntimeContext` is a class (not a plain
  object); use `new RuntimeContext()` + `.set(key, value)`.
- MCP tools: `mcp.listTools()` returns `Tool[]`; `mcp.listToolsets()`
  returns `Record<string, ToolImplementation>`. There is no
  `mcp.getTools()`.
- `@hono/node-server` does NOT support `c.executionCtx.waitUntil()` —
  use fire-and-forget Promise + `.catch()` instead.

### Alternatives considered

- **Fork Hermes Agent** — best feature parity but Python; conflicts with
  the rest of this repo (TS workspaces, edge worker types). Rejected.
- **Build directly on Vercel AI SDK** — `generateText()` + `tool()` +
  `@modelcontextprotocol/sdk` cover ~90% of what Mastra gives us for
  this project (~260 lines of custom glue: MCP bridge, OTel wiring,
  provider resolver, subagent dispatch). The AI SDK now has native
  `Agent` / `ToolLoopAgent` patterns (2025+). **Kept as primary
  fallback** — if Mastra causes > 4 hours of framework debugging in
  the week-1 LINE adapter spike, switch to AI SDK direct immediately.
  Estimated extra upfront cost: ~14 hours; benefit: zero framework
  dependency risk for weeks 2-5. See §14 open questions for the
  validation gate.
- **VoltAgent** — MIT, has named Supabase adapter; demoted because
  Langfuse is via generic OTel only, ecosystem ~1/3 the size. Kept as
  secondary emergency fallback.
- **OpenClaw** — TS, `ISession` interface, but it is a *CLI wrapper*
  (spawns `claude` / `gemini` CLI binaries). Same problem we already
  have. Rejected.
- **claude-code-router** — proxy server, wrong shape. Rejected.
- **LiteLLM** — Python sidecar adds a second runtime. Rejected.
- **LangGraph.js** — too low-level; would rebuild Mastra's scaffolding
  ourselves. Rejected.
- **Inkeep Agents** — Elastic License 2.0 restricts competing hosted
  offerings; flag for legal. Rejected to be safe.

## 2. LINE adapter — drop `openab-gateway`

### Decision

Replace `openab-gateway` (and the `openab` core) with a TS LINE webhook
handler inside the new agent runtime. The HF Spaces container becomes a
single Node process.

### Rationale

- `openab` does not support multiple agent binaries in a single container
  ([upstream multi-agent doc](https://github.com/openabdev/openab/blob/main/docs/multi-agent.md)
  is Helm/K8s-only — one Deployment per agent). Keeping `openab` blocks
  the per-session provider switch we need.
- Hybrid Reply/Push is ~50 lines of TS (try
  `https://api.line.me/v2/bot/message/reply` while `replyToken` is fresh,
  else `…/message/push`). Already partially modelled in `edge/src/line/`.
- Removing the Rust build stage cuts container build time and image size,
  and simplifies the `Dockerfile`.
- ACP protocol (the alternative — keep `openab-gateway`, have our TS
  process speak ACP via stdio) is heavier to implement than just
  re-doing the LINE webhook.

### Alternatives considered

- **Keep `openab-gateway`, write a TS ACP agent** — preserves Reply/Push
  for free, but ACP is a moving target and the protocol surface is
  larger than the LINE one. Rejected.
- **Keep `openab` for session pooling** — Mastra has its own session
  model. Rejected.

### What we lose

- `openab`'s pooling (`max_sessions`, `session_ttl_hours`) — replaced by
  Mastra's session lifecycle + our own per-user idle timeout
- The dispatch-mode features
  (`per-message` / `per-thread` / `per-lane`) — LINE is per-user so
  per-thread is the only mode we ever used

### Migration notes

- `documents/FEAT-1/development/openab-upstream-findings.md` stays as
  historical reference
- `agent-runtime/config/openab.toml` will be deleted
- The Cloudflare Worker (`edge/`) still verifies LINE signatures at the
  edge as a fast-fail; the agent container re-verifies for defence in
  depth (current behaviour, kept)

## 3. Persistence: Supabase Postgres + tsvector

### Decision

Use a fresh Supabase project (not the existing `wqgaujuapacxuhvfatii`
Papa Bakery one). Postgres only — no `pgvector`, no embeddings. Full-text
search via Postgres `tsvector` + GIN index.

### Rationale

- User explicitly does not want RAG. Embeddings cost ~$0.02/1M tokens
  for OpenAI text-embedding-3-small but the operational complexity
  (re-embedding on model swap, dim mismatch across providers) buys us
  nothing if we never do similarity search.
- `tsvector` covers the "find me memories about X" use case for English
  and Chinese (need `pg_jieba` or `simple` config for CJK — see open
  question #3).
- Single project keeps RLS rules + service-role secrets isolated from
  Papa Bakery.

### Schema (initial)

```sql
-- One row per LINE user
create table users (
  user_id text primary key,                -- LINE userId
  display_name text,
  created_at timestamptz default now(),
  last_active_at timestamptz default now()
);

-- One row per conversational turn (user message → assistant reply,
-- tool calls embedded as jsonb)
create table messages (
  id bigserial primary key,
  user_id text references users(user_id),
  session_id text not null,                -- LINE-day partition; see §4
  role text check (role in ('user','assistant','tool','system')),
  content jsonb not null,
  tool_calls jsonb,
  tool_results jsonb,
  langfuse_trace_id text,
  created_at timestamptz default now()
);
create index on messages (user_id, session_id, created_at);

-- Auto-extracted long-term memories (markdown bodies, FTS-indexed)
create table memories (
  id bigserial primary key,
  user_id text references users(user_id),
  slug text not null,                       -- "user_eats_breakfast_at_seven"
  category text check (category in ('user','feedback','project','reference')),
  title text not null,
  body text not null,
  frontmatter jsonb default '{}'::jsonb,
  state text check (state in ('active','stale','archived')) default 'active',
  pinned boolean default false,
  use_count int default 0,
  last_used_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  fts tsvector generated always as
    (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(body,'')))
    stored,
  unique (user_id, slug)
);
create index on memories using gin (fts);
create index on memories (user_id, state, pinned desc, last_used_at desc);

-- Auto-created skills (procedural memory, SKILL.md-shaped)
create table skills (
  id bigserial primary key,
  user_id text references users(user_id),  -- null = global skill
  slug text not null,
  body text not null,
  frontmatter jsonb not null,              -- name, description, requires_toolsets, tags…
  created_by text check (created_by in ('agent','user')) default 'agent',
  state text check (state in ('active','stale','archived')) default 'active',
  pinned boolean default false,
  use_count int default 0,
  view_count int default 0,
  patch_count int default 0,
  last_used_at timestamptz,
  last_viewed_at timestamptz,
  last_patched_at timestamptz,
  created_at timestamptz default now(),
  fts tsvector generated always as
    (to_tsvector('simple', coalesce(body,''))) stored,
  unique (user_id, slug)
);
create index on skills using gin (fts);

-- Global runtime config: system prompt, feature flags
create table agent_config (
  key text primary key,
  value text not null,
  updated_at timestamptz default now()
);
-- seed: insert into agent_config (key,value) values ('system_prompt','...');
--       insert into agent_config (key,value) values ('memory_extraction_enabled','true');

-- Auto-update updated_at on row modification (migration 002_rpcs.sql)
-- Triggers on: memories, skills, agent_config
-- Without this, the staleness check (>1 day old) in composeSystem
-- would always see the creation time.

-- Curator / consolidation bookkeeping
create table curator_runs (
  id bigserial primary key,
  user_id text,
  phase text,
  started_at timestamptz default now(),
  finished_at timestamptz,
  archived_count int,
  staled_count int,
  consolidated_count int,
  report jsonb
);
```

### RLS

Disabled at the row level — the agent backend is the only client and
uses the service role. We gate by `user_id` in every query (Mastra's
`runtimeContext`). LINE has no Supabase Auth correspondence so per-user
JWTs are not viable here.

### Latency concern

Direct user question: *"會不會有 API 呼叫等待較長的問題？"*

- Read path (loading recent messages + relevant memories at session
  start): one `select` per table, both indexed. Supabase reports
  p95 < 30 ms within the same region. **Supabase project must be
  in `us-east-1` to co-locate with HF Spaces** (the primary consumer).
  The Cloudflare Worker only forwards webhooks and never reads the DB.
- Write path (transcript persistence): **fire-and-forget after reply**.
  The user's reply has already been sent; persistence happens in the
  background. Failures retry via a small in-memory queue with at-most-30s
  buffer; on container shutdown we flush.
- Memory extraction: explicitly async (see §4).

### Alternatives considered

- **SQLite + FTS5** (Hermes default) — cheapest, but defeats the goal of
  persistent multi-tenant storage and adds an "export from container"
  problem when the HF Space restarts.
- **Markdown files in container volume** — same restart problem; HF
  Spaces volumes are not guaranteed across rebuilds.
- **Supabase + pgvector** — explicitly rejected by user (no embeddings).

## 4. Session model & short-term memory

### Decision

A session = **one LINE userId per UTC day**. Session ID is
`{userId}:{yyyy-mm-dd}`. All messages within the same day are in the
short-term context. At day boundary the session is closed:
- The transcript is preserved in `messages`
- Memory extraction fires (§5)
- A new session starts the next time the user messages

If a single day's history exceeds the context budget for the selected
provider (e.g. Claude 200 k, Gemini 1 M, GPT-4o 128 k), auto-compact
fires:
0. Budget Reduction: per-tool-result cap (4000 chars via `softTruncate`)
   — always active, cheapest layer (Dive-into-CC Layer 1)
1. Snip: drop messages older than 4 hours
2. Microcompact: collapse adjacent tool-call/result pairs into summaries
3. Auto-compact: model summarises the first half of the history

**Reactive compaction** (Dive-into-CC pattern): if `agent.generate()`
throws a context-length error mid-turn, run Snip + Microcompact, retry
once. On second failure, return a graceful error ("I need to start
fresh — too much happened today"). **Circuit breaker**: if auto-compact
fails 3 consecutive times in a session, stop retrying to prevent cost
runaway (cc-haha pattern).

**Known limitation — error classification is heuristic.** Context-length
errors have no canonical shape across providers: Anthropic returns
`400 invalid_request_error` mentioning `max_tokens`; OpenAI returns
`400 context_length_exceeded`; Gemini returns its own envelope. We
detect via case-insensitive substring match (`context` AND one of
`length`/`window`/`token`) on the error message — fragile but workable.
Centralise in `agent-runtime/src/agent/errors.ts`:

```ts
export function isContextLengthError(e: unknown): boolean {
  const m = String((e as Error)?.message ?? e).toLowerCase();
  return m.includes('context') &&
    (m.includes('length') || m.includes('window') || m.includes('token'));
}
```

On Mastra / AI SDK provider bumps, re-test the detector against each
provider's error shape; widen the match if a new shape lands.

Pattern borrowed from Dive-into-CC's 5-layer graduated compaction; we
only need 3 layers because we have a hard 24 h cap.

### Why per-UTC-day not per-conversation?

- User answer: "至多一天就關掉"
- Clean cron boundary (daily Cloudflare cron runs memory extraction +
  closes Playwright browser tabs for that session)
- Trivially solves "Playwright browser state across turns" — the
  subagent's tab is implicitly garbage-collected when the day rolls over

## 5. Memory: auto-extracted markdown, no embeddings

### Decision

- Storage layout borrowed from cc-haha (`memdir/` pattern), Hermes
  curator rules
- Index is *generated* from SQL, not stored as a file:
  ```sql
  select slug, title from memories
  where user_id = $1 and state = 'active'
  order by pinned desc, last_used_at desc nulls last
  limit 200;
  ```
- Categories: `user_*` (preferences, profile), `feedback_*` (corrections),
  `project_*` (active topics), `reference_*` (external resources)
- Slug naming: lowercase snake_case, ≤ 60 chars
- Body: markdown, no fixed cap per memory; long bodies stay (memories
  ≥ 200 chars get their own row, mirroring cc-haha's
  "move > 200 chars to topic file" rule)

### Extraction trigger (5-gate, borrowed from cc-haha)

Fires on **session-end**, defined as: assistant emitted a final
`AgentMessageOut` with no follow-up tool call for 30 s.

Gates (all must pass):
1. `agent_config.memory_extraction_enabled = 'true'`
2. `now() - last_extraction_at(user_id) >= 24 hours`
3. `now() - last_attempt_at(user_id) >= 10 minutes` (throttle on failure)
4. `sessions_since_last_extraction(user_id) >= 5` — keeps extraction off
   on light users
5. `pg_try_advisory_xact_lock(hashtext(user_id))` succeeds

### Extraction algorithm

```
fork subagent {
  provider: same as main agent (cost amortised via prompt cache)
  max_turns: 5
  tools: [memory_read, memory_write, memory_list]
  prompt: EXTRACT_PROMPT.render({
    transcript: last_n_turns(user_id, 20),
    existing_index: select … from memories where user_id = $1 …,
    recent_files: select … order by updated_at desc limit 10
  })
}
on completion: notify_dashboard_via_sse(extracted_count)
on failure: log, release lock, set last_attempt_at
```

`EXTRACT_PROMPT` is our own prose (not Hermes' verbatim — that's
copyrightable). Algorithm = standard summarise-and-categorise.

### Injection at session start

```
SELECT body FROM memories
WHERE user_id = $1
  AND state = 'active'
ORDER BY pinned DESC, last_used_at DESC NULLS LAST
LIMIT N;
```

Plus FTS-keyed top-K based on the current user message:

```
SELECT body, ts_rank_cd(fts, query) AS rank
FROM memories, plainto_tsquery('simple', $2) AS query
WHERE user_id = $1 AND state = 'active' AND fts @@ query
ORDER BY rank DESC
LIMIT K;
```

Injected into the system prompt under a `<memory-context>` block. If
`now() - updated_at > 24 hours`, prepend a staleness disclaimer per
cc-haha's `memoryAge.ts` rule.

### Per-user isolation

Every memory query is `WHERE user_id = $1`. There is no shared cross-user
memory store. Shared facts (the bakery menu, store info) live in the
single global system prompt (`agent_config.system_prompt`), not in
`memories`.

### Eviction (LRU + cap)

Weekly Cloudflare cron (`schedule: "0 18 * * SUN"` — Sunday 02:00 UTC+8):

```sql
-- Phase 1: pure SQL state transitions
update skills set state = 'archived'
where state in ('active','stale')
  and not pinned
  and coalesce(last_used_at, created_at) < now() - interval '90 days';

update skills set state = 'stale'
where state = 'active'
  and not pinned
  and coalesce(last_used_at, created_at) < now() - interval '30 days';

-- Same for memories (default 90/30, configurable per-table)

-- Hard cap (LRU): if active count > N, archive lowest last_used_at
delete from skills where id in (
  select id from skills
  where user_id = $1 and state = 'active' and not pinned
  order by last_used_at asc nulls first
  offset 500            -- N
);
```

Then Phase 1.5: **memory consolidation** (cc-haha AutoDream pattern).
A subagent reviews all active memories per user and:
- Merges near-duplicates (same slug prefix or overlapping content)
- Resolves contradictions (two memories disagree about the same fact)
- Converts any remaining relative dates to absolute
- Removes memories contradicted by recent transcripts

Without this, memory rows accumulate duplicates and contradictions
over time (extraction alone is insufficient). Runs as part of the
weekly curator cron, between Phase 1 (SQL transitions) and Phase 2
(skill umbrella-builder).

Then Phase 2 (LLM umbrella-builder) runs on agent-created skills only,
mirroring Hermes' `CURATOR_REVIEW_PROMPT`. Output stored in
`curator_runs.report` for audit. Backup of affected rows to a
`curator_backups` table or R2 bucket (last 5 retained).

## 6. Skill auto-creation

### Decision

Trigger after session-end if:
- `tool_call_count_this_session >= 5`
- No unrecovered error in the session
- Tool call sequence is "non-trivial" — defined as ≥ 2 distinct tools,
  or a single tool used in a structured pattern

When triggered, fork a subagent with `[skill_create, skill_list,
skill_view]` and `max_turns: 3`. The subagent decides whether to
**create new**, **patch existing umbrella**, or **skip**. Frontmatter
stamps `created_by: "agent"`, `created_at: now()`.

### What we do NOT borrow from Hermes

- The DSPy/GEPA self-evolution loop with PR submission — that requires a
  git repo per user and a human reviewer. Not applicable to LINE bot.
- The `--now` cache-defer slash command — no slash commands here.

### Skill execution

Skills are markdown with YAML frontmatter (`name`, `description`,
`requires_toolsets`, `tags`). At session start, we load only:

```sql
-- Two separate queries, merged in TS (the UNION ALL + ORDER BY has
-- a scope bug: `query` and `fts` from the second SELECT are not
-- visible to the outer ORDER BY clause).
-- Query 1: always-load pinned skills
SELECT body, frontmatter FROM skills
WHERE (user_id = $1 OR user_id IS NULL)
  AND state = 'active'
  AND pinned;

-- Query 2: FTS top-K against current user message
SELECT s.body, s.frontmatter, ts_rank_cd(s.fts, q) AS rank
FROM skills s, plainto_tsquery('simple', $2) q
WHERE (s.user_id = $1 OR s.user_id IS NULL)
  AND s.state = 'active'
  AND s.fts @@ q
ORDER BY rank DESC
LIMIT 5;
```

I.e., always load pinned, then FTS top-5 against the current user
message. Bodies become inline instructions in the system prompt; tools
named in `requires_toolsets` activate.

## 7. MCP gating: subagent dispatch (P2)

### Decision

Adopt the **subagent dispatch** pattern documented in Dive-into-Claude-Code
(architecture.md, "SkillTool vs AgentTool"). This is what Claude Code
actually ships, and it differs from the user's initial framing of
"LLM dynamically decides which MCP to load per turn" — Claude Code does
*not* re-load MCPs mid-turn.

### Implementation

The parent (main) agent only sees a small, fixed set of high-level
tools, one per heavy MCP:

```
parent_tools = [
  reply_to_user,
  send_line_image,
  task_browser,        // subagent w/ Playwright MCP loaded
  task_github,         // subagent w/ GitHub MCP loaded
  task_supabase,       // (future) subagent w/ Supabase MCP loaded
  memory_save_explicit,// user-triggered save
]
```

When the parent calls `task_browser(prompt)`, Mastra spawns a subagent
in an isolated context with only Playwright MCP available, runs its own
turn loop, and returns a **summary** to the parent. Parent context cost
is bounded by the summary length, not the full Playwright trace
(~7× tokens saved per Dive-into-CC).

### Why not "lazy two-stage MCP loading" (P1)

Research shows Claude Code listed P1 as an open question, not a shipped
pattern. P1 would require:
- a new "MCP catalogue" tool the parent calls first
- a re-prompt after loading the chosen MCP
- careful tool-ID stability across the re-prompt

Subagent dispatch achieves the same context-pollution goal without any
of that.

### Per-user MCP selection

Mastra tools accept `runtimeContext`. Thread `{ userId, allowedMcps }`
through it; filter the subagent's loaded MCPs by `allowedMcps`. Default
allowlist = `['playwright','github']`, matching current Gemini Policy
Engine state.

### Playwright in same container

Keep Chromium in the same Docker image (current `Dockerfile` lines
50–55 already install it). HF Spaces gives 16 GB RAM which is enough.
Subagent dispatch means at most one Playwright session active per LINE
user — sessions close at end-of-day (§4).

### Known issue (open)

Playwright MCP currently appears not to be callable from `gemini --acp`
(screenshot pending from user). Whatever the root cause, the rewrite
must verify Playwright works end-to-end before declaring FEAT-4 done.
Tracked in open questions.

## 8. System prompt management

### Decision

Single global prompt stored in `agent_config` (key = `system_prompt`).
Loaded at session start, **not** cached forever — re-read from DB at
session boundary (per UTC day or per cold start). An admin can edit the
prompt by `UPDATE agent_config SET value = '…'`; effect propagates within
≤ 24 h, immediately for new sessions.

### Why not per-user prompts

User said no. Shared bakery info / persona belongs here.

### Editing UX

Dashboard (`frontend/`) gets a new page at
`/admin/system-prompt` that calls
`PUT /api/admin/agent-config/:key`. Worker proxies to a new sidecar
route. Out of FEAT-4 scope (tracked as a follow-up).

## 9. Container architecture

### Decision

Single Node 22 image, single foreground process. Removes Rust build
stage entirely.

```dockerfile
FROM node:22-bookworm-slim
# Chromium libs + ripgrep + tini (kept from current Dockerfile)
# Playwright MCP + GitHub MCP (kept)
# DROP: openab + openab-gateway builds
# DROP: render-config.sh, render-mcp-config.sh, openab.toml,
#       gemini/settings.json, gemini/policies/*

# New: TS app
COPY package.json package-lock.json /app/
RUN npm ci --workspace=@repo/agent-runtime
COPY agent-runtime/src /app/agent-runtime/src
WORKDIR /app/agent-runtime
EXPOSE 7860              # HF Spaces only exposes this
CMD ["node", "--enable-source-maps", "dist/server.js"]
```

The single process serves:
- `POST /webhook/line` — LINE webhook (HMAC verify + dispatch)
- `GET /events/stream` — dashboard SSE (kept from current sidecar)
- `GET /sessions`, `GET /healthz` — kept
- `POST /img` — image upload proxy (kept)

`agent-runtime/scripts/lib/` survives: the event bus, ring buffer, SSE
fanout, Langfuse sink stay relevant — we just emit
`AgentEvent`s from Mastra instead of from a Gemini JSONL tail.

### What gets deleted

- `agent-runtime/config/openab.toml`
- `agent-runtime/scripts/render-config.sh`
- `agent-runtime/scripts/render-mcp-config.sh`
- `agent-runtime/scripts/events-emitter.js` (Gemini JSONL parser)
- `agent-runtime/scripts/hf-proxy.js` (no longer need two ports →
  one port)
- `agent-runtime/scripts/entrypoint.sh` (replaced with a 3-line
  `CMD`)
- `agent-runtime/gemini/` (entire directory)
- `agent-runtime/mcp/servers.json` (Mastra defines servers in TS)

### What stays (with edits)

- `agent-runtime/scripts/deliver-line-image.sh` — keep, called from
  the new `task_send_image` tool
- `agent-runtime/scripts/lib/{agentEventBus,ringBufferSink,sseFanoutSink,langfuseSink,jsonLineDecoder}.js`
  — port to TS, plug into Mastra's event stream

## 10. Provider abstraction & defaults

### Decision

Default model selection (configurable per-user via `agent_config` keyed
by `default_model:<user_id>` later; FEAT-4 ships with a global default):

| Role | Default | Reason |
|---|---|---|
| Main turn | `gemini-2.5-flash` | Cost; current production |
| Subagent (browser/github) | `gemini-2.5-flash` | Same; cheap |
| Memory extraction | `gemini-2.5-flash` | Background, cost-sensitive |
| Curator umbrella pass | `claude-haiku-4-5` | Better summarisation per $ |
| Skill creation | `claude-sonnet-4-6` | Higher-quality procedural output |

The Mastra `agent` config takes a `model:` function so per-call swap is
one line:
```ts
const main = mastra.getAgent('line-bot');
await main.generate({ messages, runtimeContext: { model: 'openai/gpt-4o' } });
```

### Token-aware truncation

User said: not needed for FEAT-4. Mastra's default truncation is
fine. Revisit if we see truncation cutting off tool results.

### Streaming

Off. LINE doesn't support streaming; we always wait for the full
response.

## 11. Observability: Langfuse via Mastra OTel

Mastra emits OpenTelemetry traces. Wire the `langfuse-vercel`
`LangfuseSpanProcessor` into Mastra's `telemetry:` config; the existing
Langfuse project (kept from FEAT-3) receives traces with the same
session/user attribution we have today.

Existing `agent-runtime/scripts/lib/langfuseSink.js` can be retired
once Mastra OTel is verified end-to-end.

## 12. Migration plan

This is a clean break, not a side-by-side migration.

1. **Branch + scaffold** — new TS workspace `agent-runtime/` (replacing
   the current non-workspace folder). Add Mastra, Vercel AI SDK
   providers, Langfuse, Supabase client.
2. **Supabase setup** — new project; run schema from §3 as a migration.
3. **LINE adapter spike** — TS handler with hybrid Reply/Push, behind
   the existing Cloudflare Worker. Verify against the
   `documents/FEAT-1/development/phase0-e2e-spike-runbook.md`.
4. **Mastra agent spike** — single-provider (Gemini), single MCP
   (`task_browser`), no memory. Send a LINE message, get a reply.
5. **Persistence** — wire `messages` and `agent_config` tables.
6. **Memory + skill auto-extraction** — background jobs + dashboard event.
7. **Curator** — Cloudflare cron + Supabase advisory locks.
8. **Provider switch** — second provider (Claude or OpenAI), exercise
   `runtimeContext.model` swap.
9. **HF Spaces deploy** — new image; cut over LINE Messaging API webhook
   URL.
10. **Decommission** — remove `openab*` source, document under
    `documents/FEAT-4/development/`.

Old FEAT-1 stays in git history but the running deployment is replaced
in one cutover.

## 13. Alternatives considered (consolidated)

| Topic | Chosen | Rejected | Reason |
|---|---|---|---|
| Framework | Mastra | Hermes Agent (fork) | Python ≠ rest of repo |
| Framework | Mastra | AI SDK direct | ~260 lines glue; **primary fallback** if Mastra debugging > 4h in week 1 |
| Framework | Mastra | VoltAgent | Langfuse only via generic OTel; **secondary fallback** |
| Framework | Mastra | OpenClaw | CLI wrapper, not native LLM client |
| Framework | Mastra | LangGraph.js | Too low-level |
| Framework | Mastra | Inkeep Agents | Elastic License risk |
| Framework | Mastra | claude-code-router | Wrong shape (proxy) |
| Framework | Mastra | LiteLLM | Python sidecar |
| Provider routing | Vercel AI SDK (via Mastra) | self-written | Solved problem |
| LINE adapter | TS native | Keep openab-gateway + ACP agent | Lower complexity |
| Persistence | Supabase | SQLite + FTS5 | Multi-tenant; restart loss |
| Memory store | Markdown blobs in Postgres | pgvector + embeddings | Cost; user said no RAG |
| MCP gating | Subagent dispatch (P2) | LLM dynamic load (P1) | Not shipped in Claude Code |
| MCP gating | Subagent dispatch (P2) | Pre-classifier router (P3) | Extra latency, second failure mode |
| Skill review | Auto (`created_by='agent'`) | Hermes DSPy/GEPA PRs | No git repo per user |
| Container | Single Node | Multi-process (gateway+core+sidecar) | Removed openab |
| Eviction | 30 d stale → 90 d archive + cap | TTL only | Hermes-proven rules |
| Lock | Postgres advisory | File lock (cc-haha) | Container restart loses PID |

## 14. Open questions

Resolved during second review (2026-05-15):

- [x] **Playwright MCP failure root-caused** — current `gemini --acp`
  setup never registers Playwright tools with the model. The Gemini CLI
  Policy Engine `deny` rule for `web_fetch` only blocks runtime
  execution; the tool description stays in the model's context, so the
  model reasons about `web_fetch` and never reaches for Playwright.
  Mastra's SDK-level tool registration solves this by construction —
  unregistered tools have no description in context. **Acceptance test
  in §12 step 4**: send LINE message "screenshot google.com", expect
  a PNG returned within 30 s.
- [x] **CJK FTS** — *Decision*: at extraction time, the memory subagent
  rewrites the canonical fact in **English** before saving. Bodies
  stored in English; `tsvector('simple', body)` works fine. Source
  user messages remain in original language in `messages.content`.
  This avoids `pg_jieba` extension dependency and works uniformly
  across English/Chinese/Japanese inputs.
- [x] **Skill execution cost** — *Decision*: don't cap. User said token
  cost is not a concern for FEAT-4.
- [x] **Subagent failure / retry** — *Decision*: one automatic retry
  with the same prompt; on second failure the parent receives a
  structured `{ ok: false, reason: string, subagentTraceId: string }`
  result and decides how to surface to the user (typically "I tried
  twice and the browser tool failed — want me to try a different
  approach?"). No exponential backoff (LINE is human-paced).
- [x] **Sidecar event-shape parity** — *Decision*: don't pre-build an
  adapter. Mastra emits OTel spans; in §12 step 5 we add a tiny shim
  (`scripts/lib/mastraToAgentEvent.ts`) that subscribes to Mastra's
  hook stream and emits the existing `AgentEvent` union to the
  dashboard SSE. Defer until we see what Mastra actually emits.

Still open:

- [ ] **HF Spaces websocket upgrade** — verify SSE reconnect works
  after `hf-proxy.js` removal in §12 step 9.
- [ ] **Mastra Supabase pgvector doc gap** — we don't use pgvector
  in FEAT-4. Note for future RAG work only.
- [ ] **Zod v3 vs v4 transitive dependency** — `@mastra/mcp` has a
  known Zod v4 compatibility break (mastra-ai/mastra#7092). We pin
  `zod: ^3` in `package.json` but Mastra's transitive deps may pull
  in Zod v4. Verify with `npm ls zod` after initial install. If
  conflicting, use `overrides` in root `package.json` to force v3.
- [ ] **Mastra validation gate (week 1)** — If Mastra causes > 4
  hours of framework debugging during the week-1 LINE adapter spike,
  switch to **AI SDK direct** (see §1 Alternatives). The switch
  requires ~14 hours upfront (MCP bridge ~60 lines, OTel wiring ~40,
  subagent dispatch ~80, provider resolver ~30) but eliminates
  framework-level risk for weeks 2–5. Decision point: end of week 1.

## 15. Status

- [x] Discussed
- [ ] Implementation plan written (next doc: `development/implementation-plan.md`)
- [ ] Implemented
- [ ] Validated

## References

- [VILA-Lab/Dive-into-Claude-Code](https://github.com/VILA-Lab/Dive-into-Claude-Code)
  (CC BY-NC-SA 4.0 — patterns only, no code reuse)
- [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)
  (MIT — Curator + Skills patterns)
- [NanmiCoder/cc-haha](https://github.com/NanmiCoder/cc-haha)
  (restrictive — public docs only, no code reuse)
- [Mastra](https://github.com/mastra-ai/mastra) (Apache 2.0)
- [Vercel AI SDK](https://github.com/vercel/ai) (Apache 2.0)
- [OpenAB upstream findings](../../FEAT-1/development/openab-upstream-findings.md)
  (historical, explains why we kept `openab-gateway` until now)
