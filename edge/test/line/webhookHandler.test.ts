import { describe, it, expect, vi } from 'vitest';
import { createLineWebhookHandler } from '../../src/line/webhookHandler';
import type { LineEvent } from '../../src/line/types';

interface Fakes {
  verifier: { verify: ReturnType<typeof vi.fn> };
  dedup: {
    claim: ReturnType<typeof vi.fn>;
    markDelivered: ReturnType<typeof vi.fn>;
  };
  forwarder: { forward: ReturnType<typeof vi.fn> };
  blockedReplier: { notifyBlocked: ReturnType<typeof vi.fn> };
  isUserAllowed: ReturnType<typeof vi.fn>;
}

function makeFakes(): Fakes {
  return {
    verifier: { verify: vi.fn().mockResolvedValue(true) },
    dedup: {
      claim: vi.fn().mockResolvedValue('claimed'),
      markDelivered: vi.fn().mockResolvedValue(undefined),
    },
    forwarder: { forward: vi.fn().mockResolvedValue({ ok: true, status: 200 }) },
    blockedReplier: { notifyBlocked: vi.fn().mockResolvedValue(undefined) },
    isUserAllowed: vi.fn().mockReturnValue(true),
  };
}

function makeCtx(): { ctx: ExecutionContext; settled: Promise<void> } {
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  return {
    ctx,
    settled: (async () => {
      // Drain everything queued, including waitUntils enqueued from inside others.
      while (pending.length) await pending.shift();
    })(),
  };
}

function makeRequest(body: object | string, sig: string | null = 'sig-ok'): Request {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (sig) headers['X-Line-Signature'] = sig;
  return new Request('https://x/line/webhook', { method: 'POST', body: raw, headers });
}

describe('createLineWebhookHandler', () => {
  it('rejects with 401 when signature verification fails', async () => {
    const f = makeFakes();
    f.verifier.verify.mockResolvedValue(false);
    const handler = createLineWebhookHandler(f);
    const { ctx } = makeCtx();

    const res = await handler(makeRequest({ events: [] }, 'bad'), ctx);
    expect(res.status).toBe(401);
    expect(f.forwarder.forward).not.toHaveBeenCalled();
    expect(f.dedup.claim).not.toHaveBeenCalled();
  });

  it('returns 400 on malformed JSON', async () => {
    const f = makeFakes();
    const handler = createLineWebhookHandler(f);
    const { ctx } = makeCtx();
    const res = await handler(makeRequest('not-json'), ctx);
    expect(res.status).toBe(400);
  });

  it('forwards allowed events once and marks them delivered', async () => {
    const f = makeFakes();
    const handler = createLineWebhookHandler(f);
    const { ctx, settled } = makeCtx();

    const ev: LineEvent = {
      type: 'message',
      replyToken: 'r1',
      webhookEventId: 'evt-1',
      source: { userId: 'U_ok' },
    };
    const res = await handler(makeRequest({ events: [ev] }), ctx);
    await settled;

    expect(res.status).toBe(200);
    expect(f.dedup.claim).toHaveBeenCalledWith('evt-1');
    expect(f.forwarder.forward).toHaveBeenCalledTimes(1);
    const [, sig, idem] = f.forwarder.forward.mock.calls[0]!;
    expect(sig).toBe('sig-ok');
    expect(idem).toBe('evt-1');
    expect(f.dedup.markDelivered).toHaveBeenCalledWith(['evt-1']);
  });

  it('skips events already claimed (duplicate)', async () => {
    const f = makeFakes();
    f.dedup.claim.mockResolvedValueOnce('duplicate');
    const handler = createLineWebhookHandler(f);
    const { ctx, settled } = makeCtx();

    const ev: LineEvent = { webhookEventId: 'evt-dup', source: { userId: 'U_ok' } };
    const res = await handler(makeRequest({ events: [ev] }), ctx);
    await settled;

    expect(res.status).toBe(200);
    expect(f.forwarder.forward).not.toHaveBeenCalled();
  });

  it('skips events with deliveryContext.isRedelivery=true without claiming', async () => {
    const f = makeFakes();
    const handler = createLineWebhookHandler(f);
    const { ctx, settled } = makeCtx();

    const ev: LineEvent = {
      webhookEventId: 'evt-redel',
      deliveryContext: { isRedelivery: true },
      source: { userId: 'U_ok' },
    };
    await handler(makeRequest({ events: [ev] }), ctx);
    await settled;

    expect(f.dedup.claim).not.toHaveBeenCalled();
    expect(f.forwarder.forward).not.toHaveBeenCalled();
  });

  it('notifies blocked users but does not forward their events', async () => {
    const f = makeFakes();
    f.isUserAllowed.mockImplementation((id: string | undefined) => id === 'U_ok');
    const handler = createLineWebhookHandler(f);
    const { ctx, settled } = makeCtx();

    const evs: LineEvent[] = [
      { replyToken: 'r1', webhookEventId: 'a', source: { userId: 'U_ok' } },
      { replyToken: 'r2', webhookEventId: 'b', source: { userId: 'U_blocked' } },
    ];
    await handler(makeRequest({ events: evs }), ctx);
    await settled;

    const blocked: LineEvent[] = f.blockedReplier.notifyBlocked.mock.calls[0]![0];
    expect(blocked.map((e: LineEvent) => e.source?.userId)).toEqual(['U_blocked']);
    expect(f.forwarder.forward).toHaveBeenCalledTimes(1);
    expect(f.dedup.markDelivered).toHaveBeenCalledWith(['a']);
  });

  it('does NOT mark delivered when the gateway returns a non-2xx', async () => {
    const f = makeFakes();
    f.forwarder.forward.mockResolvedValue({ ok: false, status: 500 });
    const handler = createLineWebhookHandler(f);
    const { ctx, settled } = makeCtx();

    const ev: LineEvent = { webhookEventId: 'evt-fail', source: { userId: 'U_ok' } };
    await handler(makeRequest({ events: [ev] }), ctx);
    await settled;

    expect(f.forwarder.forward).toHaveBeenCalled();
    expect(f.dedup.markDelivered).not.toHaveBeenCalled();
  });

  it('returns 200 with no forward when every event is blocked', async () => {
    const f = makeFakes();
    f.isUserAllowed.mockReturnValue(false);
    const handler = createLineWebhookHandler(f);
    const { ctx, settled } = makeCtx();

    const ev: LineEvent = { replyToken: 'r1', source: { userId: 'U_random' } };
    const res = await handler(makeRequest({ events: [ev] }), ctx);
    await settled;

    expect(res.status).toBe(200);
    expect(f.forwarder.forward).not.toHaveBeenCalled();
    expect(f.blockedReplier.notifyBlocked).toHaveBeenCalledTimes(1);
  });
});
