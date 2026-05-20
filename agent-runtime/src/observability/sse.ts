import type { Context } from 'hono';
import { agentEventBus, type BusEvent } from './bus.js';
import { getSessionHistory, listSessions } from './ringBufferSink.js';
// Inlined from @repo/shared — agent-runtime deploys standalone on HF Spaces
// without access to the monorepo shared workspace.
interface AgentEventBase {
  sessionUserId: string;
  ts: string;
}
type AgentEvent =
  | (AgentEventBase & { type: 'message_in'; text: string })
  | (AgentEventBase & { type: 'tool_call'; tool: string; args: unknown })
  | (AgentEventBase & { type: 'tool_result'; tool: string; durationMs: number; ok: boolean; error?: string })
  | (AgentEventBase & { type: 'message_out'; text: string; kind: 'text' | 'image'; imageUrl?: string })
  | (AgentEventBase & { type: 'session_ended' });

/** Map internal BusEvent → existing AgentEvent wire format for dashboard. */
function toWireEvent(ev: BusEvent): AgentEvent {
  const base: AgentEventBase = {
    sessionUserId: ev.userId,
    ts: new Date(ev.ts ?? Date.now()).toISOString(),
  };

  switch (ev.type) {
    case 'message_in':
      return { ...base, type: 'message_in', text: ev.text ?? '' };
    case 'tool_call':
      return {
        ...base,
        type: 'tool_call',
        tool: ev.toolName ?? ev.tool ?? '',
        args: ev.args ?? {},
      };
    case 'tool_result':
      return {
        ...base,
        type: 'tool_result',
        tool: ev.toolName ?? ev.tool ?? '',
        durationMs: ev.durationMs ?? 0,
        ok: ev.ok ?? true,
        error: ev.error,
      };
    case 'message_out':
      return {
        ...base,
        type: 'message_out',
        text: ev.text ?? '',
        kind: ev.kind ?? 'text',
        imageUrl: ev.imageUrl,
      };
    case 'session_ended':
      return { ...base, type: 'session_ended' };
  }
}

export async function sseStreamHandler(c: Context) {
  const auth = c.req.header('authorization') ?? '';
  if (auth !== `Bearer ${process.env.DASHBOARD_INGEST_TOKEN}`)
    return c.json({ ok: false }, 401);

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const unsubscribe = agentEventBus.on((ev) => {
        const wire = toWireEvent(ev);
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(wire)}\n\n`),
        );
      });
      const ka = setInterval(
        () => controller.enqueue(encoder.encode(': keepalive\n\n')),
        15_000,
      );
      c.req.raw.signal?.addEventListener('abort', () => {
        clearInterval(ka);
        unsubscribe();
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
    },
  });
}

export async function sessionsHandler(c: Context) {
  const auth = c.req.header('authorization') ?? '';
  if (auth !== `Bearer ${process.env.DASHBOARD_INGEST_TOKEN}`)
    return c.json({ ok: false }, 401);
  return c.json(listSessions());
}

export async function sessionHistoryHandler(c: Context) {
  const auth = c.req.header('authorization') ?? '';
  if (auth !== `Bearer ${process.env.DASHBOARD_INGEST_TOKEN}`)
    return c.json({ ok: false }, 401);
  const id = c.req.param('id') ?? '';
  const [userId, ...rest] = id.split(':');
  const events = getSessionHistory(userId, rest.join(':'));
  return c.json(events.map(toWireEvent));
}
