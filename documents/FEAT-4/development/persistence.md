# Implementation Plan: Persistence Layer (Supabase)

## Overview

Single Supabase project (new — `agent-runtime-prod`, separate from
`wqgaujuapacxuhvfatii` Papa Bakery). One TS module per table; queries
are thin SQL with prepared statements via `@supabase/supabase-js`. No
ORM. Service role only; RLS off (single backend client). All queries
filter by `user_id` defensively.

## Files to Modify

### Supabase migrations

- `agent-runtime/supabase/migrations/20260516_000_init.sql` — schema
  from `design-decisions.md` §3 (users, messages, memories, skills,
  agent_config, curator_runs)
- `agent-runtime/supabase/migrations/20260516_001_seed_config.sql` —
  insert default system_prompt + default_model rows
- `agent-runtime/supabase/migrations/20260516_002_rpcs.sql` —
  dedicated RPC functions (FTS, advisory locks, curator, triggers)
- `agent-runtime/supabase/config.toml` — project config (link via
  `npx supabase link`)

### TS access layer

- `agent-runtime/src/db/client.ts` — singleton `SupabaseClient`
- `agent-runtime/src/db/users.ts` — `upsertUser(userId, displayName)`
- `agent-runtime/src/db/messages.ts` — `appendUserMessage`,
  `appendAssistantMessage`, `loadRecentMessages`
- `agent-runtime/src/db/memories.ts` — `findRelevantMemories`,
  `insertMemory`, `markUsed`
- `agent-runtime/src/db/skills.ts` — `findRelevantSkills`,
  `insertSkill`, `markUsed`
- `agent-runtime/src/db/agentConfig.ts` — `getAgentConfig(key)` with
  in-process cache (60 s TTL)
- `agent-runtime/src/db/writeQueue.ts` — fire-and-forget queue with
  flush-on-shutdown

## Step-by-Step Implementation

### Step 1: Supabase project + schema

```sh
npx supabase projects create agent-runtime-prod --org <org> --region us-east-1
npx supabase link --project-ref <ref>
npx supabase migration new init
# paste schema from design-decisions.md §3 into the generated SQL file
npx supabase db push
```

**Rationale:** Co-locate with HF Spaces (US-east) — the container is
the primary DB consumer (reads at session start, writes after each
turn). The Cloudflare Worker only forwards webhooks and never reads
the DB. Singapore (ap-southeast-1) would add ~200 ms RTT on every
session-start read batch, which is unnecessary.

### Step 2: Client singleton

**File:** `agent-runtime/src/db/client.ts`

```ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (!client) {
    client = createClient(
      process.env.SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_KEY!,
      { auth: { persistSession: false } },
    );
  }
  return client;
}
```

**Rationale:** One TCP pool per container. `persistSession: false` is
required for server-side use.

### Step 3: Message append + read

**File:** `agent-runtime/src/db/messages.ts`

```ts
import { db } from './client';
import { enqueueWrite } from './writeQueue';

export interface AppendArgs {
  userId: string; sessionId: string;
  content: string; langfuseTraceId?: string;
}

export function appendUserMessage(a: AppendArgs) {
  return enqueueWrite(async () => {
    await db().from('messages').insert({
      user_id: a.userId, session_id: a.sessionId, role: 'user',
      content: { text: a.content },
    });
  });
}

export function appendAssistantMessage(a: AppendArgs & { toolCalls?: unknown }) {
  return enqueueWrite(async () => {
    await db().from('messages').insert({
      user_id: a.userId, session_id: a.sessionId, role: 'assistant',
      content: { text: a.content },
      tool_calls: a.toolCalls ?? null,
      langfuse_trace_id: a.langfuseTraceId ?? null,
    });
  });
}

export async function loadRecentMessages(a: { userId: string; sessionId: string; limit: number }) {
  const r = await db().from('messages')
    .select('role, content, tool_calls, tool_results, created_at')
    .eq('user_id', a.userId).eq('session_id', a.sessionId)
    .order('created_at', { ascending: true }).limit(a.limit);
  if (r.error) throw r.error;
  return r.data ?? [];
}
```

**Rationale:** Writes go through the queue (non-blocking); reads are
direct (caller awaits). `session_id` = `{userId}:{yyyy-mm-dd}` (built
in `agent/session.ts`).

### Step 4: Memory queries

**File:** `agent-runtime/src/db/memories.ts`

```ts
import { db } from './client';

export interface Memory {
  id: number; title: string; body: string;
  updatedAt: Date; useCount: number; pinned: boolean;
}

export async function findRelevantMemories(a: {
  userId: string; query: string; limit: number;
}): Promise<Memory[]> {
  // Two-stage: pinned + recent, then FTS top-K, dedupe.
  // Uses dedicated RPCs because the Supabase JS client cannot express
  // tsvector queries or ts_rank_cd directly.
  const [base, fts] = await Promise.all([
    db().rpc('find_memories_recent', {
      p_user_id: a.userId, p_limit: a.limit,
    }),
    db().rpc('find_memories_fts', {
      p_user_id: a.userId, p_query: a.query, p_limit: a.limit,
    }),
  ]);
  const merged = new Map<number, Memory>();
  for (const m of [...(base.data ?? []), ...(fts.data ?? [])]) merged.set(m.id, toMemory(m));
  return [...merged.values()].slice(0, a.limit);
}

export async function markUsed(ids: number[]) {
  if (ids.length === 0) return;
  // Supabase JS client cannot do `use_count + 1` in .update().
  // Use a dedicated RPC for atomic increment.
  await db().rpc('memories_mark_used', { p_ids: ids });
}

function toMemory(r: any): Memory {
  return {
    id: r.id, title: r.title, body: r.body,
    updatedAt: new Date(r.updated_at), useCount: r.use_count, pinned: r.pinned,
  };
}
```

**Rationale:** Supabase JS client doesn't expose `tsvector` or
`ts_rank_cd` directly, and the `db().rpc()` method calls **named
Postgres functions** (not arbitrary SQL). We use dedicated RPCs
(`find_memories_recent`, `find_memories_fts`, `memories_mark_used`)
defined in step 5. This is safer and avoids the `EXECUTE ... USING
text[]` pitfall of a generic `exec()` function (PL/pgSQL `USING`
takes individual args, not an array — `$1` would resolve to the
whole array, not the first element).

### Step 5: Dedicated RPC functions

**File:** `agent-runtime/supabase/migrations/20260516_002_rpcs.sql`

We define purpose-built functions instead of a generic `exec()`. The
generic `exec(sql text, params text[])` pattern is broken in PL/pgSQL:
`EXECUTE ... USING` takes individual variadic args, not an array —
`$1` would resolve to the entire array, and multi-column rows don't
auto-cast to `jsonb`.

```sql
-- =============================================================
-- Auto-update updated_at on row modification
-- =============================================================
create function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger trg_memories_updated before update on memories
  for each row execute function set_updated_at();
create trigger trg_agent_config_updated before update on agent_config
  for each row execute function set_updated_at();
create trigger trg_skills_updated before update on skills
  for each row execute function set_updated_at();

-- =============================================================
-- Memory: find recent (pinned-first, LRU order)
-- =============================================================
create function find_memories_recent(p_user_id text, p_limit int)
returns table(id bigint, title text, body text, updated_at timestamptz,
              use_count int, pinned boolean)
language sql stable security definer as $$
  select id, title, body, updated_at, use_count, pinned
  from memories
  where user_id = p_user_id and state = 'active'
  order by pinned desc, last_used_at desc nulls last
  limit p_limit;
$$;

-- =============================================================
-- Memory: full-text search
-- =============================================================
create function find_memories_fts(p_user_id text, p_query text, p_limit int)
returns table(id bigint, title text, body text, updated_at timestamptz,
              use_count int, pinned boolean, rank real)
language sql stable security definer as $$
  select m.id, m.title, m.body, m.updated_at, m.use_count, m.pinned,
         ts_rank_cd(m.fts, q) as rank
  from memories m, plainto_tsquery('simple', p_query) q
  where m.user_id = p_user_id and m.state = 'active' and m.fts @@ q
  order by rank desc
  limit p_limit;
$$;

-- =============================================================
-- Memory: atomic increment use_count + touch last_used_at
-- =============================================================
create function memories_mark_used(p_ids bigint[])
returns void language sql security definer as $$
  update memories
  set use_count = use_count + 1, last_used_at = now()
  where id = any(p_ids);
$$;

-- =============================================================
-- Gate check: memory extraction stats for a user
-- =============================================================
create function memory_extraction_stats(p_user_id text)
returns table(since_last_success float, since_last_attempt float, new_sessions bigint)
language sql stable security definer as $$
  select
    coalesce(extract(epoch from (now() - max(case when phase='extract-success' then started_at end))), 1e9),
    coalesce(extract(epoch from (now() - max(case when phase='extract-attempt' then started_at end))), 1e9),
    count(*) filter (where phase='session-end' and started_at > now() - interval '30 days')
  from curator_runs where user_id = p_user_id;
$$;

-- =============================================================
-- Advisory locks (session-level)
-- =============================================================
create function try_advisory_lock(lock_key text)
returns boolean language sql security definer as $$
  select pg_try_advisory_lock(hashtextextended(lock_key, 0));
$$;

create function advisory_unlock(lock_key text)
returns boolean language sql security definer as $$
  select pg_advisory_unlock(hashtextextended(lock_key, 0));
$$;

-- =============================================================
-- Curator: state transitions + hard cap
-- =============================================================
create function curator_mark_stale(days int) returns void language plpgsql security definer as $$
begin
  update skills set state = 'stale'
    where state = 'active' and not pinned
      and coalesce(last_used_at, created_at) < now() - (days || ' days')::interval;
  update memories set state = 'stale'
    where state = 'active' and not pinned
      and coalesce(last_used_at, created_at) < now() - (days || ' days')::interval;
end $$;

create function curator_archive(days int) returns void language plpgsql security definer as $$
begin
  update skills set state = 'archived'
    where state in ('active','stale') and not pinned
      and coalesce(last_used_at, created_at) < now() - (days || ' days')::interval;
  update memories set state = 'archived'
    where state in ('active','stale') and not pinned
      and coalesce(last_used_at, created_at) < now() - (days || ' days')::interval;
end $$;

create function curator_hard_cap(max_active int) returns void language plpgsql security definer as $$
begin
  with ranked as (
    select id, row_number() over (
      partition by user_id order by pinned desc, last_used_at desc nulls last
    ) as rn from skills where state = 'active'
  )
  update skills set state = 'archived' where id in (select id from ranked where rn > max_active);

  with ranked as (
    select id, row_number() over (
      partition by user_id order by pinned desc, last_used_at desc nulls last
    ) as rn from memories where state = 'active'
  )
  update memories set state = 'archived' where id in (select id from ranked where rn > max_active);
end $$;

-- Backup retention
create function curator_backup_retain(keep int) returns void language sql security definer as $$
  delete from curator_backups where id in (
    select id from (
      select id, row_number() over (
        partition by affected_table order by created_at desc) as rn
      from curator_backups
    ) t where rn > keep
  );
$$;

-- Revoke all from public; grant to service_role
do $$
declare fn record;
begin
  for fn in
    select p.proname, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p join pg_namespace n on p.pronamespace = n.oid
    where n.nspname = 'public' and p.proname in (
      'set_updated_at','find_memories_recent','find_memories_fts',
      'memories_mark_used','memory_extraction_stats',
      'try_advisory_lock','advisory_unlock',
      'curator_mark_stale','curator_archive','curator_hard_cap',
      'curator_backup_retain'
    )
  loop
    execute format('revoke all on function %I(%s) from public', fn.proname, fn.args);
    execute format('grant execute on function %I(%s) to service_role', fn.proname, fn.args);
  end loop;
end $$;
```

**Rationale:** Dedicated functions with typed parameters are:
- **Correct** — avoids `EXECUTE ... USING text[]` which doesn't
  unpack arrays into positional `$1, $2, $3` (PL/pgSQL limitation).
- **Safe** — no generic SQL execution surface; each function does
  one thing with validated inputs.
- **Auditable** — `pg_proc` lists exactly what the service role can do.
- The `set_updated_at` trigger ensures `updated_at` auto-updates on
  every row modification (without this, the staleness check in
  `composeSystem.ts` would always see the creation time).

### Step 6: agent_config with cache

**File:** `agent-runtime/src/db/agentConfig.ts`

```ts
import { db } from './client';

const cache = new Map<string, { value: string; loadedAt: number }>();
const TTL_MS = 60_000;

export async function getAgentConfig(key: string): Promise<string> {
  const cached = cache.get(key);
  const now = Date.now();
  if (cached && now - cached.loadedAt < TTL_MS) return cached.value;
  const r = await db().from('agent_config').select('value').eq('key', key).single();
  if (r.error) throw new Error(`agent_config[${key}] missing: ${r.error.message}`);
  cache.set(key, { value: r.data.value, loadedAt: now });
  return r.data.value;
}

export function invalidateAgentConfig(key?: string) {
  if (key) cache.delete(key); else cache.clear();
}
```

**Rationale:** 60 s cache means admin edits propagate quickly without
LISTEN/NOTIFY.

### Step 7: Write queue

**File:** `agent-runtime/src/db/writeQueue.ts`

```ts
const queue: Array<() => Promise<void>> = [];
let processing = false;

export function enqueueWrite(fn: () => Promise<void>) {
  queue.push(fn);
  if (!processing) drain();
}

async function drain() {
  processing = true;
  while (queue.length > 0) {
    const fn = queue.shift()!;
    try { await fn(); } catch (e) { console.error('writeQueue', e); }
  }
  processing = false;
}

export async function flushQueue() {
  while (processing || queue.length > 0) await new Promise(r => setTimeout(r, 50));
}
```

**Rationale:** Fire-and-forget — the LINE reply has already been sent
to the user; we don't make the user wait on Supabase. On shutdown
(SIGTERM), the server calls `flushQueue()` before `process.exit(0)`.

**Important:** `server.ts` must register a SIGTERM handler:

```ts
import { flushQueue } from './db/writeQueue';

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, flushing write queue…');
  await flushQueue();
  process.exit(0);
});
```

Without this, queued writes are lost on container restarts (HF Spaces
rebuilds send SIGTERM → 30 s grace → SIGKILL).

## Testing Steps

1. Unit-test `findRelevantMemories` against a seeded Supabase test
   project: insert 20 memories, query, verify pinned-first ordering and
   FTS hit.
2. Unit-test `writeQueue`: enqueue 100 promises, verify all complete
   in order, no unhandled rejections.
3. Integration-test: `appendAssistantMessage(...)` → `flushQueue()`
   → `select count(*)` returns expected.

## Dependencies

- Must complete before: agent-core (uses these helpers),
  memory-skill-pipeline, curator
- Depends on: none

## Notes

- Supabase pgvector extension is **not enabled**. Verify in step 1.
- Migrations live under `agent-runtime/supabase/` and ship in the
  Docker image only as a reference; production migrations run via
  `npx supabase db push` from CI before image rollout.
- For local dev: `npx supabase start` brings up a local Postgres on
  port 54322; point `SUPABASE_URL` there.
