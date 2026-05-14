import { reconnectingSseStream, type StreamYield } from './reconnectingSseStream';

function makeResponse(chunks: string[], status = 200): Response {
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(enc.encode(chunks[i]!));
        i++;
      } else {
        controller.close();
      }
    },
  });
  return new Response(body, { status });
}

describe('reconnectingSseStream', () => {
  it('emits connected, frames, then disconnected when stream ends', async () => {
    const ctrl = new AbortController();
    const fetchImpl = jest
      .fn<Promise<Response>, [string, RequestInit]>()
      .mockResolvedValueOnce(makeResponse(['data: a\n\ndata: b\n\n']))
      .mockImplementation(() => {
        ctrl.abort();
        return Promise.resolve(makeResponse([]));
      });

    const out: StreamYield[] = [];
    for await (const frame of reconnectingSseStream({
      url: 'https://x',
      token: 't',
      signal: ctrl.signal,
      reconnectBackoffMs: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })) {
      out.push(frame);
      if (out.length >= 4) break;
    }

    expect(out[0]).toEqual({ type: 'connected' });
    expect(out.slice(1, 3)).toEqual([{ data: 'a' }, { data: 'b' }]);
    expect(out[3]).toEqual({ type: 'disconnected' });
  });

  it('filters out heartbeat frames', async () => {
    const ctrl = new AbortController();
    const fetchImpl = jest
      .fn<Promise<Response>, [string, RequestInit]>()
      .mockResolvedValueOnce(makeResponse(['event: heartbeat\ndata: {}\n\ndata: real\n\n']))
      .mockImplementation(() => {
        ctrl.abort();
        return Promise.resolve(makeResponse([]));
      });

    const out: StreamYield[] = [];
    for await (const frame of reconnectingSseStream({
      url: 'https://x',
      token: 't',
      signal: ctrl.signal,
      reconnectBackoffMs: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })) {
      out.push(frame);
      if (out.length >= 3) break;
    }

    // expected order: connected, real frame, disconnected
    expect(out[0]).toEqual({ type: 'connected' });
    expect(out[1]).toEqual({ data: 'real' });
    expect(out[2]).toEqual({ type: 'disconnected' });
  });

  it('treats non-2xx as a disconnect and reconnects', async () => {
    const ctrl = new AbortController();
    let call = 0;
    const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit]>().mockImplementation(() => {
      call++;
      if (call === 1) return Promise.resolve(makeResponse([], 500));
      ctrl.abort();
      return Promise.resolve(makeResponse([]));
    });

    const seen: StreamYield[] = [];
    for await (const frame of reconnectingSseStream({
      url: 'https://x',
      token: 't',
      signal: ctrl.signal,
      reconnectBackoffMs: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })) {
      seen.push(frame);
      if (seen.length >= 2) break;
    }

    expect(seen[0]).toEqual({ type: 'disconnected' });
    expect(fetchImpl).toHaveBeenCalled();
  });

  it('cancels and reconnects when no data arrives within heartbeatTimeoutMs', async () => {
    const ctrl = new AbortController();
    let connectCount = 0;
    const fetchImpl = jest
      .fn<Promise<Response>, [string, RequestInit]>()
      .mockImplementation(() => {
        connectCount++;
        if (connectCount === 1) {
          // First connection: a stream that connects but never produces frames.
          // The watchdog must cancel this body for the iterator to advance.
          const silent = new ReadableStream<Uint8Array>({
            pull() {
              /* never enqueue, never close */
            },
          });
          return Promise.resolve(new Response(silent, { status: 200 }));
        }
        // Second connection: close immediately and abort the loop.
        ctrl.abort();
        const ended = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        });
        return Promise.resolve(new Response(ended, { status: 200 }));
      });

    const seen: StreamYield[] = [];
    for await (const frame of reconnectingSseStream({
      url: 'https://x',
      token: 't',
      signal: ctrl.signal,
      heartbeatTimeoutMs: 60,
      reconnectBackoffMs: 1,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })) {
      seen.push(frame);
      if (seen.length >= 3) break;
    }

    // After the watchdog fires on the silent stream, the iterator should
    // yield disconnected (not be stuck forever inside reader.read()).
    expect(seen[0]).toEqual({ type: 'connected' });
    expect(seen[1]).toEqual({ type: 'disconnected' });
    expect(connectCount).toBeGreaterThanOrEqual(2);
  });

  it('returns immediately when the signal is already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit]>();

    const seen: StreamYield[] = [];
    for await (const frame of reconnectingSseStream({
      url: 'https://x',
      token: 't',
      signal: ctrl.signal,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })) {
      seen.push(frame);
    }

    expect(seen).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
