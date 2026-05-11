import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleLineWebhook } from '../src/lineWebhook';
import type { Env } from '../src/env';

const CHANNEL_SECRET = 'test-channel-secret';

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(CHANNEL_SECRET),
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

function makeEnv(overrides: Partial<Env> = {}): Env {
  const kv = new Map<string, string>();
  // KVNamespace.get is heavily overloaded; cast to `unknown` then to
  // KVNamespace because we only exercise the (key: string) → Promise<string|null>
  // overload from production code, and matching every overload here would
  // bloat the test.
  const kvMock = {
    get: vi.fn(async (k: string) => kv.get(k) ?? null),
    put: vi.fn(async (k: string, v: string) => {
      kv.set(k, v);
    }),
  } as unknown as KVNamespace;
  return {
    IMG_KV: {} as KVNamespace,
    WEBHOOK_DEDUP: kvMock,
    GATEWAY_BASE_URL: 'https://gw.test',
    SIDECAR_BASE_URL: 'https://sc.test',
    DASHBOARD_ORIGIN: 'https://dash.test',
    LINE_CHANNEL_SECRET: CHANNEL_SECRET,
    LINE_ALLOWED_USER_IDS: 'U_allowed,U_friend',
    CF_UPLOAD_SECRET: 'cf',
    DASHBOARD_INGEST_TOKEN: 'ingest',
    DASHBOARD_TOKEN: 'dash',
    ...overrides,
  };
}

function makeCtx(): ExecutionContext {
  const waited: Promise<unknown>[] = [];
  return {
    waitUntil(p: Promise<unknown>) {
      waited.push(p);
    },
    passThroughOnException() {},
    props: {},
    // Expose for tests.
    _waited: waited,
  } as unknown as ExecutionContext;
}

describe('handleLineWebhook', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns 401 when signature header is missing', async () => {
    const env = makeEnv();
    const ctx = makeCtx();
    const req = new Request('https://x/line/webhook', { method: 'POST', body: '{}' });
    const res = await handleLineWebhook(req, env, ctx);
    expect(res.status).toBe(401);
  });

  it('returns 401 when signature does not match', async () => {
    const env = makeEnv();
    const ctx = makeCtx();
    const req = new Request('https://x/line/webhook', {
      method: 'POST',
      headers: { 'X-Line-Signature': 'bogus' },
      body: '{"events":[]}',
    });
    const res = await handleLineWebhook(req, env, ctx);
    expect(res.status).toBe(401);
  });

  it('returns 200 and forwards when signature matches and user is allowed', async () => {
    const body = JSON.stringify({
      events: [
        {
          webhookEventId: 'evt-1',
          source: { userId: 'U_allowed' },
          message: { type: 'text', text: 'hi' },
        },
      ],
    });
    const sig = await sign(body);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));

    const env = makeEnv();
    const ctx = makeCtx();
    const req = new Request('https://x/line/webhook', {
      method: 'POST',
      headers: { 'X-Line-Signature': sig },
      body,
    });

    const res = await handleLineWebhook(req, env, ctx);
    expect(res.status).toBe(200);

    // Drain ctx.waitUntil()
    await Promise.all((ctx as unknown as { _waited: Promise<unknown>[] })._waited);
    expect(fetchMock).toHaveBeenCalledOnce();
    const callArgs = fetchMock.mock.calls[0]!;
    expect(callArgs[0]).toBe('https://gw.test/webhook/line');
    expect((callArgs[1]?.headers as Record<string, string>)['X-Line-Signature']).toBe(sig);
    // The raw body is forwarded unchanged so the gateway's HMAC re-verification matches.
    expect(callArgs[1]?.body).toBe(body);
  });

  it('returns 200 and does NOT forward when no users are allowed', async () => {
    const body = JSON.stringify({
      events: [
        {
          webhookEventId: 'evt-2',
          source: { userId: 'U_random_stranger' },
          message: { type: 'text', text: 'hi' },
        },
      ],
    });
    const sig = await sign(body);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));

    const env = makeEnv();
    const ctx = makeCtx();
    const req = new Request('https://x/line/webhook', {
      method: 'POST',
      headers: { 'X-Line-Signature': sig },
      body,
    });

    const res = await handleLineWebhook(req, env, ctx);
    expect(res.status).toBe(200);
    await Promise.all((ctx as unknown as { _waited: Promise<unknown>[] })._waited);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips duplicate webhookEventId on the second call', async () => {
    const body = JSON.stringify({
      events: [
        {
          webhookEventId: 'evt-dup',
          source: { userId: 'U_allowed' },
          message: { type: 'text', text: 'first' },
        },
      ],
    });
    const sig = await sign(body);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));

    const env = makeEnv();
    const ctx1 = makeCtx();
    const req1 = new Request('https://x/line/webhook', {
      method: 'POST',
      headers: { 'X-Line-Signature': sig },
      body,
    });
    await handleLineWebhook(req1, env, ctx1);
    await Promise.all((ctx1 as unknown as { _waited: Promise<unknown>[] })._waited);

    const ctx2 = makeCtx();
    const req2 = new Request('https://x/line/webhook', {
      method: 'POST',
      headers: { 'X-Line-Signature': sig },
      body,
    });
    await handleLineWebhook(req2, env, ctx2);
    await Promise.all((ctx2 as unknown as { _waited: Promise<unknown>[] })._waited);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('skips events marked as isRedelivery even if not in KV', async () => {
    const body = JSON.stringify({
      events: [
        {
          webhookEventId: 'evt-redel',
          deliveryContext: { isRedelivery: true },
          source: { userId: 'U_allowed' },
          message: { type: 'text', text: 'redeliver' },
        },
      ],
    });
    const sig = await sign(body);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));

    const env = makeEnv();
    const ctx = makeCtx();
    const req = new Request('https://x/line/webhook', {
      method: 'POST',
      headers: { 'X-Line-Signature': sig },
      body,
    });
    await handleLineWebhook(req, env, ctx);
    await Promise.all((ctx as unknown as { _waited: Promise<unknown>[] })._waited);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
