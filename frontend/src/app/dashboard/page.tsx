'use client';

import { useDashboardToken } from '@/hooks/useDashboardToken';
import { useEventStream } from '@/hooks/useEventStream';
import { useSessions } from '@/hooks/useSessions';
import { EventRow } from '@/components/dashboard/EventRow';
import { SessionList } from '@/components/dashboard/SessionList';

export default function DashboardPage() {
  const { token } = useDashboardToken();
  const { events, connected } = useEventStream(token);
  const { sessions } = useSessions(token);

  if (!token) return null;

  return (
    <main style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 24 }}>
      <aside>
        <h2 style={{ fontSize: 14, textTransform: 'uppercase' }}>Sessions</h2>
        <SessionList sessions={sessions} />
      </aside>
      <section>
        <h1>Live agent activity</h1>
        {!connected && <p style={{ color: 'orange' }}>Reconnecting to agent…</p>}
        {events.length === 0 && connected && (
          <p>No events yet — send a LINE message to your bot.</p>
        )}
        <div>
          {events.map((ev, i) => (
            <EventRow key={`${ev.ts}-${i}`} event={ev} />
          ))}
        </div>
      </section>
    </main>
  );
}
