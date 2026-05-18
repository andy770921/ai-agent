import type { BusEvent } from './bus.js';
import { agentEventBus } from './bus.js';

const PER_SESSION_LIMIT = 200;
const TOTAL_SESSION_LIMIT = 100;
const buf = new Map<string, BusEvent[]>();

agentEventBus.on((ev) => {
  const key = `${ev.userId}:${ev.sessionId}`;
  const list = buf.get(key) ?? [];
  list.push(ev);
  if (list.length > PER_SESSION_LIMIT) list.shift();
  buf.set(key, list);
  if (buf.size > TOTAL_SESSION_LIMIT) {
    const oldest = buf.keys().next().value;
    if (oldest) buf.delete(oldest);
  }
});

export function getSessionHistory(
  userId: string,
  sessionId: string,
): BusEvent[] {
  return buf.get(`${userId}:${sessionId}`) ?? [];
}

export function listSessions() {
  return [...buf.keys()].map((k) => {
    const [userId, ...rest] = k.split(':');
    return { userId, sessionId: rest.join(':') };
  });
}
