# Implementation Plan: LINE Adapter + Hono Server

## Overview

Replaces `openab-gateway` (Rust). One Hono server hosts every HTTP
endpoint the container needs. The LINE adapter handles webhook
signature re-verification, dispatches to `runTurn()`, and replies via
hybrid Reply (free, 50 s window) → Push (paid, fallback).

## Files to Modify

- `agent-runtime/src/server.ts` — new; Hono app + route registration
- `agent-runtime/src/line/webhookHandler.ts` — new
- `agent-runtime/src/line/signatureVerifier.ts` — new (or import from
  `edge/src/line/signatureVerifier.ts` — extract to `shared/`)
- `agent-runtime/src/line/replyOrPush.ts` — new
- `agent-runtime/src/line/lineClient.ts` — new (axios/fetch wrapper)
- `agent-runtime/src/line/replyTokenStore.ts` — new (in-memory; per-user)
- `agent-runtime/scripts/deliver-line-image.sh` — KEEP, but invoked
  from `sendImageTool` (a Mastra tool), not from the Gemini policy
  shell allowlist

### Shared

- Move `edge/src/line/signatureVerifier.ts` → `shared/src/line/signatureVerifier.ts`
- Edge worker re-imports from `@repo/shared`

## Step-by-Step Implementation

### Step 1: Hono server skeleton

**File:** `agent-runtime/src/server.ts`

```ts
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { lineWebhookHandler } from './line/webhookHandler';
import { sseStreamHandler, sessionsHandler, sessionHistoryHandler }
  from './observability/sse';
import { imageUploadHandler } from './ports/imageStore';
import { healthzHandler } from './ports/healthz';
import { curatorHandler } from './curator/handler';
import { flushQueue } from './db/writeQueue';

const app = new Hono();

app.post('/webhook/line', lineWebhookHandler);
app.get('/events/stream', sseStreamHandler);
app.get('/sessions', sessionsHandler);
app.get('/sessions/:id/history', sessionHistoryHandler);
app.post('/img', imageUploadHandler);
app.get('/healthz', healthzHandler);
app.post('/admin/curator', curatorHandler);

const port = Number(process.env.PORT ?? 7860);
serve({ fetch: app.fetch, port });
console.log(`agent-runtime listening on :${port}`);

// Graceful shutdown: flush pending DB writes before exit.
// HF Spaces sends SIGTERM → 30 s grace → SIGKILL.
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, flushing write queue…');
  await flushQueue();
  process.exit(0);
});
```

**Rationale:** Single port = no `hf-proxy.js` needed. HF Spaces only
exposes 7860; everything goes through it.

### Step 2: LINE signature verifier

**File:** `shared/src/line/signatureVerifier.ts`

Extract verbatim from `edge/src/line/signatureVerifier.ts`. Same HMAC
SHA-256 over the raw body, base64-encoded, constant-time compare.

**File:** `agent-runtime/src/line/signatureVerifier.ts`

```ts
export { verifyLineSignature } from '@repo/shared/line/signatureVerifier';
```

**Rationale:** Defence in depth — the edge Worker already verifies,
but anyone able to call the HF Space directly bypasses the Worker. The
agent re-verifies with the same `LINE_CHANNEL_SECRET`.

### Step 3: Webhook handler

**File:** `agent-runtime/src/line/webhookHandler.ts`

```ts
import type { Context } from 'hono';
import { verifyLineSignature } from './signatureVerifier';
import { runTurn } from '../agent/runTurn';
import { replyOrPush } from './replyOrPush';
import { appendUserMessage, appendAssistantMessage } from '../db/messages';
import { upsertUser } from '../db/users';
import { rememberReplyToken } from './replyTokenStore';
import { sessionIdFor } from '../agent/session';
import { agentEventBus } from '../observability/bus';

export async function lineWebhookHandler(c: Context) {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret) return c.json({ ok: false, error: 'LINE_CHANNEL_SECRET not configured' }, 500);

  const raw = await c.req.text();
  const sig = c.req.header('x-line-signature') ?? '';
  if (!verifyLineSignature(raw, sig, secret))
    return c.json({ ok: false }, 401);

  const payload = JSON.parse(raw);
  // Respond 200 immediately — LINE retries on slow responses.
  // @hono/node-server has no executionCtx.waitUntil(); fire-and-forget.
  processEvents(payload.events).catch(e => console.error('webhook processEvents', e));
  return c.json({ ok: true });
}

const ALLOWED_USER_IDS = (process.env.LINE_ALLOWED_USER_IDS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean);

async function processEvents(events: LineEvent[]) {
  for (const ev of events) {
    if (ev.type !== 'message' || ev.message.type !== 'text') continue;
    const userId = ev.source.userId;

    // Access control: skip users not in the allowlist (if configured)
    if (ALLOWED_USER_IDS.length > 0 && !ALLOWED_USER_IDS.includes(userId)) continue;

    const sessionId = sessionIdFor(userId);
    rememberReplyToken(userId, ev.replyToken);

    // Ensure user row exists (messages FK requires it)
    await upsertUser(userId, ev.source.displayName);

    agentEventBus.emit({ kind: 'AgentMessageIn', userId, sessionId, text: ev.message.text });
    await appendUserMessage({ userId, sessionId, content: ev.message.text });
    const result = await runTurn({ userId, sessionId, userMessage: ev.message.text });
    await appendAssistantMessage({
      userId, sessionId, content: result.reply, langfuseTraceId: result.langfuseTraceId,
    });
    await replyOrPush(userId, result.reply);
    agentEventBus.emit({ kind: 'AgentMessageOut', userId, sessionId, text: result.reply });
  }
}
```

**Rationale:** Webhook returns 200 immediately (LINE timeout is short);
event processing is fire-and-forget (`@hono/node-server` does not
support `c.executionCtx.waitUntil()` — that is a Cloudflare Workers
API). `upsertUser` runs before `appendUserMessage` because the
`messages` table has an FK to `users(user_id)`. `LINE_ALLOWED_USER_IDS`
mirrors the edge Worker's existing allowlist behaviour. Message
persistence happens around `runTurn`, not inside, so `agent/runTurn`
stays pure.

### Step 4: Reply token store

**File:** `agent-runtime/src/line/replyTokenStore.ts`

```ts
interface Entry { token: string; expiresAt: number }
const store = new Map<string, Entry>();
const TTL_MS = 50_000; // LINE replyToken lifetime

export function rememberReplyToken(userId: string, token: string) {
  store.set(userId, { token, expiresAt: Date.now() + TTL_MS });
}

export function consumeReplyToken(userId: string): string | null {
  const e = store.get(userId);
  if (!e) return null;
  store.delete(userId);
  return e.expiresAt > Date.now() ? e.token : null;
}
```

**Rationale:** In-process Map is fine — single-container deployment.
Token consumed on send (single-use per LINE docs).

### Step 5: Hybrid Reply/Push

**File:** `agent-runtime/src/line/replyOrPush.ts`

```ts
import { consumeReplyToken } from './replyTokenStore';
import { lineReply, linePush } from './lineClient';

export async function replyOrPush(userId: string, text: string) {
  const token = consumeReplyToken(userId);
  if (token) {
    try { await lineReply(token, text); return; }
    catch (e) { /* fall through to push */ }
  }
  await linePush(userId, text);
}
```

**Rationale:** Try free reply first, fall back to paid push. Matches
the upstream OpenAB-gateway behaviour exactly.

### Step 6: LINE API client

**File:** `agent-runtime/src/line/lineClient.ts`

```ts
const BASE = 'https://api.line.me/v2/bot/message';

async function call(path: string, body: unknown) {
  const r = await fetch(`${BASE}/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`LINE ${path} ${r.status}: ${await r.text()}`);
  return r.json();
}

export const lineReply = (replyToken: string, text: string) =>
  call('reply', { replyToken, messages: [{ type: 'text', text }] });

export const linePush = (to: string, text: string) =>
  call('push', { to, messages: [{ type: 'text', text }] });

export const linePushImage = (to: string, originalContentUrl: string, previewImageUrl: string) =>
  call('push', { to, messages: [{ type: 'image', originalContentUrl, previewImageUrl }] });
```

**Rationale:** ~40 lines replaces `openab-gateway`'s LINE delivery
code. No external SDK — fetch is enough.

## Testing Steps

1. Unit-test `verifyLineSignature` against the fixture in
   `edge/test/line/signatureVerifier.test.ts`.
2. Unit-test `replyOrPush` — mock both `lineReply` and `linePush`,
   verify the fallback path when reply throws.
3. Unit-test `replyTokenStore` — TTL expiry, consume-once semantics.
4. Integration: send a signed webhook payload via supertest, expect 200
   in < 100 ms and a follow-up Mastra call (mocked).

## Dependencies

- Must complete before: container-deploy-cutover
- Depends on: agent-core (for `runTurn`)

## Notes

- LINE webhook payload schema lives in
  `shared/src/line/webhook-types.ts` (extract from edge worker).
- `@hono/node-server` does NOT have `executionCtx.waitUntil()`. Use
  fire-and-forget with `.catch()` instead. Verify no unhandled
  rejections in production.
- `LINE_ALLOWED_USER_IDS` env var is comma-separated. If empty or
  unset, all LINE users are accepted (matches current edge Worker
  behaviour).
