'use client';

import Link from 'next/link';
import type { AgentEvent } from '@repo/shared';

function fmtTs(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString();
  } catch {
    return ts;
  }
}

interface Props {
  event: AgentEvent;
}

export function EventRow({ event }: Props) {
  const userLink = (
    <Link href={`/dashboard/sessions?user=${encodeURIComponent(event.sessionUserId)}`}>
      {event.sessionUserId.slice(0, 10)}…
    </Link>
  );

  switch (event.type) {
    case 'message_in':
      return (
        <div style={{ borderLeft: '4px solid #2e7d32', paddingLeft: 8, marginBottom: 6 }}>
          <small>
            {fmtTs(event.ts)} · {userLink} ›
          </small>
          <div>{event.text}</div>
        </div>
      );
    case 'tool_call':
      return (
        <div style={{ borderLeft: '4px solid #1565c0', paddingLeft: 8, marginBottom: 6 }}>
          <small>
            {fmtTs(event.ts)} · {userLink} · tool
          </small>
          <div>
            <code>{event.tool}</code>{' '}
            <code style={{ color: '#555' }}>{JSON.stringify(event.args).slice(0, 120)}</code>
          </div>
        </div>
      );
    case 'tool_result':
      return (
        <div style={{ borderLeft: '4px solid #1565c0', paddingLeft: 8, marginBottom: 6 }}>
          <small>
            {fmtTs(event.ts)} · {userLink} · result
          </small>
          <div>
            <code>{event.tool}</code>{' '}
            {event.ok ? <span>ok</span> : <span style={{ color: 'crimson' }}>error</span>}{' '}
            <span>· {event.durationMs}ms</span>
            {event.error && <div style={{ color: 'crimson' }}>{event.error}</div>}
          </div>
        </div>
      );
    case 'message_out':
      return (
        <div style={{ borderLeft: '4px solid #ed6c02', paddingLeft: 8, marginBottom: 6 }}>
          <small>
            {fmtTs(event.ts)} · {userLink} ‹
          </small>
          <div>{event.text}</div>
          {event.kind === 'image' && event.imageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={event.imageUrl} alt="agent reply" style={{ maxWidth: 240, marginTop: 4 }} />
          )}
        </div>
      );
  }
}
