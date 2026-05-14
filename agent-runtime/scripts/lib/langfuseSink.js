// LangfuseSink — translates the AgentEvent stream into a Langfuse trace
// per LINE conversation turn. One trace per `message_in`, one generation
// per LLM turn, one span per tool call.

// Stale traces older than this are cleaned up on the next message_in for
// the same userId (covers the case where conversation_finished is never
// emitted, e.g. agent timeout or crash).
const STALE_MS = 10 * 60 * 1000; // 10 minutes

function createLangfuseSink({ langfuse, modelName = 'gemini-2.5-flash' }) {
  const activeTraces = new Map(); // userId -> { trace, generation, spans, startedAt }

  return {
    onEvent(ev) {
      try {
        if (!ev || !ev.sessionUserId) return;
        const userId = ev.sessionUserId;

        switch (ev.type) {
          case 'message_in': {
            // Close stale trace for same user if present (previous turn never finished)
            const prev = activeTraces.get(userId);
            if (prev) {
              try {
                prev.generation.end({ output: '(interrupted)' });
                prev.trace.update({ output: { text: '(interrupted)' } });
              } catch { /* best-effort cleanup */ }
              activeTraces.delete(userId);
            }

            const trace = langfuse.trace({
              name: 'line-message',
              sessionId: userId,
              userId,
              input: { text: ev.text },
            });
            const generation = trace.generation({
              name: modelName,
              model: modelName,
              input: ev.text,
            });
            activeTraces.set(userId, {
              trace,
              generation,
              spans: new Map(),
              startedAt: Date.now(),
            });
            return;
          }
          case 'tool_call': {
            const ctx = activeTraces.get(userId);
            if (!ctx) return;
            const span = ctx.generation.span({
              name: ev.tool || 'unknown',
              input: ev.args,
            });
            ctx.spans.set(ev.tool, span);
            return;
          }
          case 'tool_result': {
            const ctx = activeTraces.get(userId);
            if (!ctx) return;
            const span = ctx.spans.get(ev.tool);
            if (!span) return;
            span.end({
              output: ev.error || 'ok',
              level: ev.ok ? 'DEFAULT' : 'ERROR',
              statusMessage: ev.error,
              metadata: { durationMs: ev.durationMs },
            });
            ctx.spans.delete(ev.tool);
            return;
          }
          case 'message_out': {
            const ctx = activeTraces.get(userId);
            if (!ctx) return;
            ctx.generation.end({ output: ev.text || '' });
            ctx.trace.update({
              output: { text: ev.text || '', kind: ev.kind || 'text' },
            });
            activeTraces.delete(userId);
            return;
          }
          default:
            return;
        }
      } catch (err) {
        console.error('langfuseSink: onEvent error —', err.message || err);
      }
    },
  };
}

module.exports = { createLangfuseSink };
