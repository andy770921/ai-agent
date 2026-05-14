import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createHttpSidecarClient } from '../src/ports/sidecarClient';

const realFetch = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = realFetch;
});

describe('createHttpSidecarClient', () => {
  it('listSessions forwards Bearer token and preserves content-type', async () => {
    const seen: { url: string; init?: RequestInit } = { url: '' };
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.url = url;
      seen.init = init;
      return new Response(JSON.stringify([{ userId: 'U1' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const client = createHttpSidecarClient('http://sidecar', 'tok');
    const res = await client.listSessions();

    expect(seen.url).toBe('http://sidecar/sessions');
    expect((seen.init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
    expect(res.headers.get('content-type')).toBe('application/json');
  });

  it('returns 502 when fetch throws (network error)', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;

    const client = createHttpSidecarClient('http://sidecar', 'tok');
    const res = await client.listSessions();
    expect(res.status).toBe(502);
  });

  it('getHistory URL-encodes userId and limit', async () => {
    let capturedUrl = '';
    globalThis.fetch = vi.fn(async (url: string) => {
      capturedUrl = url;
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const client = createHttpSidecarClient('http://sidecar', 'tok');
    await client.getHistory('U/weird', 25);
    expect(capturedUrl).toBe('http://sidecar/sessions/U%2Fweird/history?limit=25');
  });

  it('streamEvents returns 502 when upstream is not ok', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('nope', { status: 500 }),
    ) as unknown as typeof fetch;
    const client = createHttpSidecarClient('http://sidecar', 'tok');
    const res = await client.streamEvents();
    expect(res.status).toBe(502);
  });

  it('streamEvents passes the upstream stream through with SSE headers', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response('event: x\ndata: 1\n\n', {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    ) as unknown as typeof fetch;

    const client = createHttpSidecarClient('http://sidecar', 'tok');
    const res = await client.streamEvents();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(await res.text()).toContain('data: 1');
  });
});
