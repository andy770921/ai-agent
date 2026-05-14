// SseFanoutSink — owns the active SSE subscribers and broadcasts every
// AgentEvent (and periodic heartbeats) to all of them. A subscriber whose
// write throws is auto-deregistered.

function createSseFanoutSink() {
  const subscribers = new Set();

  function write(res, payload) {
    try {
      res.write(payload);
      return true;
    } catch {
      subscribers.delete(res);
      return false;
    }
  }

  return {
    onEvent(ev) {
      if (!ev || !ev.type) return;
      const payload = `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
      for (const res of subscribers) write(res, payload);
    },

    subscribe(res) {
      subscribers.add(res);
      return () => subscribers.delete(res);
    },

    heartbeat() {
      const payload = `event: heartbeat\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`;
      for (const res of subscribers) write(res, payload);
    },

    subscriberCount() {
      return subscribers.size;
    },
  };
}

module.exports = { createSseFanoutSink };
