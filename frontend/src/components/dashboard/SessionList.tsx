'use client';

import Link from 'next/link';
import type { SessionSummary } from '@repo/shared';

interface Props {
  sessions: SessionSummary[];
}

export function SessionList({ sessions }: Props) {
  if (sessions.length === 0) return <p>No active sessions.</p>;
  return (
    <ul style={{ listStyle: 'none', padding: 0 }}>
      {sessions.map((s) => (
        <li key={s.userId} style={{ padding: '6px 0', borderBottom: '1px solid #eee' }}>
          <Link href={`/dashboard/sessions?user=${encodeURIComponent(s.userId)}`}>
            <strong>{s.userId.slice(0, 12)}…</strong>
          </Link>
          <div style={{ fontSize: 12, color: '#555' }}>
            {s.msgCount} events · last seen {s.lastSeen ? new Date(s.lastSeen).toLocaleString() : '—'}
          </div>
        </li>
      ))}
    </ul>
  );
}
