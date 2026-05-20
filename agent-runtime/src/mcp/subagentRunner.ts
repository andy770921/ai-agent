import { Agent, PROVIDERS } from '../agent/index.js';
import { pickProvider } from '../agent/providerRouting.js';
import type { MastraMCPClient } from '@mastra/mcp';
import { agentEventBus } from '../observability/bus.js';
import { softTruncate } from './summarise.js';

interface Args {
  userId: string;
  sessionId: string;
  parentTraceId: string;
  taskName: 'browser' | 'github';
  mcpClient: MastraMCPClient;
  prompt: string;
  systemHint: string;
}

export async function runSubagent(a: Args): Promise<string> {
  const providerKey = await pickProvider(a.userId, 'main');
  const tools = await safeListTools(a.mcpClient, a.taskName);
  if (!tools) {
    agentEventBus.emit({
      type: 'tool_result',
      userId: a.userId,
      sessionId: a.sessionId,
      toolName: `task_${a.taskName}`,
      ok: false,
      error: `${a.taskName} MCP unavailable in this environment`,
    });
    return JSON.stringify({
      ok: false,
      task: a.taskName,
      reason: `${a.taskName} MCP unavailable — run "npm install" or rebuild the container image.`,
    });
  }

  const subagent = new Agent({
    name: `subagent-${a.taskName}`,
    instructions: a.systemHint,
    model: PROVIDERS[providerKey],
    tools: tools as Record<string, any>,
  });

  let attempt = 0;
  while (attempt < 2) {
    attempt += 1;
    try {
      agentEventBus.emit({
        type: 'tool_call',
        userId: a.userId,
        sessionId: a.sessionId,
        toolName: `task_${a.taskName}`,
        attempt,
        parentTraceId: a.parentTraceId,
      });
      const result = await subagent.generate(
        [{ role: 'user', content: a.prompt }],
        { maxSteps: 12 },
      );
      agentEventBus.emit({
        type: 'tool_result',
        userId: a.userId,
        sessionId: a.sessionId,
        toolName: `task_${a.taskName}`,
        ok: true,
      });
      return softTruncate(result.text);
    } catch (err) {
      if (attempt >= 2) {
        agentEventBus.emit({
          type: 'tool_result',
          userId: a.userId,
          sessionId: a.sessionId,
          toolName: `task_${a.taskName}`,
          ok: false,
          error: String(err),
        });
        return JSON.stringify({
          ok: false,
          reason: String(err),
          task: a.taskName,
        });
      }
    }
  }
  return JSON.stringify({
    ok: false,
    reason: 'exhausted retries',
    task: a.taskName,
  });
}

async function safeListTools(client: MastraMCPClient, mcpName: string) {
  try {
    // MastraMCPClient requires connect() before tools() can be called.
    // connect() spawns the stdio subprocess; tools() returns the tool map.
    const c = client as unknown as {
      connect(): Promise<void>;
      tools(): Promise<Record<string, unknown>>;
    };
    await c.connect();
    return await c.tools();
  } catch (err) {
    console.warn(`[mcp] ${mcpName} not available: ${String(err)}`);
    return null;
  }
}
