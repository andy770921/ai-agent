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

// Cache connected tools per MCP client to avoid reconnecting every call.
const toolsCache = new Map<string, Record<string, unknown>>();

export async function runSubagent(a: Args): Promise<string> {
  const providerKey = await pickProvider(a.userId, 'main');
  const tools = await getOrConnectTools(a.mcpClient, a.taskName);
  if (!tools) {
    const msg = `${a.taskName} MCP unavailable in this environment`;
    console.error(`[subagent] ${msg}`);
    agentEventBus.emit({
      type: 'tool_result',
      userId: a.userId,
      sessionId: a.sessionId,
      toolName: `task_${a.taskName}`,
      ok: false,
      error: msg,
    });
    return JSON.stringify({
      ok: false,
      task: a.taskName,
      reason: `${a.taskName} MCP unavailable — rebuild the container image.`,
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
      console.error(`[subagent] task_${a.taskName} attempt ${attempt} failed:`, err);
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

/** Connect once and cache; reconnect on failure. */
async function getOrConnectTools(
  client: MastraMCPClient,
  mcpName: string,
): Promise<Record<string, unknown> | null> {
  const cached = toolsCache.get(mcpName);
  if (cached) return cached;

  try {
    const c = client as unknown as {
      connect(): Promise<void>;
      disconnect(): Promise<void>;
      tools(): Promise<Record<string, unknown>>;
    };
    await c.connect();
    const tools = await c.tools();
    const count = Object.keys(tools).length;
    console.log(`[mcp] ${mcpName} connected: ${count} tools`);
    toolsCache.set(mcpName, tools);
    return tools;
  } catch (err) {
    console.error(`[mcp] ${mcpName} connect failed:`, err);
    return null;
  }
}
