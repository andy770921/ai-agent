# Implementation Plan: Curator (Weekly Cron)

## Overview

Weekly Cloudflare cron triggers `POST /admin/curator` on the agent
container. Phase 1 is pure SQL (state transitions: 30 d → stale, 90 d
→ archive, LRU hard cap). Phase 1.5 is **memory consolidation**
(cc-haha AutoDream pattern) — an LLM subagent per user that merges
near-duplicate memories, resolves contradictions, and converts relative
dates to absolute. Phase 2 is an LLM umbrella-builder subagent — only
on `created_by='agent'` skills. Backup of affected rows to a
`curator_backups` table before Phase 1.5 and Phase 2 (last 5 kept).

## Files to Modify

- `agent-runtime/src/curator/handler.ts` — Hono handler at
  `/admin/curator` (auth + bookkeeping)
- `agent-runtime/src/curator/runCurator.ts` — all curator logic:
  `sqlTransitions()` → `snapshotActiveSkills()` →
  `consolidateMemories()` → `consolidateSkills()`
- `agent-runtime/supabase/migrations/20260516_003_curator_backup.sql`
  — `curator_backups` table
- Cloudflare cron config in `edge/wrangler.toml` (existing worker)
- `edge/src/cron/curator.ts` — NEW; Cron handler that POSTs to agent
- `edge/src/env.ts` — add `CURATOR_TOKEN` to the `Env` interface
- `edge/src/index.ts` — add `scheduled` export wired to the cron handler
- `edge/.dev.vars.example` — add `CURATOR_TOKEN` placeholder

## Step-by-Step Implementation

### Step 1: Backup table

**File:** `agent-runtime/supabase/migrations/20260516_003_curator_backup.sql`

```sql
create table curator_backups (
  id bigserial primary key,
  created_at timestamptz default now(),
  affected_table text check (affected_table in ('memories','skills')),
  snapshot jsonb not null,        -- array of full rows before mutation
  row_count int not null
);
create index on curator_backups (affected_table, created_at desc);
```

**Rationale:** One row per backup; rotating retention via
`delete … where rn > 5` in step 4.

### Step 2: Phase 1 SQL transitions

**File:** `agent-runtime/src/curator/phase1.ts`

```ts
import { db } from '../db/client';

export async function curatorPhase1() {
  // Each statement is a separate RPC call. Supabase JS client does not
  // support multi-statement SQL, and the generic `exec()` RPC has
  // parameter-binding limitations (see persistence.md). Using dedicated
  // RPCs (`curator_mark_stale`, `curator_archive`, `curator_hard_cap`)
  // is safer and more maintainable.

  // Mark stale (30 d)
  await db().rpc('curator_mark_stale', { days: 30 });

  // Archive (90 d)
  await db().rpc('curator_archive', { days: 90 });

  // Hard cap (LRU): keep at most 500 active per user
  await db().rpc('curator_hard_cap', { max_active: 500 });
}
```

These RPCs are defined in `persistence.md` step 5. Each operates on
both `skills` and `memories` tables atomically:

```sql
-- curator_mark_stale(days int)
create function curator_mark_stale(days int) returns void language plpgsql as $$
begin
  update skills set state = 'stale'
    where state = 'active' and not pinned
      and coalesce(last_used_at, created_at) < now() - (days || ' days')::interval;
  update memories set state = 'stale'
    where state = 'active' and not pinned
      and coalesce(last_used_at, created_at) < now() - (days || ' days')::interval;
end $$;

-- curator_archive(days int)
create function curator_archive(days int) returns void language plpgsql as $$
begin
  update skills set state = 'archived'
    where state in ('active','stale') and not pinned
      and coalesce(last_used_at, created_at) < now() - (days || ' days')::interval;
  update memories set state = 'archived'
    where state in ('active','stale') and not pinned
      and coalesce(last_used_at, created_at) < now() - (days || ' days')::interval;
end $$;

-- curator_hard_cap(max_active int)
create function curator_hard_cap(max_active int) returns void language plpgsql as $$
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
```

**Rationale:** All SQL, no LLM. Idempotent — running twice doesn't
double-archive. Dedicated RPCs with typed parameters avoid the
`EXECUTE ... USING text[]` pitfall of the generic `exec()` approach.
The hard cap uses window functions to keep the most recently used N
per user.

### Step 3: Backup snapshot

**File:** `agent-runtime/src/curator/backup.ts`

```ts
import { db } from '../db/client';

export async function snapshotBeforePhase2() {
  const skills = await db().from('skills').select('*')
    .eq('state', 'active').eq('created_by', 'agent');
  if ((skills.data ?? []).length === 0) return;

  await db().from('curator_backups').insert({
    affected_table: 'skills',
    snapshot: skills.data, row_count: skills.data!.length,
  });

  // Retention: keep last 5 per table
  await db().rpc('curator_backup_retain', { keep: 5 });
}
```

**Rationale:** Snapshot rows that Phase 1.5 or Phase 2 might touch.
JSON column keeps the full row contents — restore by `insert from
select`.

### Step 3.5: Phase 1.5 — Memory consolidation (cc-haha AutoDream)

**File:** `agent-runtime/src/curator/phase1_5.ts`

Without periodic consolidation, memory rows accumulate near-duplicates
and contradictions over time (extraction alone is insufficient).

```ts
import { Agent, PROVIDERS } from '../agent';
import { pickProvider } from '../agent/providerRouting';
import { db } from '../db/client';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const CONSOLIDATION_PROMPT = `
You are reviewing a user's memory bank for quality. For each issue found:
1. Merge near-duplicates (same fact stated differently) into one memory
2. Resolve contradictions (two memories disagree) — keep the more recent
3. Convert relative dates to absolute if any remain
4. Remove memories that are no longer true based on more recent memories

Be conservative — only act on clear issues. Do nothing if quality is high.
`;

export async function curatorPhase1_5() {
  const { data: users } = await db().from('memories').select('user_id')
    .eq('state', 'active');
  const userIds = [...new Set((users ?? []).map(m => m.user_id))];

  for (const uid of userIds) {
    await consolidateForUser(uid);
  }
}

async function consolidateForUser(userId: string) {
  const { data: memories } = await db().from('memories')
    .select('slug, title, body, category, updated_at, use_count')
    .eq('user_id', userId).eq('state', 'active').limit(200);
  if ((memories ?? []).length < 5) return; // not worth the LLM call

  // Cost note: Phase 1.5 runs ONCE PER USER per week. Curator role
  // defaults to claude-haiku-4-5 (per agent-core.md). For 1000 users
  // with ~50 active memories each (≈10KB context per user), one weekly
  // pass ≈ $30–50 in Haiku 4.5 input tokens. To cut by ~10×, flip the
  // curator role to gemini-2.5-flash:
  //   UPDATE agent_config SET value = 'gemini-2.5-flash'
  //   WHERE key = 'default_model:curator';
  // Trade-off: Flash is less accurate at deduping near-duplicates, so
  // expect slightly more redundant memories surviving consolidation.
  const providerKey = await pickProvider(userId, 'curator');

  const mergeTool = createTool({
    id: 'memory_merge',
    description: 'Merge N duplicate memories into one, archiving the rest.',
    inputSchema: z.object({
      keep_slug: z.string(), updated_body: z.string(),
      archive_slugs: z.array(z.string()),
    }),
    execute: async ({ context }) => {
      await db().from('memories').update({ body: context.updated_body })
        .eq('user_id', userId).eq('slug', context.keep_slug);
      await db().from('memories').update({ state: 'archived' })
        .eq('user_id', userId).in('slug', context.archive_slugs);
      return { ok: true };
    },
  });

  const removeTool = createTool({
    id: 'memory_remove',
    description: 'Archive a single outdated or contradicted memory.',
    inputSchema: z.object({ slug: z.string(), reason: z.string() }),
    execute: async ({ context }) => {
      await db().from('memories').update({ state: 'archived' })
        .eq('user_id', userId).eq('slug', context.slug);
      return { ok: true };
    },
  });

  const subagent = new Agent({
    name: 'memory-consolidator',
    instructions: CONSOLIDATION_PROMPT + '\n\nMemories:\n' +
      JSON.stringify(memories),
    model: PROVIDERS[providerKey],
    tools: { memory_merge: mergeTool, memory_remove: removeTool },
  });

  await subagent.generate(
    [{ role: 'user', content: 'Review and consolidate.' }],
    { maxSteps: 6 },
  );
}
```

**Rationale:** One subagent per user, same cost tier as the extraction
subagent (uses curator provider hint, typically Claude Haiku). Only
two tools (merge + remove) bound the blast radius. The consolidation
prompt is conservative — prefer doing nothing over false merges.

### Step 4: Phase 2 LLM umbrella

**File:** `agent-runtime/src/curator/phase2.ts`

```ts
import { Agent, PROVIDERS } from '../agent';
import { pickProvider } from '../agent/providerRouting';
import { db } from '../db/client';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const UMBRELLA_PROMPT = `
You are reviewing agent-created skills for a single user. Identify
prefix-clusters (skills sharing a slug prefix or theme) and either:
- consolidate them into one umbrella skill, archiving the children, OR
- prune skills that have not been used and offer no unique value, OR
- do nothing (preferred if quality is high).

Quality bar: be conservative. Only consolidate when you can name the
umbrella in one sentence and the children share ≥ 70% surface area.
`;

export async function curatorPhase2() {
  // Get distinct user_ids who have agent-created active skills
  const { data: skills } = await db().from('skills').select('user_id')
    .eq('state', 'active').eq('created_by', 'agent');
  const userIds = [...new Set((skills ?? []).map(s => s.user_id))];

  for (const uid of userIds) {
    await runPhase2ForUser(uid);
  }
}

async function runPhase2ForUser(userId: string) {
  const skills = await db().from('skills').select('slug, frontmatter, body, use_count, last_used_at')
    .eq('user_id', userId).eq('state', 'active').eq('created_by', 'agent').limit(200);
  if ((skills.data ?? []).length < 5) return; // not worth the LLM call

  const providerKey = await pickProvider(userId, 'curator');
  const consolidateTool = createTool({
    id: 'skill_consolidate',
    description: 'Replace N child skills with one umbrella skill.',
    inputSchema: z.object({
      umbrella_slug: z.string(), umbrella_body: z.string(),
      umbrella_frontmatter: z.record(z.unknown()),
      child_slugs: z.array(z.string()),
    }),
    execute: async ({ context }) => {
      await db().from('skills').upsert({
        user_id: userId, slug: context.umbrella_slug,
        body: context.umbrella_body, frontmatter: context.umbrella_frontmatter,
        created_by: 'agent', state: 'active',
      }, { onConflict: 'user_id,slug' });
      await db().from('skills').update({ state: 'archived' })
        .eq('user_id', userId).in('slug', context.child_slugs);
      return { ok: true };
    },
  });

  const pruneTool = createTool({
    id: 'skill_prune',
    description: 'Archive a single low-value skill.',
    inputSchema: z.object({ slug: z.string(), reason: z.string() }),
    execute: async ({ context }) => {
      await db().from('skills').update({ state: 'archived' })
        .eq('user_id', userId).eq('slug', context.slug);
      return { ok: true };
    },
  });

  const subagent = new Agent({
    name: 'curator-umbrella',
    instructions: UMBRELLA_PROMPT + '\n\nSkills:\n' + JSON.stringify(skills.data),
    model: PROVIDERS[providerKey],
    tools: { skill_consolidate: consolidateTool, skill_prune: pruneTool },
  });

  await subagent.generate(
    [{ role: 'user', content: 'Review and consolidate.' }],
    { maxSteps: 6 },
  );
}
```

**Rationale:** One subagent per user (parallelism via `Promise.all`
later if needed). The subagent only has two tools — consolidate and
prune — bounding its blast radius.

### Step 5: Handler + Cloudflare cron

**File:** `agent-runtime/src/curator/handler.ts`

```ts
import type { Context } from 'hono';
import { curatorPhase1 } from './phase1';
import { curatorPhase1_5 } from './phase1_5';
import { snapshotBeforePhase2 } from './backup';
import { curatorPhase2 } from './phase2';
import { db } from '../db/client';

export async function curatorHandler(c: Context) {
  const auth = c.req.header('authorization') ?? '';
  if (auth !== `Bearer ${process.env.CURATOR_TOKEN}`) return c.json({ ok: false }, 401);

  const startedAt = new Date();
  const { data: runRow } = await db().from('curator_runs')
    .insert({ phase: 'cron-start' }).select().single();

  try {
    await curatorPhase1();
    await snapshotBeforePhase2();   // backup before LLM passes
    await curatorPhase1_5();        // memory consolidation (AutoDream)
    await curatorPhase2();          // skill umbrella-builder
    await db().from('curator_runs').update({
      phase: 'cron-success', finished_at: new Date(),
    }).eq('id', runRow!.id);
    return c.json({ ok: true });
  } catch (e) {
    await db().from('curator_runs').update({
      phase: 'cron-error', finished_at: new Date(),
      report: { error: String(e) },
    }).eq('id', runRow!.id);
    return c.json({ ok: false, error: String(e) }, 500);
  }
}
```

**File:** `edge/wrangler.toml` (additions)

```toml
[triggers]
crons = ["0 18 * * SUN"]   # Sunday 02:00 UTC+8

[[unsafe.bindings]]
type = "secret_text"
name = "CURATOR_TOKEN"
```

**File:** `edge/src/cron/curator.ts`

```ts
export async function handleCuratorCron(env: Env) {
  if (!env.CURATOR_TOKEN) {
    console.error('curator cron: CURATOR_TOKEN not set, skipping');
    return;
  }
  // Reuse GATEWAY_BASE_URL (already in wrangler.toml [vars]) — no
  // separate AGENT_RUNTIME_URL needed since the cron target is the
  // same HF Space that receives LINE webhooks.
  const r = await fetch(`${env.GATEWAY_BASE_URL}/admin/curator`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.CURATOR_TOKEN}` },
  });
  if (!r.ok) console.error('curator cron failed', r.status);
}
```

**File:** `edge/src/env.ts` (additions)

```ts
  CURATOR_TOKEN?: string;
```

**File:** `edge/src/index.ts` (additions)

```ts
import { handleCuratorCron } from './cron/curator';

export default {
  fetch: router.fetch,
  scheduled: (_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) =>
    handleCuratorCron(env),
};
```

The `scheduled` export is required for Cloudflare Workers to dispatch
cron triggers. Without it, the cron fires silently with no effect.

**File:** `edge/.dev.vars.example` (additions)

```bash
# --- Curator cron (Worker -> agent-runtime POST /admin/curator) ---
# Must match the agent-runtime's CURATOR_TOKEN exactly.
CURATOR_TOKEN=YOUR_CURATOR_TOKEN_HERE
```

**Rationale:** Cloudflare cron lives outside the HF Space (which has
no scheduler). Worker POSTs the trigger; agent does the work. The
cron handler reuses `GATEWAY_BASE_URL` (already in `wrangler.toml
[vars]`) since the agent-runtime and the LINE webhook gateway are
the same HF Space host — no separate URL var needed.

## Testing Steps

1. Unit-test `phase1.ts` against a seeded DB with skills of varying
   `last_used_at`. Assert state column matches expectations.
2. Unit-test `snapshotBeforePhase2` — insert 6 backups, verify oldest
   is deleted after retention sweep.
3. Integration: seed 10 agent-created skills with a clear prefix
   cluster, run `curatorPhase2`, verify umbrella created + children
   archived.
4. End-to-end: trigger Cloudflare cron manually (`wrangler triggers
   trigger`), verify `curator_runs` shows `cron-success`.

## Dependencies

- Must complete before: container-deploy-cutover (cutover acceptance
  includes "weekly cron fires")
- Depends on: agent-core, persistence, memory-skill-pipeline (which
  populates the skills the curator operates on)

## Notes

- Phase 1 uses three dedicated RPCs (`curator_mark_stale`,
  `curator_archive`, `curator_hard_cap`) defined in `persistence.md`
  step 5. The generic `exec()` / `exec_multi` approach was abandoned
  due to `EXECUTE ... USING text[]` limitations in PL/pgSQL.
- Phase 2 only touches `created_by='agent'` — user-created skills
  (none today, but the path exists) are protected.
- If Phase 2 takes too long for a Cloudflare cron's 30 s wall (it
  won't for our scale — < 100 users), move to a Cloudflare Queue and
  process per-user.
