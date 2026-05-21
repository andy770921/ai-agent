import type { Context } from 'hono';
import { verifyLineSignature } from './signatureVerifier.js';
import { runTurn } from '../agent/runTurn.js';
import { replyOrPush } from './replyOrPush.js';
import { appendUserMessage, appendAssistantMessage } from '../db/messages.js';
import { upsertUser } from '../db/users.js';
import { rememberReplyToken } from './replyTokenStore.js';
import { sessionIdFor } from '../agent/session.js';
import { agentEventBus } from '../observability/bus.js';

interface LineEvent {
  type: string;
  replyToken: string;
  source: { userId: string; type: string; displayName?: string };
  message: { id: string; type: string; text: string };
}

export async function lineWebhookHandler(c: Context) {
  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret) return c.json({ ok: false, error: 'LINE_CHANNEL_SECRET not configured' }, 500);

  const raw = await c.req.text();
  const sig = c.req.header('x-line-signature') ?? '';
  if (!verifyLineSignature(raw, sig, secret))
    return c.json({ ok: false }, 401);

  const payload = JSON.parse(raw) as { events: LineEvent[] };
  processEvents(payload.events).catch((e) =>
    console.error('webhook processEvents', e),
  );
  return c.json({ ok: true });
}

const ALLOWED_USER_IDS = (process.env.LINE_ALLOWED_USER_IDS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

async function processEvents(events: LineEvent[]) {
  for (const ev of events) {
    if (ev.type !== 'message' || ev.message.type !== 'text') continue;
    const userId = ev.source.userId;

    if (
      ALLOWED_USER_IDS.length > 0 &&
      !ALLOWED_USER_IDS.includes(userId)
    )
      continue;

    const sessionId = sessionIdFor(userId);
    rememberReplyToken(userId, ev.replyToken);

    await upsertUser(userId, ev.source.displayName);

    agentEventBus.emit({
      type: 'message_in',
      userId,
      sessionId,
      text: ev.message.text,
    });

    appendUserMessage({
      userId,
      sessionId,
      content: ev.message.text,
    });

    try {
      const result = await runTurn({
        userId,
        sessionId,
        userMessage: ev.message.text,
      });

      appendAssistantMessage({
        userId,
        sessionId,
        content: result.reply,
        langfuseTraceId: result.langfuseTraceId,
      });

      await replyOrPush(userId, result.reply);

      agentEventBus.emit({
        type: 'message_out',
        userId,
        sessionId,
        text: result.reply,
        kind: 'text',
      });
    } catch (e) {
      console.error('runTurn failed', e);
      const errStr = String(e);
      const isQuota = /quota|rate.?limit|RESOURCE_EXHAUSTED|429/i.test(errStr);
      const msg = isQuota
        ? 'LLM calling limit exceeded for today. Please try again tomorrow.'
        : 'Sorry, something went wrong. Please try again.';
      await replyOrPush(userId, msg);
      agentEventBus.emit({
        type: 'message_out',
        userId,
        sessionId,
        text: 'Sorry, something went wrong. Please try again.',
        kind: 'text',
      });
    }
  }
}
