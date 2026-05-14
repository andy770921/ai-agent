'use client';

import { useEffect, useState } from 'react';
import type { AgentEvent } from '@repo/shared';
import { streamUrl } from '@/lib/apiClient';
import { reconnectingSseStream } from '@/lib/sse/reconnectingSseStream';

export function useEventStream(token: string | null, max = 200) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!token) return;
    const ctrl = new AbortController();

    (async () => {
      for await (const frame of reconnectingSseStream({
        url: streamUrl(),
        token,
        signal: ctrl.signal,
      })) {
        if ('type' in frame) {
          setConnected(frame.type === 'connected');
          continue;
        }
        try {
          const ev = JSON.parse(frame.data) as AgentEvent;
          setEvents((prev) => [ev, ...prev].slice(0, max));
        } catch {
          // skip malformed
        }
      }
    })();

    return () => ctrl.abort();
  }, [token, max]);

  return { events, connected };
}
