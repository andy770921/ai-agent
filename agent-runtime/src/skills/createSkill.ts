import { Agent, PROVIDERS } from '../agent/index.js';
import { pickProvider } from '../agent/providerRouting.js';
import { loadRecentMessages, type StoredMessage } from '../store/messageStore.js';
import { listSkillsForUser, upsertSkill } from '../store/skillStore.js';
import { withAdvisoryLock } from '../store/locks.js';
import { getAndResetMetrics } from './sessionMetrics.js';
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
      Promise.resolve(listSkillsForUser(userId)),
      pickProvider(userId, 'skill-creator'),
    ]);

    const skillCreateTool = createTool({
      id: 'skill_create',
      description: 'Create a new skill (SKILL.md-shaped) or patch an existing umbrella.',
      inputSchema: z.object({
        slug: z.string(),
        body: z.string(),
        frontmatter: z.object({
          name: z.string(),
          description: z.string(),
          requires_toolsets: z.array(z.string()).optional(),
          tags: z.array(z.string()).optional(),
        }),
      }),
      execute: async ({ context }) => {
        upsertSkill({
          userId,
          slug: context.slug,
          body: context.body,
          frontmatter: context.frontmatter,
          createdBy: 'agent',
          state: 'active',
        });
        return { ok: true };
      },
    });

    const subagent = new Agent({
      name: 'skill-creator',
      instructions: buildSkillPrompt(transcript, existing),
      model: PROVIDERS[providerKey],
      tools: { skill_create: skillCreateTool },
    });

    await subagent.generate(
      [
        {
          role: 'user',
          content: 'Decide if a skill is worth creating now.',
        },
      ],
      { maxSteps: 3 },
    );
    return { skipped: false };
  });
}

function buildSkillPrompt(
  transcript: StoredMessage[],
  existing: { slug: string; frontmatter: Record<string, unknown> }[],
): string {
  return `You are a skill librarian. The user just completed a task with multiple tool calls.
Decide whether to create a new skill, patch an existing one, or skip.

Existing skills: ${existing.map((s) => s.slug).join(', ')}
Transcript: ${transcript.map((m) => `${m.role}: ${JSON.stringify(m.content)}`).join('\n')}

Quality bar: only create if this is a repeatable pattern, not a one-off.`;
}
