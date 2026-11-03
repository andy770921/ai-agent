import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { pingAgentRuntime } from '../src/keepAlive';
import worker, { type Env } from '../src/index';

const realFetch = globalThis.fetch;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function healthy() {
  return new Response(JSON.stringify({ ok: true, uptime: 12.5 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('pingAgentRuntime', () => {
  it('GETs /healthz with a timeout signal and resolves on { ok: true }', async () => {
    const seen: { url: string; init?: RequestInit } = { url: '' };
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      seen.url = url;
      seen.init = init;
      return healthy();
    }) as unknown as typeof fetch;

    await expect(pingAgentRuntime('http://space')).resolves.toBeUndefined();
    expect(seen.url).toBe('http://space/healthz');
    expect(seen.init?.signal).toBeInstanceOf(AbortSignal);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('uptime 12.5s'));
  });

  it('throws on a non-2xx status (e.g. a sleeping Space)', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('sleeping', { status: 503 }),
    ) as unknown as typeof fetch;

    await expect(pingAgentRuntime('http://space')).rejects.toThrow('returned HTTP 503');
  });

  it('throws when the request itself fails', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;

    await expect(pingAgentRuntime('http://space')).rejects.toThrow('unreachable: boom');
  });

  it('throws on a 200 that is not the healthz JSON', async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response('<html>Building…</html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    ) as unknown as typeof fetch;

    await expect(pingAgentRuntime('http://space')).rejects.toThrow('unexpected body');
  });
});

describe('worker.scheduled', () => {
  const env = { GATEWAY_BASE_URL: 'http://gateway' } as Env;
  const controller = {} as ScheduledController;
  const ctx = {} as ExecutionContext;

  it('pings GATEWAY_BASE_URL/healthz', async () => {
    const fetchMock = vi.fn(async () => healthy());
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await worker.scheduled(controller, env, ctx);
    expect(fetchMock).toHaveBeenCalledWith('http://gateway/healthz', expect.anything());
  });

  it('rejects when the ping fails, so the cron invocation is marked failed', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('nope', { status: 502 }),
    ) as unknown as typeof fetch;

    await expect(worker.scheduled(controller, env, ctx)).rejects.toThrow('returned HTTP 502');
  });
});
