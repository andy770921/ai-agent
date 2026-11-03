import { Agent, PROVIDERS } from './index.js';
import { RuntimeContext } from '@mastra/core/di';
import { getSystemPrompt } from './systemPrompt.js';
import { pickProvider } from './providerRouting.js';
import { loadRecentMessages, type StoredMessage } from '../store/messageStore.js';
import { findRelevantMemories } from '../store/memoryStore.js';
import { findRelevantSkills } from '../store/skillStore.js';
import { composeSystem } from './composeSystem.js';
import { taskBrowserTool, taskGithubTool, sendImageTool } from '../mcp/parentTools.js';
import { getLangfuse } from '../observability/langfuse.js';
import { MAX_OUTPUT_TOKENS } from '../config/agentConfig.js';

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
    // Keys are the tool names the model sees; keep them equal to the tool ids the
    // system prompt refers to (task_browser / task_github / send_image).
    tools: {
      send_image: sendImageTool,
      task_browser: taskBrowserTool,
      task_github: taskGithubTool,
    },
  });

  const messages = [...history.map(toAiMessage), { role: 'user' as const, content: userMessage }];

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

  const runtimeContext = new RuntimeContext();
  runtimeContext.set('userId', userId);
  runtimeContext.set('sessionId', sessionId);

  const result = await agent.generate(messages, {
    maxSteps: 8,
    maxTokens: MAX_OUTPUT_TOKENS,
    runtimeContext,
  });

  const toolCallCount =
    result.steps?.flatMap((s: Record<string, unknown>) => (s.toolCalls as unknown[]) ?? [])
      .length ?? 0;

  generation?.end({ output: result.text, metadata: { toolCallCount } });
  trace?.update({ output: result.text });

  return {
    reply: result.text,
    toolCallCount,
    langfuseTraceId: trace?.id ?? '',
  };
}

function toAiMessage(row: StoredMessage) {
  const content = row.content?.text ?? '';
  if (row.role === 'assistant') return { role: 'assistant' as const, content };
  return { role: 'user' as const, content };
}
