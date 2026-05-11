'use client';

import { useEffect, useRef, useState } from 'react';
import type { AgentEvent } from '@repo/shared';
import { streamUrl } from '@/lib/apiClient';

const HEARTBEAT_TIMEOUT_MS = 30_000;
const RECONNECT_BACKOFF_MS = 2_000;

export function useEventStream(token: string | null, max = 200) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!token) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    (async () => {
      while (!ctrl.signal.aborted) {
        try {
          const r = await fetch(streamUrl(), {
            headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
            signal: ctrl.signal,
          });
          if (!r.ok || !r.body) throw new Error(`stream ${r.status}`);
          setConnected(true);

          const reader = r.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          let lastDataAt = Date.now();

          const heartbeatCheck = setInterval(() => {
            if (Date.now() - lastDataAt > HEARTBEAT_TIMEOUT_MS) {
              clearInterval(heartbeatCheck);
              setConnected(false);
              reader.cancel();
            }
          }, 5_000);

          try {
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              lastDataAt = Date.now();
              buf += dec.decode(value, { stream: true });
              let sep;
              while ((sep = buf.indexOf('\n\n')) !== -1) {
                const frame = buf.slice(0, sep);
                buf = buf.slice(sep + 2);
                const lines = frame.split('\n');
                const eventLine = lines.find((l) => l.startsWith('event:'));
                if (eventLine && eventLine.trim() === 'event: heartbeat') continue;
                const dataLine = lines.find((l) => l.startsWith('data:'));
                if (!dataLine) continue;
                try {
                  const ev = JSON.parse(dataLine.slice(5).trim()) as AgentEvent;
                  setEvents((prev) => [ev, ...prev].slice(0, max));
                } catch {
                  // skip malformed
                }
              }
            }
          } finally {
            clearInterval(heartbeatCheck);
          }
        } catch {
          setConnected(false);
          if (ctrl.signal.aborted) return;
          await new Promise((res) => setTimeout(res, RECONNECT_BACKOFF_MS));
        }
      }
    })();

    return () => ctrl.abort();
  }, [token, max]);

  return { events, connected };
}
