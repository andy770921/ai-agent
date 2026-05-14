import { parseSseStream, type SseFrame } from './parseSseStream';

export interface ReconnectingSseStreamOptions {
  url: string;
  token: string;
  heartbeatTimeoutMs?: number;
  reconnectBackoffMs?: number;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface StreamStatusEvent {
  type: 'connected' | 'disconnected';
}

export type StreamYield = SseFrame | StreamStatusEvent;

export async function* reconnectingSseStream(
  opts: ReconnectingSseStreamOptions,
): AsyncIterable<StreamYield> {
  const heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? 30_000;
  const reconnectBackoffMs = opts.reconnectBackoffMs ?? 2_000;
  const f = opts.fetchImpl ?? fetch;

  while (!opts.signal.aborted) {
    try {
      const resp = await f(opts.url, {
        headers: {
          authorization: `Bearer ${opts.token}`,
          accept: 'text/event-stream',
        },
        signal: opts.signal,
      });
      if (!resp.ok || !resp.body) throw new Error(`stream ${resp.status}`);

      yield { type: 'connected' };

      // Watchdog cancels the reader (via abort signal) to unblock the pending
      // read() when upstream goes silent — flipping a flag is not enough,
      // and stream.cancel() doesn't work once the reader has locked the stream.
      const inner = new AbortController();
      const watchdog = createHeartbeatWatchdog(heartbeatTimeoutMs, () => inner.abort());

      try {
        for await (const frame of parseSseStream(resp.body, { signal: inner.signal })) {
          watchdog.beat();
          if (frame.event === 'heartbeat') continue;
          yield frame;
        }
      } finally {
        watchdog.stop();
      }
    } catch {
      // fall through to backoff + reconnect
    }

    yield { type: 'disconnected' };
    if (opts.signal.aborted) return;
    await delay(reconnectBackoffMs, opts.signal);
  }
}

function createHeartbeatWatchdog(timeoutMs: number, onTimeout: () => void) {
  let last = Date.now();
  let fired = false;
  const pollMs = Math.max(50, Math.floor(timeoutMs / 4));
  const id = setInterval(() => {
    if (fired) return;
    if (Date.now() - last > timeoutMs) {
      fired = true;
      onTimeout();
    }
  }, pollMs);
  return {
    beat: () => {
      last = Date.now();
    },
    stop: () => clearInterval(id),
  };
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const id = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(id);
        resolve();
      },
      { once: true },
    );
  });
}
