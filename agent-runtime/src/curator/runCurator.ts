import { Agent, PROVIDERS } from '../agent/index.js';
import { pickProvider } from '../agent/providerRouting.js';
import { db } from '../db/client.js';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

// ── Public entry ────────────────────────────────────────────────────
export async function runCurator() {
  await sqlTransitions();
  await snapshotActiveSkills();
  await consolidateMemories();
  await consolidateSkills();
}

// ── 1. SQL state transitions (no LLM) ───────────────────────────────
async function sqlTransitions() {
  await db().rpc('curator_mark_stale', { days: 30 });
  await db().rpc('curator_archive', { days: 90 });
  await db().rpc('curator_hard_cap', { max_active: 500 });
}

// ── 2. Backup snapshot ──────────────────────────────────────────────
async function snapshotActiveSkills() {
  const skills = await db()
    .from('skills')
    .select('*')
    .eq('state', 'active')
    .eq('created_by', 'agent');
  if ((skills.data ?? []).length === 0) return;

  await db().from('curator_backups').insert({
    affected_table: 'skills',
    snapshot: skills.data,
    row_count: skills.data!.length,
  });
  await db().rpc('curator_backup_retain', { keep: 5 });
}

// ── 3. Memory consolidation (LLM per user) ──────────────────────────
const MEMORY_CONSOLIDATION_PROMPT = `
You are reviewing a user's memory bank for quality. For each issue found:
1. Merge near-duplicates (same fact stated differently) into one memory
2. Resolve contradictions (two memories disagree) — keep the more recent
3. Convert relative dates to absolute if any remain
4. Remove memories that are no longer true based on more recent memories

Be conservative — only act on clear issues. Do nothing if quality is high.
`;

async function consolidateMemories() {
  const { data: rows } = await db()
    .from('memories')
    .select('user_id')
    .eq('state', 'active');
  const userIds = [
    ...new Set(
      (rows ?? []).map((m: Record<string, string>) => m.user_id),
    ),
  ];
  for (const uid of userIds) await consolidateMemoriesForUser(uid);
}

async function consolidateMemoriesForUser(userId: string) {
  const { data: memories } = await db()
    .from('memories')
    .select('slug, title, body, category, updated_at, use_count')
    .eq('user_id', userId)
    .eq('state', 'active')
    .limit(200);
  if ((memories ?? []).length < 5) return;

  const providerKey = await pickProvider(userId, 'curator');

  const mergeTool = createTool({
    id: 'memory_merge',
    description:
      'Merge N duplicate memories into one, archiving the rest.',
    inputSchema: z.object({
      keep_slug: z.string(),
      updated_body: z.string(),
      archive_slugs: z.array(z.string()),
    }),
    execute: async ({ context }) => {
      await db()
        .from('memories')
        .update({ body: context.updated_body })
        .eq('user_id', userId)
        .eq('slug', context.keep_slug);
      await db()
        .from('memories')
        .update({ state: 'archived' })
        .eq('user_id', userId)
        .in('slug', context.archive_slugs);
      return { ok: true };
    },
  });

  const removeTool = createTool({
    id: 'memory_remove',
    description: 'Archive a single outdated or contradicted memory.',
    inputSchema: z.object({ slug: z.string(), reason: z.string() }),
    execute: async ({ context }) => {
      await db()
        .from('memories')
        .update({ state: 'archived' })
        .eq('user_id', userId)
        .eq('slug', context.slug);
      return { ok: true };
    },
  });

  const subagent = new Agent({
    name: 'memory-consolidator',
    instructions:
      MEMORY_CONSOLIDATION_PROMPT +
      '\n\nMemories:\n' +
      JSON.stringify(memories),
    model: PROVIDERS[providerKey],
    tools: { memory_merge: mergeTool, memory_remove: removeTool },
  });

  await subagent.generate(
    [{ role: 'user', content: 'Review and consolidate.' }],
    { maxSteps: 6 },
  );
}

// ── 4. Skill umbrella-builder (LLM per user) ────────────────────────
const SKILL_UMBRELLA_PROMPT = `
You are reviewing agent-created skills for a single user. Identify
prefix-clusters (skills sharing a slug prefix or theme) and either:
- consolidate them into one umbrella skill, archiving the children, OR
- prune skills that have not been used and offer no unique value, OR
- do nothing (preferred if quality is high).

Quality bar: be conservative. Only consolidate when you can name the
umbrella in one sentence and the children share ≥ 70% surface area.
`;

async function consolidateSkills() {
  const { data: rows } = await db()
    .from('skills')
    .select('user_id')
    .eq('state', 'active')
    .eq('created_by', 'agent');
  const userIds = [
    ...new Set(
      (rows ?? []).map((s: Record<string, string>) => s.user_id),
    ),
  ];
  for (const uid of userIds) await consolidateSkillsForUser(uid);
}

async function consolidateSkillsForUser(userId: string) {
  const { data: skills } = await db()
    .from('skills')
    .select('slug, frontmatter, body, use_count, last_used_at')
    .eq('user_id', userId)
    .eq('state', 'active')
    .eq('created_by', 'agent')
    .limit(200);
  if ((skills ?? []).length < 5) return;

  const providerKey = await pickProvider(userId, 'curator');

  const consolidateTool = createTool({
    id: 'skill_consolidate',
    description: 'Replace N child skills with one umbrella skill.',
    inputSchema: z.object({
      umbrella_slug: z.string(),
      umbrella_body: z.string(),
      umbrella_frontmatter: z.record(z.unknown()),
      child_slugs: z.array(z.string()),
    }),
    execute: async ({ context }) => {
      await db().from('skills').upsert(
        {
          user_id: userId,
          slug: context.umbrella_slug,
          body: context.umbrella_body,
          frontmatter: context.umbrella_frontmatter,
          created_by: 'agent',
          state: 'active',
        },
        { onConflict: 'user_id,slug' },
      );
      await db()
        .from('skills')
        .update({ state: 'archived' })
        .eq('user_id', userId)
        .in('slug', context.child_slugs);
      return { ok: true };
    },
  });

  const pruneTool = createTool({
    id: 'skill_prune',
    description: 'Archive a single low-value skill.',
    inputSchema: z.object({ slug: z.string(), reason: z.string() }),
    execute: async ({ context }) => {
      await db()
        .from('skills')
        .update({ state: 'archived' })
        .eq('user_id', userId)
        .eq('slug', context.slug);
      return { ok: true };
    },
  });

  const subagent = new Agent({
    name: 'curator-umbrella',
    instructions:
      SKILL_UMBRELLA_PROMPT + '\n\nSkills:\n' + JSON.stringify(skills),
    model: PROVIDERS[providerKey],
    tools: { skill_consolidate: consolidateTool, skill_prune: pruneTool },
  });

  await subagent.generate(
    [{ role: 'user', content: 'Review and consolidate.' }],
    { maxSteps: 6 },
  );
}
