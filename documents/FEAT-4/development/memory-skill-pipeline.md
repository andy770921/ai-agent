# Implementation Plan: Memory + Skill Pipeline

## Overview

Both pipelines share infrastructure: they fire on session-end, are
gated by Postgres advisory locks, and each delegates to a Mastra
subagent (no separate LLM client). Memory extraction rewrites the
canonical fact in English (CJK-FTS dodge) and categorises into
`user_/feedback_/project_/reference_*`. Skill creation triggers when
the session had ≥ 5 tool calls without unrecovered errors.

## Files to Modify

- `agent-runtime/src/memory/sessionEndDetector.ts` — emits
  session-end when no message activity for 30 s
- `agent-runtime/src/memory/extractMemory.ts` — extraction subagent
- `agent-runtime/src/memory/gateCheck.ts` — 5-gate trigger
- `agent-runtime/src/skills/createSkill.ts` — skill-create subagent
- `agent-runtime/src/skills/sessionMetrics.ts` — counts tool calls,
  errors per session
- `agent-runtime/src/db/locks.ts` — Postgres advisory-lock helper
- Hook registration in `agent-runtime/src/server.ts`: subscribe to
  `agentEventBus` for session-end events

## Step-by-Step Implementation

### Step 1: Session-end detector

**File:** `agent-runtime/src/memory/sessionEndDetector.ts`

```ts
import { agentEventBus } from '../observability/bus';

const IDLE_MS = 30_000;
const timers = new Map<string, NodeJS.Timeout>();

agentEventBus.on(ev => {
  if (ev.kind !== 'AgentMessageOut') return;
  const key = `${ev.userId}:${ev.sessionId}`;
  if (timers.has(key)) clearTimeout(timers.get(key)!);
  timers.set(key, setTimeout(() => {
    timers.delete(key);
    agentEventBus.emit({
      kind: 'SessionEnded',
      userId: ev.userId, sessionId: ev.sessionId,
    });
  }, IDLE_MS));
});

agentEventBus.on(ev => {
  if (ev.kind !== 'AgentMessageIn') return;
  const key = `${ev.userId}:${ev.sessionId}`;
  if (timers.has(key)) { clearTimeout(timers.get(key)!); timers.delete(key); }
});
```

**Rationale:** Cheap pure-JS heuristic. New user message resets the
timer; 30 s of silence = "done". No DB writes here — just emit an
event.

### Step 2: Gate check (5-gate trigger from cc-haha)

**File:** `agent-runtime/src/memory/gateCheck.ts`

```ts
import { db } from '../db/client';

export interface GateResult { allow: boolean; reason?: string }

export async function gateMemoryExtraction(userId: string): Promise<GateResult> {
  const cfg = await db().from('agent_config').select('value')
    .eq('key', 'memory_extraction_enabled').single();
  if (cfg.data?.value !== 'true') return { allow: false, reason: 'feature_flag_off' };

  const r = await db().rpc('memory_extraction_stats', { p_user_id: userId });

  const row = r.data?.[0];
  if (row?.since_last_success < 86400) return { allow: false, reason: 'cooldown_24h' };
  if (row?.since_last_attempt < 600) return { allow: false, reason: 'throttle_10m' };
  if ((row?.new_sessions ?? 0) < 5) return { allow: false, reason: 'sessions_under_5' };
  return { allow: true };
}
```

**Rationale:** All 5 cc-haha gates in one SQL call. The Postgres
advisory lock (Gate 5) is acquired inside the extractor itself, not
here, because we want atomicity with the work.

### Step 3: Memory extraction subagent

**File:** `agent-runtime/src/memory/extractMemory.ts`

```ts
import { Agent, PROVIDERS } from '../agent';
import { pickProvider } from '../agent/providerRouting';
import { db } from '../db/client';
import { loadRecentMessages } from '../db/messages';
import { gateMemoryExtraction } from './gateCheck';
import { withAdvisoryLock } from '../db/locks';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

const EXTRACT_PROMPT = `
You are a memory curator. Read the transcript below and decide what to remember.

## Rules
- Each memory must be a single fact in ENGLISH (translate if needed).
- Category prefix: user_ (preferences/profile), feedback_ (corrections),
  project_ (active topics), reference_ (external resources).
- Slug: lowercase snake_case, ≤ 60 chars, no duplicates of existing slugs.
- Use memory_list first to see what already exists.
- If a memory already exists with the same slug, use memory_patch to update it.
- Only use memory_save for genuinely new facts.
- If nothing is worth saving, save nothing. Quality > quantity.
- Hard cap: at most 5 new/patched memories per session.
- Always convert relative dates to absolute dates when saving
  (e.g. "Thursday" → "2026-05-22"), so the memory stays valid over time.

## What to watch for
- **Corrections** ("no", "don't", "stop doing X") → save as feedback_ memory.
- **Confirmations** ("yes exactly", "perfect", accepting without pushback)
  → ALSO save as feedback_ memory. If you only save corrections, the agent
  drifts away from validated approaches and grows overly cautious.
- For feedback memories, structure body as: rule, then **Why:** line (the
  reason), then **How to apply:** line (when this guidance kicks in).

## What NOT to save
- Things derivable from the system prompt (bakery menu, store hours, persona)
- Ephemeral details (what the user just ordered today, current weather)
- Information already present in existing memories (check memory_list first)
- Raw transcript excerpts — distil into a single fact

## Before recommending from memory (for the main agent)
A memory that names a specific fact is a claim about when it was written.
It may be outdated. If the memory is >1 day old, flag it as potentially
stale. "The memory says X" is not the same as "X is still true."

Existing memory titles:
{{existing_index}}

Transcript:
{{transcript}}
`;

export async function extractMemory(userId: string, sessionId: string) {
  const gate = await gateMemoryExtraction(userId);
  if (!gate.allow) return { skipped: true, reason: gate.reason };

  return withAdvisoryLock(`memory:${userId}`, async () => {
    await db().from('curator_runs').insert({
      user_id: userId, phase: 'extract-attempt',
    });

    const [transcript, existing, providerKey] = await Promise.all([
      loadRecentMessages({ userId, sessionId, limit: 20 }),
      db().from('memories').select('slug, title')
        .eq('user_id', userId).eq('state', 'active').limit(50),
      pickProvider(userId, 'extractor'),
    ]);

    const listTool = createTool({
      id: 'memory_list',
      description: 'List existing active memories for this user (slug + title).',
      inputSchema: z.object({}),
      execute: async () => {
        const r = await db().from('memories').select('slug, title, category')
          .eq('user_id', userId).eq('state', 'active')
          .order('last_used_at', { ascending: false, nullsFirst: false }).limit(50);
        return (r.data ?? []).map(m => `${m.slug} [${m.category}]: ${m.title}`).join('\n');
      },
    });

    const saveTool = createTool({
      id: 'memory_save',
      description: 'Save a NEW memory (fails if slug already exists for this user).',
      inputSchema: z.object({
        slug: z.string(), category: z.enum(['user','feedback','project','reference']),
        title: z.string(), body: z.string(),
      }),
      execute: async ({ context }) => {
        const { error } = await db().from('memories').insert({
          user_id: userId, slug: context.slug, category: context.category,
          title: context.title, body: context.body,
        });
        if (error) return { ok: false, error: error.message };
        return { ok: true };
      },
    });

    const patchTool = createTool({
      id: 'memory_patch',
      description: 'Update an existing memory by slug. Only updates fields you provide.',
      inputSchema: z.object({
        slug: z.string(),
        title: z.string().optional(),
        body: z.string().optional(),
        category: z.enum(['user','feedback','project','reference']).optional(),
      }),
      execute: async ({ context }) => {
        const updates: Record<string, unknown> = {};
        if (context.title) updates.title = context.title;
        if (context.body) updates.body = context.body;
        if (context.category) updates.category = context.category;
        const { error } = await db().from('memories').update(updates)
          .eq('user_id', userId).eq('slug', context.slug);
        if (error) return { ok: false, error: error.message };
        return { ok: true };
      },
    });

    const subagent = new Agent({
      name: 'memory-extractor',
      instructions: EXTRACT_PROMPT
        .replace('{{existing_index}}',
          (existing.data ?? []).map(m => `- ${m.slug}: ${m.title}`).join('\n'))
        .replace('{{transcript}}',
          transcript.map(m => `${m.role}: ${JSON.stringify(m.content)}`).join('\n')),
      model: PROVIDERS[providerKey],
      tools: { memory_list: listTool, memory_save: saveTool, memory_patch: patchTool },
    });

    await subagent.generate(
      [{ role: 'user', content: 'Extract memories now.' }],
      { maxSteps: 5 },
    );

    await db().from('curator_runs').insert({
      user_id: userId, phase: 'extract-success',
    });
    return { skipped: false };
  });
}
```

**Rationale:** Subagent decides on its own what to save (via tool
calls). EXTRACT_PROMPT is our own prose (Hermes' is copyrightable). The
English-rewrite rule sidesteps CJK FTS.

### Step 4: Advisory lock helper

**File:** `agent-runtime/src/db/locks.ts`

```ts
import { db } from './client';

// Pass the raw string to the SQL RPC; the server-side function handles
// hashing via `hashtextextended(lock_key, 0)`. No client-side hash
// needed — avoids the double-hashing bug from the earlier draft.
export async function withAdvisoryLock<T>(name: string, fn: () => Promise<T>): Promise<T | { skipped: true; reason: 'lock_held' }> {
  const ack = await db().rpc('try_advisory_lock', { lock_key: name });
  if (!ack.data) return { skipped: true, reason: 'lock_held' };
  try { return await fn(); }
  finally {
    await db().rpc('advisory_unlock', { lock_key: name });
  }
}
```

**Rationale:** Postgres session-level advisory lock. The SQL function
`try_advisory_lock(text)` hashes the string via `hashtextextended`
server-side — no need to hash client-side (the earlier draft
double-hashed). Released in `finally` even on throw. On container crash
the lock auto-releases at session disconnect.

### Step 5: Skill creation pipeline

**File:** `agent-runtime/src/skills/sessionMetrics.ts`

```ts
import { agentEventBus } from '../observability/bus';

interface Metrics { toolCalls: number; failedToolCalls: number; distinctTools: Set<string> }
const sessions = new Map<string, Metrics>();

agentEventBus.on(ev => {
  const key = `${ev.userId}:${ev.sessionId}`;
  let m = sessions.get(key);
  if (!m) { m = { toolCalls: 0, failedToolCalls: 0, distinctTools: new Set() }; sessions.set(key, m); }
  if (ev.kind === 'AgentToolCall') { m.toolCalls++; m.distinctTools.add(ev.toolName); }
  if (ev.kind === 'AgentToolResult' && !ev.ok) m.failedToolCalls++;
});

export function getAndResetMetrics(userId: string, sessionId: string) {
  const key = `${userId}:${sessionId}`;
  const m = sessions.get(key); sessions.delete(key);
  return m ?? { toolCalls: 0, failedToolCalls: 0, distinctTools: new Set() };
}
```

**File:** `agent-runtime/src/skills/createSkill.ts`

```ts
import { Agent, PROVIDERS } from '../agent';
import { pickProvider } from '../agent/providerRouting';
import { db } from '../db/client';
import { loadRecentMessages } from '../db/messages';
import { withAdvisoryLock } from '../db/locks';
import { getAndResetMetrics } from './sessionMetrics';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

export async function maybeCreateSkill(userId: string, sessionId: string) {
  const m = getAndResetMetrics(userId, sessionId);
  if (m.toolCalls < 5) return { skipped: true, reason: 'tool_calls_under_5' };
  if (m.failedToolCalls > 0 && m.failedToolCalls === m.toolCalls)
    return { skipped: true, reason: 'all_failed' };
  if (m.distinctTools.size < 2) return { skipped: true, reason: 'single_tool_only' };

  return withAdvisoryLock(`skill:${userId}`, async () => {
    const [transcript, existing, providerKey] = await Promise.all([
      loadRecentMessages({ userId, sessionId, limit: 30 }),
      db().from('skills').select('slug, frontmatter')
        .or(`user_id.eq.${userId},user_id.is.null`).limit(50),
      pickProvider(userId, 'skill-creator'),
    ]);

    const createTool_ = createTool({
      id: 'skill_create',
      description: 'Create a new skill (SKILL.md-shaped) or patch an existing umbrella.',
      inputSchema: z.object({
        slug: z.string(), body: z.string(),
        frontmatter: z.object({
          name: z.string(), description: z.string(),
          requires_toolsets: z.array(z.string()).optional(),
          tags: z.array(z.string()).optional(),
        }),
      }),
      execute: async ({ context }) => {
        await db().from('skills').upsert({
          user_id: userId, slug: context.slug, body: context.body,
          frontmatter: context.frontmatter, created_by: 'agent', state: 'active',
        }, { onConflict: 'user_id,slug' });
        return { ok: true };
      },
    });

    const subagent = new Agent({
      name: 'skill-creator',
      instructions: SKILL_PROMPT(transcript, existing.data ?? []),
      model: PROVIDERS[providerKey],
      tools: { skill_create: createTool_ },
    });

    await subagent.generate(
      [{ role: 'user', content: 'Decide if a skill is worth creating now.' }],
      { maxSteps: 3 },
    );
    return { skipped: false };
  });
}

function SKILL_PROMPT(transcript: any[], existing: any[]): string {
  return `You are a skill librarian. The user just completed a task with multiple tool calls.
Decide whether to create a new skill, patch an existing one, or skip.

Existing skills: ${existing.map(s => s.slug).join(', ')}
Transcript: ${transcript.map(m => `${m.role}: ${JSON.stringify(m.content)}`).join('\n')}

Quality bar: only create if this is a repeatable pattern, not a one-off.`;
}
```

**Rationale:** Same shape as memory pipeline — gate, lock, subagent
with a single write tool. `created_by: 'agent'` always (we don't
expose this tool to the parent agent — only the curator subagent).

### Step 6: Server wiring

**File:** `agent-runtime/src/server.ts` (additions)

```ts
import { agentEventBus } from './observability/bus';
import { extractMemory } from './memory/extractMemory';
import { maybeCreateSkill } from './skills/createSkill';

agentEventBus.on(async ev => {
  if (ev.kind !== 'SessionEnded') return;
  // Fire both pipelines in parallel; each gates itself
  Promise.all([
    extractMemory(ev.userId, ev.sessionId),
    maybeCreateSkill(ev.userId, ev.sessionId),
  ]).catch(e => console.error('session-end pipelines', e));
});
```

**Rationale:** Both pipelines self-gate, so we don't need orchestration
here. Failures log; LINE user never sees them.

## Testing Steps

1. Unit-test `sessionEndDetector` — emit AgentMessageOut, no AgentMessageIn for 30 s, expect SessionEnded.
2. Unit-test `gateMemoryExtraction` — seed `curator_runs` with various
   ages, verify each gate triggers the right reason.
3. Unit-test `withAdvisoryLock` — two parallel calls, only one runs.
4. Integration test: simulate 6 tool calls across 2 distinct tools,
   trigger session-end, verify a row appears in `skills`.
5. Acceptance: PRD criterion #4 (memory persists day-to-day) and #5
   (skill auto-create).

## Dependencies

- Must complete before: curator (curator runs Phase 2 on agent-created skills)
- Depends on: agent-core, persistence, mcp-subagent-dispatch

## Notes

- Both extractors use the `extractor` / `skill-creator` provider hints
  (typically Gemini Flash for cost). Override per-role via
  `agent_config` keys.
- `getAndResetMetrics` clears state on read — call exactly once per
  session-end.
- Hard 5-memory cap per session prevents pathological prompts.
