/** Internal bus event — richer than the SSE wire format. */
export interface BusEvent {
  type: 'message_in' | 'tool_call' | 'tool_result' | 'message_out' | 'session_ended';
  userId: string;
  sessionId: string;
  ts?: number;
  text?: string;
  tool?: string;
  toolName?: string;
  args?: unknown;
  ok?: boolean;
  error?: string;
  durationMs?: number;
  kind?: 'text' | 'image';
  imageUrl?: string;
  attempt?: number;
  parentTraceId?: string;
}

type Listener = (ev: BusEvent) => void | Promise<void>;
const listeners = new Set<Listener>();

export const agentEventBus = {
  on(fn: Listener) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  emit(ev: BusEvent) {
    const stamped = { ...ev, ts: ev.ts ?? Date.now() };
    for (const fn of listeners) {
      try {
        void fn(stamped);
      } catch (e) {
        console.error('bus listener', e);
      }
    }
  },
};
