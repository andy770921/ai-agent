import type { BlockedUserReplier } from './blockedUserReplier';
import type { GatewayForwarder } from './gatewayForwarder';
import type { LineSignatureVerifier } from './signatureVerifier';
import type { LineEvent, LinePayload } from './types';
import type { WebhookDedupStore } from './webhookDedupStore';

export interface LineWebhookHandlerDeps {
  verifier: LineSignatureVerifier;
  dedup: WebhookDedupStore;
  forwarder: GatewayForwarder;
  blockedReplier: BlockedUserReplier;
  isUserAllowed: (userId: string | undefined) => boolean;
}

export type LineWebhookHandler = (req: Request, ctx: ExecutionContext) => Promise<Response>;

export function createLineWebhookHandler(deps: LineWebhookHandlerDeps): LineWebhookHandler {
  return async (req, ctx) => {
    const sig = req.headers.get('X-Line-Signature');
    const rawBody = await req.text();
    if (!(await deps.verifier.verify(rawBody, sig))) {
      return new Response(sig ? 'bad sig' : 'missing sig', { status: 401 });
    }

    let payload: LinePayload;
    try {
      payload = JSON.parse(rawBody) as LinePayload;
    } catch {
      return new Response('bad json', { status: 400 });
    }

    const inbound = payload.events ?? [];
    const allowed: LineEvent[] = [];
    const blocked: LineEvent[] = [];
    for (const e of inbound) {
      (deps.isUserAllowed(e.source?.userId) ? allowed : blocked).push(e);
    }

    if (blocked.length > 0) {
      ctx.waitUntil(deps.blockedReplier.notifyBlocked(blocked));
    }
    if (allowed.length === 0) {
      return new Response('ok', { status: 200 });
    }

    const toForward: LineEvent[] = [];
    for (const ev of allowed) {
      if (!ev.webhookEventId) {
        toForward.push(ev);
        continue;
      }
      if (ev.deliveryContext?.isRedelivery) continue;
      const claim = await deps.dedup.claim(ev.webhookEventId);
      if (claim === 'duplicate') continue;
      toForward.push(ev);
    }
    if (toForward.length === 0) return new Response('ok', { status: 200 });

    const idempotencyKey = toForward.map((e) => e.webhookEventId ?? 'noid').join(',');
    const ids = toForward.map((e) => e.webhookEventId).filter((id): id is string => !!id);

    ctx.waitUntil(
      (async () => {
        const { ok, status } = await deps.forwarder.forward(rawBody, sig!, idempotencyKey);
        if (ok) {
          await deps.dedup.markDelivered(ids);
        } else {
          // Leave failed events as 'processing' in the dedup store — they
          // TTL out naturally. A LINE re-delivery carries the same
          // webhookEventId; we skip those by default. To explicitly allow
          // replay after a known upstream outage, delete the dedup key.
          console.error('forward failed', { status, ids });
        }
      })(),
    );

    return new Response('ok', { status: 200 });
  };
}
