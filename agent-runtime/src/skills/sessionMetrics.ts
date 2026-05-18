import { agentEventBus } from '../observability/bus.js';

interface Metrics {
  toolCalls: number;
  failedToolCalls: number;
  distinctTools: Set<string>;
}

const sessions = new Map<string, Metrics>();

agentEventBus.on((ev) => {
  if (ev.type !== 'tool_call' && ev.type !== 'tool_result') return;
  const key = `${ev.userId}:${ev.sessionId}`;
  let m = sessions.get(key);
  if (!m) {
    m = { toolCalls: 0, failedToolCalls: 0, distinctTools: new Set() };
    sessions.set(key, m);
  }
  if (ev.type === 'tool_call') {
    m.toolCalls++;
    m.distinctTools.add(ev.toolName ?? ev.tool ?? '');
  }
  if (ev.type === 'tool_result' && !ev.ok) {
    m.failedToolCalls++;
  }
});

export function getAndResetMetrics(userId: string, sessionId: string) {
  const key = `${userId}:${sessionId}`;
  const m = sessions.get(key);
  sessions.delete(key);
  return (
    m ?? {
      toolCalls: 0,
      failedToolCalls: 0,
      distinctTools: new Set<string>(),
    }
  );
}
