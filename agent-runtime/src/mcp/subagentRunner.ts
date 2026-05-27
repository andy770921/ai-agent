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
      logSubagentSteps(a.taskName, result);
      agentEventBus.emit({
        type: 'tool_result',
        userId: a.userId,
        sessionId: a.sessionId,
        toolName: `task_${a.taskName}`,
        ok: true,
      });
      return softTruncate(result.text);
    } catch (err) {
      const errStr = String(err);
      console.error(`[subagent] task_${a.taskName} attempt ${attempt} failed:`, err);

      // Quota errors: skip retry, return user-friendly message immediately
      if (isQuotaError(errStr)) {
        agentEventBus.emit({
          type: 'tool_result',
          userId: a.userId,
          sessionId: a.sessionId,
          toolName: `task_${a.taskName}`,
          ok: false,
          error: 'LLM quota exceeded',
        });
        return JSON.stringify({
          ok: false,
          task: a.taskName,
          userMessage: 'LLM calling limit exceeded for today. Please try again tomorrow or ask the admin to switch to a paid model.',
        });
      }

      if (attempt >= 2) {
        agentEventBus.emit({
          type: 'tool_result',
          userId: a.userId,
          sessionId: a.sessionId,
          toolName: `task_${a.taskName}`,
          ok: false,
          error: errStr,
        });
        return JSON.stringify({
          ok: false,
          reason: errStr,
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

function isQuotaError(err: string): boolean {
  return /quota|rate.?limit|RESOURCE_EXHAUSTED|429/i.test(err);
}

/**
 * Surface subagent tool interactions. Mastra's `steps` carries the raw
 * tool_call / tool_result payloads that the LLM otherwise paraphrases away
 * in its final text, hiding real MCP / Playwright errors from operators.
 */
function logSubagentSteps(taskName: string, result: unknown): void {
  try {
    const steps = (result as { steps?: Array<Record<string, any>> }).steps ?? [];
    for (const [i, step] of steps.entries()) {
      for (const tc of (step.toolCalls as Array<Record<string, any>>) ?? []) {
        console.log(
          `[subagent:${taskName}] step ${i} call ${tc.toolName}`,
          JSON.stringify(tc.args ?? {}).slice(0, 400),
        );
      }
      for (const tr of (step.toolResults as Array<Record<string, any>>) ?? []) {
        console.log(
          `[subagent:${taskName}] step ${i} result ${tr.toolName}`,
          JSON.stringify(tr.result ?? tr).slice(0, 800),
        );
      }
    }
  } catch (logErr) {
    console.warn(`[subagent:${taskName}] step logging failed:`, logErr);
  }
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
