import { describe, it, expect, vi } from 'vitest';
import { createRouter, type Route, type RouteHandler } from '../src/router';

interface E {
  origin: string;
}

const corsHeaders = (env: E) => ({
  'access-control-allow-origin': env.origin,
  'access-control-allow-methods': 'GET, OPTIONS',
});

const ctx = {} as ExecutionContext;
const env: E = { origin: 'https://dash' };

function build(routes: Route<E>[]) {
  return createRouter<E>(routes, { corsHeaders });
}

describe('createRouter', () => {
  it('matches a literal route and passes empty params', async () => {
    const handler: RouteHandler<E> = vi.fn(() => new Response('ok', { status: 200 }));
    const router = build([{ method: 'GET', pattern: '/ping', handler }]);
    const res = await router.fetch(new Request('https://x/ping'), env, ctx);
    expect(res.status).toBe(200);
    const mocked = vi.mocked(handler);
    expect(mocked).toHaveBeenCalledTimes(1);
    expect(mocked.mock.calls[0]![3]).toEqual({});
  });

  it('extracts :param into the params record', async () => {
    let seen: Record<string, string> = {};
    const router = build([
      {
        method: 'GET',
        pattern: '/api/sessions/:userId/history',
        handler: (_req, _env, _ctx, params) => {
          seen = params;
          return new Response('ok');
        },
      },
    ]);
    await router.fetch(new Request('https://x/api/sessions/U%2Fweird/history'), env, ctx);
    expect(seen).toEqual({ userId: 'U/weird' });
  });

  it('returns 404 for an unknown path', async () => {
    const router = build([{ method: 'GET', pattern: '/ping', handler: () => new Response('ok') }]);
    const res = await router.fetch(new Request('https://x/missing'), env, ctx);
    expect(res.status).toBe(404);
  });

  it('returns 404 when method does not match (no shared semantics for 405)', async () => {
    const router = build([{ method: 'GET', pattern: '/ping', handler: () => new Response('ok') }]);
    const res = await router.fetch(new Request('https://x/ping', { method: 'POST' }), env, ctx);
    expect(res.status).toBe(404);
  });

  it('answers OPTIONS preflight with 204 + CORS headers for cors-tagged routes', async () => {
    const router = build([
      {
        method: 'GET',
        pattern: '/api/x',
        cors: true,
        handler: () => new Response('ok'),
      },
    ]);
    const res = await router.fetch(new Request('https://x/api/x', { method: 'OPTIONS' }), env, ctx);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://dash');
  });

  it('does NOT preflight non-cors routes', async () => {
    const router = build([
      { method: 'POST', pattern: '/webhook', handler: () => new Response('ok') },
    ]);
    const res = await router.fetch(
      new Request('https://x/webhook', { method: 'OPTIONS' }),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it('injects CORS headers into responses from cors-tagged routes', async () => {
    const router = build([
      {
        method: 'GET',
        pattern: '/api/x',
        cors: true,
        handler: () => new Response('ok', { status: 200 }),
      },
    ]);
    const res = await router.fetch(new Request('https://x/api/x'), env, ctx);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://dash');
  });

  it('preflights unknown paths under a corsPathPrefixes entry', async () => {
    const router = createRouter<E>(
      [{ method: 'GET', pattern: '/api/sessions', cors: true, handler: () => new Response('ok') }],
      { corsHeaders, corsPathPrefixes: ['/api/'] },
    );
    const res = await router.fetch(
      new Request('https://x/api/this-route-does-not-exist', { method: 'OPTIONS' }),
      env,
      ctx,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://dash');
  });

  it('CORS-wraps the 404 fallback for unknown paths under corsPathPrefixes', async () => {
    const router = createRouter<E>(
      [{ method: 'GET', pattern: '/api/sessions', cors: true, handler: () => new Response('ok') }],
      { corsHeaders, corsPathPrefixes: ['/api/'] },
    );
    const res = await router.fetch(new Request('https://x/api/missing'), env, ctx);
    expect(res.status).toBe(404);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://dash');
  });

  it('also injects CORS headers on 4xx responses from cors-tagged routes', async () => {
    const router = build([
      {
        method: 'GET',
        pattern: '/api/x',
        cors: true,
        handler: () => new Response('nope', { status: 401 }),
      },
    ]);
    const res = await router.fetch(new Request('https://x/api/x'), env, ctx);
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://dash');
  });
});
