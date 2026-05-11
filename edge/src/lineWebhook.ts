import { isAllowedUser } from './allowlist';
import type { Env } from './env';

interface LineEvent {
  webhookEventId?: string;
  deliveryContext?: { isRedelivery?: boolean };
  source?: { userId?: string };
}

interface LinePayload {
  events?: LineEvent[];
}

const DEDUP_TTL_SECONDS = 600;

export async function handleLineWebhook(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const sig = req.headers.get('X-Line-Signature');
  if (!sig) return new Response('missing sig', { status: 401 });

  const rawBody = await req.text();
  const expected = await hmacSha256Base64(env.LINE_CHANNEL_SECRET, rawBody);
  if (!constantTimeEqual(sig, expected)) {
    return new Response('bad sig', { status: 401 });
  }

  let payload: LinePayload;
  try {
    payload = JSON.parse(rawBody) as LinePayload;
  } catch {
    return new Response('bad json', { status: 400 });
  }

  // 1. Allowlist filter (edge fast-fail; gateway re-applies its own allowlist).
  const inboundEvents = payload.events ?? [];
  const allowedEvents = inboundEvents.filter((e) =>
    isAllowedUser(e.source?.userId, env.LINE_ALLOWED_USER_IDS),
  );
  if (allowedEvents.length === 0) return new Response('ok', { status: 200 });

  // 2. Dedup against webhookEventId — skip events already seen.
  const eventsToForward: LineEvent[] = [];
  for (const ev of allowedEvents) {
    if (!ev.webhookEventId) {
      eventsToForward.push(ev);
      continue;
    }
    const key = `evt:${ev.webhookEventId}`;
    const seen = await env.WEBHOOK_DEDUP.get(key);
    if (seen || ev.deliveryContext?.isRedelivery) {
      continue;
    }
    await env.WEBHOOK_DEDUP.put(key, 'processing', { expirationTtl: DEDUP_TTL_SECONDS });
    eventsToForward.push(ev);
  }
  if (eventsToForward.length === 0) return new Response('ok', { status: 200 });

  // 3. Forward rawBody unchanged to the gateway so its HMAC re-verification
  // succeeds. The gateway has its own allowlist (openab.toml [gateway].allowed_users)
  // which will filter the same events again — that's intentional.
  const idempotencyKey = eventsToForward
    .map((e) => e.webhookEventId ?? 'noid')
    .join(',');

  ctx.waitUntil(
    (async () => {
      try {
        const r = await fetch(`${env.GATEWAY_BASE_URL}/webhook/line`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Line-Signature': sig,
            'idempotency-key': idempotencyKey,
          },
          body: rawBody,
        });
        if (!r.ok) {
          await markFailed(env, eventsToForward, `upstream ${r.status}`);
        } else {
          await markDelivered(env, eventsToForward);
        }
      } catch (err) {
        await markFailed(env, eventsToForward, String(err));
      }
    })(),
  );

  return new Response('ok', { status: 200 });
}

async function markDelivered(env: Env, events: LineEvent[]): Promise<void> {
  await Promise.all(
    events
      .filter((e) => e.webhookEventId)
      .map((e) =>
        env.WEBHOOK_DEDUP.put(`evt:${e.webhookEventId}`, 'delivered', {
          expirationTtl: DEDUP_TTL_SECONDS,
        }),
      ),
  );
}

async function markFailed(env: Env, events: LineEvent[], reason: string): Promise<void> {
  // Leave failed events as `processing` in KV — they'll TTL out naturally.
  // A LINE re-delivery carries the same webhookEventId; we skip those by default.
  // To explicitly allow replay after a known upstream outage, run:
  //   wrangler kv:key delete --binding=WEBHOOK_DEDUP evt:<id>
  console.error('forward failed', reason, events.map((e) => e.webhookEventId));
}

async function hmacSha256Base64(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  let bin = '';
  const view = new Uint8Array(sig);
  for (let i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]!);
  return btoa(bin);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
