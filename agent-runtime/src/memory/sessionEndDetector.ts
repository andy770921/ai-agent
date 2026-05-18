import { agentEventBus } from '../observability/bus.js';

const IDLE_MS = 30_000;
const timers = new Map<string, NodeJS.Timeout>();

agentEventBus.on((ev) => {
  if (ev.type !== 'message_out') return;
  const key = `${ev.userId}:${ev.sessionId}`;
  if (timers.has(key)) clearTimeout(timers.get(key)!);
  timers.set(
    key,
    setTimeout(() => {
      timers.delete(key);
      agentEventBus.emit({
        type: 'session_ended',
        userId: ev.userId,
        sessionId: ev.sessionId,
      });
    }, IDLE_MS),
  );
});

agentEventBus.on((ev) => {
  if (ev.type !== 'message_in') return;
  const key = `${ev.userId}:${ev.sessionId}`;
  if (timers.has(key)) {
    clearTimeout(timers.get(key)!);
    timers.delete(key);
  }
});
