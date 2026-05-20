import { Agent, PROVIDERS } from './index.js';
import { getSystemPrompt } from './systemPrompt.js';
import { pickProvider } from './providerRouting.js';
import { loadRecentMessages } from '../db/messages.js';
import { findRelevantMemories } from '../db/memories.js';
import { findRelevantSkills } from '../db/skills.js';
import { composeSystem } from './composeSystem.js';
import { taskBrowserTool, taskGithubTool, sendImageTool } from '../mcp/parentTools.js';
import { getLangfuse } from '../observability/langfuse.js';

export interface TurnInput {
  userId: string;
  userMessage: string;
  sessionId: string;
}

export interface TurnResult {
  reply: string;
  toolCallCount: number;
  langfuseTraceId: string;
}

export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const { userId, userMessage, sessionId } = input;
  const [system, history, memories, skills, providerKey] = await Promise.all([
    getSystemPrompt(),
    loadRecentMessages({ userId, sessionId, limit: 50 }),
    findRelevantMemories({ userId, query: userMessage, limit: 10 }),
    findRelevantSkills({ userId, query: userMessage }),
    pickProvider(userId, 'main'),
  ]);

  const agent = new Agent({
    name: 'line-bot',
    instructions: composeSystem(
      system,
      memories,
      skills.map((s) => s.body),
    ),
    model: PROVIDERS[providerKey],
    tools: { sendImageTool, taskBrowserTool, taskGithubTool },
  });

  const messages = [
    ...history.map(toAiMessage),
    { role: 'user' as const, content: userMessage },
  ];

  const langfuse = getLangfuse();
  const trace = langfuse?.trace({
    name: 'line-message',
    userId,
    sessionId,
    input: userMessage,
    metadata: { providerKey },
  });

  const generation = trace?.generation({
    name: 'runTurn',
    model: providerKey,
    input: messages,
  });

  const result = await agent.generate(messages, { maxSteps: 8 });

  const toolCallCount = result.steps?.flatMap(
    (s: Record<string, unknown>) => (s.toolCalls as unknown[]) ?? [],
  ).length ?? 0;

  generation?.end({ output: result.text, metadata: { toolCallCount } });
  trace?.update({ output: result.text });

  return {
    reply: result.text,
    toolCallCount,
    langfuseTraceId: trace?.id ?? '',
  };
}

function toAiMessage(row: Record<string, unknown>) {
  const role = row.role as string;
  const content = (row.content as { text?: string })?.text ?? '';
  if (role === 'assistant') return { role: 'assistant' as const, content };
  return { role: 'user' as const, content };
}
