'use client';

import type { AgentEvent } from '@repo/shared';
import { EventRow } from './EventRow';

interface Props {
  events: AgentEvent[];
}

export function Timeline({ events }: Props) {
  const sorted = [...events].sort((a, b) => (a.ts < b.ts ? -1 : 1));
  return (
    <div>
      {sorted.map((ev, i) => (
        <EventRow key={`${ev.ts}-${i}`} event={ev} />
      ))}
    </div>
  );
}
