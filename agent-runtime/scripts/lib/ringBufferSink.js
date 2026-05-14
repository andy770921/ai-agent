// RingBufferSink — keeps the last N AgentEvents per sessionUserId in memory.
// Used by the /sessions and /sessions/:id/history dashboard endpoints.

function createRingBufferSink({ limit = 200 } = {}) {
  const recent = new Map(); // userId -> AgentEvent[]

  return {
    onEvent(ev) {
      if (!ev || !ev.sessionUserId) return;
      const arr = recent.get(ev.sessionUserId) ?? [];
      arr.push(ev);
      while (arr.length > limit) arr.shift();
      recent.set(ev.sessionUserId, arr);
    },

    listSessions() {
      return [...recent.entries()].map(([userId, evs]) => {
        const last = evs[evs.length - 1];
        return {
          userId,
          lastSeen: last?.ts,
          msgCount: evs.length,
          lastEvent: last,
        };
      });
    },

    getHistory(userId, n) {
      const evs = recent.get(userId) ?? [];
      const cap = Math.min(n, limit);
      return evs.slice(-cap);
    },
  };
}

module.exports = { createRingBufferSink };
