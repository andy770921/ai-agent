'use client';

import { useEffect, useState } from 'react';
import type { SessionSummary } from '@repo/shared';
import { fetchSessions } from '@/lib/apiClient';

const POLL_MS = 10_000;

export function useSessions(token: string | null) {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;

    async function load() {
      try {
        const data = await fetchSessions(token!);
        if (!cancelled) setSessions(data);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    }

    void load();
    const id = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [token]);

  return { sessions, error };
}
