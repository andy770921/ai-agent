// AgentEventBus — fan an AgentEvent out to a fixed set of sinks.
// Sinks are { onEvent(event) }; sink errors are isolated so one bad sink
// cannot block the others.

function createAgentEventBus({ sinks }) {
  return {
    publish(event) {
      for (const sink of sinks) {
        try {
          sink.onEvent?.(event);
        } catch (err) {
          console.error('sink failed', err);
        }
      }
    },
  };
}

module.exports = { createAgentEventBus };
