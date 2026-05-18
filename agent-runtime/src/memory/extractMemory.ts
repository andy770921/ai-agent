import { Agent, PROVIDERS } from '../agent/index.js';
import { pickProvider } from '../agent/providerRouting.js';
import { db } from '../db/client.js';
import { loadRecentMessages } from '../db/messages.js';
import { gateMemoryExtraction } from './gateCheck.js';
import { withAdvisoryLock } from '../db/locks.js';
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
- Always convert relative dates to absolute dates when saving.

## What to watch for
- **Corrections** ("no", "don't", "stop doing X") → save as feedback_ memory.
- **Confirmations** ("yes exactly", "perfect") → ALSO save as feedback_ memory.

## What NOT to save
- Things derivable from the system prompt
- Ephemeral details (what the user just ordered today)
- Information already present in existing memories
- Raw transcript excerpts — distil into a single fact

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
      user_id: userId,
      phase: 'extract-attempt',
    });

    const [transcript, existing, providerKey] = await Promise.all([
      loadRecentMessages({ userId, sessionId, limit: 20 }),
      db()
        .from('memories')
        .select('slug, title')
        .eq('user_id', userId)
        .eq('state', 'active')
        .limit(50),
      pickProvider(userId, 'extractor'),
    ]);

    const listTool = createTool({
      id: 'memory_list',
      description: 'List existing active memories for this user.',
      inputSchema: z.object({}),
      execute: async () => {
        const r = await db()
          .from('memories')
          .select('slug, title, category')
          .eq('user_id', userId)
          .eq('state', 'active')
          .order('last_used_at', {
            ascending: false,
            nullsFirst: false,
          })
          .limit(50);
        return (r.data ?? [])
          .map(
            (m: Record<string, string>) =>
              `${m.slug} [${m.category}]: ${m.title}`,
          )
          .join('\n');
      },
    });

    const saveTool = createTool({
      id: 'memory_save',
      description: 'Save a NEW memory (fails if slug already exists).',
      inputSchema: z.object({
        slug: z.string(),
        category: z.enum(['user', 'feedback', 'project', 'reference']),
        title: z.string(),
        body: z.string(),
      }),
      execute: async ({ context }) => {
        const { error } = await db().from('memories').insert({
          user_id: userId,
          slug: context.slug,
          category: context.category,
          title: context.title,
          body: context.body,
        });
        if (error) return { ok: false, error: error.message };
        return { ok: true };
      },
    });

    const patchTool = createTool({
      id: 'memory_patch',
      description:
        'Update an existing memory by slug. Only updates fields you provide.',
      inputSchema: z.object({
        slug: z.string(),
        title: z.string().optional(),
        body: z.string().optional(),
        category: z
          .enum(['user', 'feedback', 'project', 'reference'])
          .optional(),
      }),
      execute: async ({ context }) => {
        const updates: Record<string, unknown> = {};
        if (context.title) updates.title = context.title;
        if (context.body) updates.body = context.body;
        if (context.category) updates.category = context.category;
        const { error } = await db()
          .from('memories')
          .update(updates)
          .eq('user_id', userId)
          .eq('slug', context.slug);
        if (error) return { ok: false, error: error.message };
        return { ok: true };
      },
    });

    const subagent = new Agent({
      name: 'memory-extractor',
      instructions: EXTRACT_PROMPT.replace(
        '{{existing_index}}',
        (existing.data ?? [])
          .map(
            (m: Record<string, string>) => `- ${m.slug}: ${m.title}`,
          )
          .join('\n'),
      ).replace(
        '{{transcript}}',
        transcript
          .map(
            (m: Record<string, unknown>) =>
              `${m.role}: ${JSON.stringify(m.content)}`,
          )
          .join('\n'),
      ),
      model: PROVIDERS[providerKey],
      tools: {
        memory_list: listTool,
        memory_save: saveTool,
        memory_patch: patchTool,
      },
    });

    await subagent.generate(
      [{ role: 'user', content: 'Extract memories now.' }],
      { maxSteps: 5 },
    );

    await db().from('curator_runs').insert({
      user_id: userId,
      phase: 'extract-success',
    });
    return { skipped: false };
  });
}
