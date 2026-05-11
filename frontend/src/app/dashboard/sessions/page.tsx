'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { AgentEvent } from '@repo/shared';
import { useDashboardToken } from '@/hooks/useDashboardToken';
import { useEventStream } from '@/hooks/useEventStream';
import { useSessions } from '@/hooks/useSessions';
import { fetchHistory } from '@/lib/apiClient';
import { SessionList } from '@/components/dashboard/SessionList';
import { Timeline } from '@/components/dashboard/Timeline';

// Suspense wrapper is required because `useSearchParams` triggers Next 15's
// CSR-bailout error during `output: 'export'` builds otherwise.
export default function SessionsPage() {
  return (
    <Suspense fallback={<p>Loading…</p>}>
      <SessionsInner />
    </Suspense>
  );
}

function SessionsInner() {
  const params = useSearchParams();
  const userId = params.get('user');
  const { token } = useDashboardToken();
  const { sessions } = useSessions(token);
  const { events: liveEvents } = useEventStream(token);

  const [history, setHistory] = useState<AgentEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token || !userId) return;
    let cancelled = false;
    fetchHistory(token, userId, 200)
      .then((evs) => {
        if (!cancelled) setHistory(evs);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [token, userId]);

  if (!token) return null;

  const liveForUser = liveEvents.filter((ev) => ev.sessionUserId === userId);
  const merged = [...history, ...liveForUser];
  const seen = new Set<string>();
  const deduped = merged.filter((ev) => {
    const k = `${ev.ts}-${ev.type}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return (
    <main style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 24 }}>
      <aside>
        <h2 style={{ fontSize: 14, textTransform: 'uppercase' }}>Sessions</h2>
        <SessionList sessions={sessions} />
      </aside>
      <section>
        {!userId ? (
          <p>Pick a session from the list to see its timeline.</p>
        ) : (
          <>
            <h1>{userId.slice(0, 16)}…</h1>
            {error && <p style={{ color: 'crimson' }}>{error}</p>}
            <Timeline events={deduped} />
          </>
        )}
      </section>
    </main>
  );
}
