# Implementation Plan: Observability Shim (OTel → AgentEvent → SSE + Langfuse)

## Overview

Mastra emits OpenTelemetry spans. Two consumers need the data:

1. **Langfuse** — already takes OTel; wire `langfuse-vercel`'s
   `LangfuseSpanProcessor` into Mastra's telemetry config. Done.
2. **Dashboard SSE** — `frontend/` consumes the `AgentEvent` union
   from `shared/src/types/agent-events.ts`. This is *not* an OTel
   format; a shim translates.

The existing sidecar primitives (`agentEventBus`, `ringBufferSink`,
`sseFanoutSink`) port to TS and survive. The Gemini-JSONL parser
(`events-emitter.js`) and Langfuse sink go away.

## Files to Modify

- `agent-runtime/src/observability/bus.ts` — port of
  `agent-runtime/scripts/lib/agentEventBus.js` to TS
- `agent-runtime/src/observability/ringBufferSink.ts` — ditto
- `agent-runtime/src/observability/sseFanoutSink.ts` — ditto
- `agent-runtime/src/observability/sse.ts` — Hono handlers
  (`/events/stream`, `/sessions`, `/sessions/:id/history`)
- `agent-runtime/src/observability/mastraToAgentEvent.ts` — NEW; OTel
  span subscriber that emits `AgentEvent`
- `shared/src/types/agent-events.ts` — extend with `SessionEnded`
  variant
- `agent-runtime/scripts/lib/*.js` — DELETE after migration verified

## Step-by-Step Implementation

### Step 1: Extend AgentEvent union

**File:** `shared/src/types/agent-events.ts` (additions)

> **IMPORTANT:** The existing `AgentEvent` union uses `type` as the
> discriminant (e.g. `type: 'message_in'`), `sessionUserId` as a single
> combined field, and `ts: string`. The new runtime MUST emit the **existing**
> shape to avoid breaking the frontend dashboard (PRD Success Criterion #7).
> Internally the bus can carry richer fields, but anything sent over SSE must
> conform to the current contract.

```ts
// Add to the existing AgentEventBase-based union:
export interface SessionEnded extends AgentEventBase {
  type: 'session_ended';
}

// Update existing union
export type AgentEvent =
  | AgentMessageIn | AgentToolCall | AgentToolResult | AgentMessageOut
  | SessionEnded;
```

**Rationale:** Pipelines need session-end (memory + skill triggers).
Existing dashboard ignores unknown variants — backward compatible.
The `type` discriminant and `sessionUserId` field match the existing
contract so no frontend changes are required.

### Step 2: Event bus (port)

**File:** `agent-runtime/src/observability/bus.ts`

> **Note:** Internally the bus uses a richer `BusEvent` shape with separate
> `userId` / `sessionId` fields for convenience. The SSE handler in `sse.ts`
> maps these to the existing `AgentEvent` contract (`sessionUserId`,
> `ts: string`, `type` discriminant) before sending to the frontend.

```ts
// Internal bus event — richer than the SSE wire format.
// The SSE handler (sse.ts) maps to the existing AgentEvent shape.
export interface BusEvent {
  type: 'message_in' | 'tool_call' | 'tool_result' | 'message_out' | 'session_ended';
  userId: string;
  sessionId: string;
  ts?: number;
  // variant-specific fields
  text?: string;
  tool?: string;
  args?: unknown;
  ok?: boolean;
  error?: string;
  durationMs?: number;
  kind?: 'text' | 'image';
  imageUrl?: string;
  attempt?: number;
  parentTraceId?: string;
}

type Listener = (ev: BusEvent) => void | Promise<void>;
const listeners = new Set<Listener>();

export const agentEventBus = {
  on(fn: Listener) { listeners.add(fn); return () => listeners.delete(fn); },
  emit(ev: BusEvent) {
    const stamped = { ...ev, ts: ev.ts ?? Date.now() };
    for (const fn of listeners) {
      try { void fn(stamped); } catch (e) { console.error('bus listener', e); }
    }
  },
};
```

**Rationale:** Synchronous fan-out, listeners must not block. Direct
port of the JS version. Uses an internal `BusEvent` shape that is mapped
to the existing `AgentEvent` contract at the SSE boundary.

### Step 3: Ring buffer + history endpoint

**File:** `agent-runtime/src/observability/ringBufferSink.ts`

```ts
import type { AgentEvent } from '@repo/shared';
import { agentEventBus } from './bus';

const PER_SESSION_LIMIT = 200;
const TOTAL_SESSION_LIMIT = 100;
const buf = new Map<string, AgentEvent[]>();

agentEventBus.on(ev => {
  const key = `${ev.userId}:${ev.sessionId}`;
  const list = buf.get(key) ?? [];
  list.push(ev);
  if (list.length > PER_SESSION_LIMIT) list.shift();
  buf.set(key, list);
  if (buf.size > TOTAL_SESSION_LIMIT) {
    const oldest = buf.keys().next().value;
    buf.delete(oldest);
  }
});

export function getSessionHistory(userId: string, sessionId: string): AgentEvent[] {
  return buf.get(`${userId}:${sessionId}`) ?? [];
}

export function listSessions() {
  return [...buf.keys()].map(k => {
    const [userId, ...rest] = k.split(':');
    return { userId, sessionId: rest.join(':') };
  });
}
```

**Rationale:** In-process buffer keeps dashboard fast. DB is the
durable record (`messages` table) — buffer is just for live tailing.

### Step 4: SSE fanout + Hono handlers

**File:** `agent-runtime/src/observability/sse.ts`

```ts
import type { Context } from 'hono';
import { agentEventBus } from './bus';
import { getSessionHistory, listSessions } from './ringBufferSink';

export async function sseStreamHandler(c: Context) {
  const auth = c.req.header('authorization') ?? '';
  if (auth !== `Bearer ${process.env.DASHBOARD_INGEST_TOKEN}`)
    return c.json({ ok: false }, 401);

  return new Response(new ReadableStream({
    start(controller) {
      const unsubscribe = agentEventBus.on(ev => {
        controller.enqueue(`data: ${JSON.stringify(ev)}\n\n`);
      });
      const ka = setInterval(() => controller.enqueue(': keepalive\n\n'), 15_000);
      c.req.raw.signal?.addEventListener('abort', () => {
        clearInterval(ka); unsubscribe(); controller.close();
      });
    },
  }), {
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
```

**Rationale:** Plain SSE — same shape `frontend/src/lib/sse/` already
consumes. Auth via bearer header (matches existing pattern). Keepalive
every 15 s.

### Step 5: Mastra OTel → AgentEvent shim

**File:** `agent-runtime/src/observability/mastraToAgentEvent.ts`

```ts
import { agentEventBus } from './bus';
import type { ReadableSpan, SpanProcessor } from '@opentelemetry/sdk-trace-base';
import type { AgentEvent } from '@repo/shared';

// Mastra emits OTel spans for: agent.generate, tool.execute, llm.call, etc.
// We translate the *interesting* ones into AgentEvent.
export class AgentEventSpanProcessor implements SpanProcessor {
  forceFlush() { return Promise.resolve(); }
  shutdown() { return Promise.resolve(); }
  onStart() {}
  onEnd(span: ReadableSpan) {
    const userId = String(span.attributes['app.user_id'] ?? '');
    const sessionId = String(span.attributes['app.session_id'] ?? '');
    if (!userId) return;

    const ev = translate(span, userId, sessionId);
    if (ev) agentEventBus.emit(ev);
  }
}

function translate(span: ReadableSpan, userId: string, sessionId: string): AgentEvent | null {
  const name = span.name;
  if (name === 'tool.execute') {
    return {
      kind: 'AgentToolCall',
      userId, sessionId,
      toolName: String(span.attributes['tool.name'] ?? 'unknown'),
      attempt: Number(span.attributes['tool.attempt'] ?? 1),
    } as AgentEvent;
  }
  // tool.result, llm.response, etc. — add as we observe them in week 2
  return null;
}
```

Register in `agent/index.ts`:

```ts
// There is no `MultiSpanProcessor` in @opentelemetry/sdk-trace-base.
// Instead, use a tiny composite that fans out to both processors.
import { LangfuseSpanProcessor } from 'langfuse-vercel';
import { AgentEventSpanProcessor } from '../observability/mastraToAgentEvent';

class CompositeSpanProcessor implements SpanProcessor {
  constructor(private processors: SpanProcessor[]) {}
  forceFlush() { return Promise.all(this.processors.map(p => p.forceFlush())).then(() => {}); }
  shutdown() { return Promise.all(this.processors.map(p => p.shutdown())).then(() => {}); }
  onStart(span: Span, ctx: Context) { this.processors.forEach(p => p.onStart(span, ctx)); }
  onEnd(span: ReadableSpan) { this.processors.forEach(p => p.onEnd(span)); }
}

export const mastra = new Mastra({
  telemetry: {
    serviceName: 'agent-runtime',
    sampling: { type: 'always_on' },
    export: { type: 'custom', exporter: new CompositeSpanProcessor([
      new LangfuseSpanProcessor(),
      new AgentEventSpanProcessor(),
    ]) },
  },
});
```

**Rationale:** OTel allows multiple span processors but does not provide
a built-in composite class. Our `CompositeSpanProcessor` fans out to
both. Langfuse gets the full OTel payload (rich traces); the shim only
emits the events the dashboard's `AgentEvent` consumer expects.

**Build out the `translate` function in week 5** based on the actual
OTel attribute names Mastra emits. The skeleton is here; the rest is
empirical.

### Step 6: Direct bus emits

The `AgentMessageIn` / `AgentMessageOut` events are emitted directly
by `webhookHandler.ts` (already specced in `line-adapter.md` step 3).
`SessionEnded` is emitted by `sessionEndDetector.ts`
(`memory-skill-pipeline.md` step 1). `AgentToolCall` / `AgentToolResult`
come from the OTel shim. **Coverage check** before declaring done:

| Event variant | Source |
|---|---|
| `AgentMessageIn` | `webhookHandler.ts` (line-adapter.md) |
| `AgentMessageOut` | `webhookHandler.ts` |
| `AgentToolCall` | `subagentRunner.ts` (direct) + OTel shim (Mastra-internal) |
| `AgentToolResult` | `subagentRunner.ts` (direct) + OTel shim |
| `SessionEnded` | `sessionEndDetector.ts` |

## Testing Steps

1. Unit-test `ringBufferSink` — emit 250 events, verify only 200
   retained for that session.
2. Unit-test SSE handler with mocked event bus — verify each emit
   becomes a `data: ` line.
3. Integration: spin up real Mastra agent, run a turn with one tool
   call, observe events through `/events/stream` and verify all 5
   variants appear in correct order.
4. Smoke: open frontend dashboard against the new runtime, expect
   live tail to look identical to current FEAT-3.

## Dependencies

- Must complete before: container-deploy-cutover
- Depends on: agent-core (Mastra instance to attach span processor)

## Notes

- `MultiSpanProcessor` is `@opentelemetry/sdk-trace-base`'s
  `BatchSpanProcessor` composition pattern; if Mastra doesn't expose
  it, we wrap with a tiny adapter.
- Empirical step in week 5: tail an actual Mastra run, log every span
  with `{ name, attributes }`, decide what to translate.
- `events-emitter.js` (Gemini JSONL parser) is deleted in
  `container-deploy-cutover.md` step 3.
