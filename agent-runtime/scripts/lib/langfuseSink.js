// LangfuseSink — translates the AgentEvent stream into a Langfuse trace
// per LINE conversation turn. One trace per `message_in`, one generation
// per LLM turn, one span per tool call.

function createLangfuseSink({ langfuse, modelName = 'gemini-2.5-flash' }) {
  const activeTraces = new Map(); // userId -> { trace, generation, spans }

  return {
    onEvent(ev) {
      if (!ev || !ev.sessionUserId) return;
      const userId = ev.sessionUserId;

      switch (ev.type) {
        case 'message_in': {
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
          activeTraces.set(userId, { trace, generation, spans: new Map() });
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
          ctx.generation.end({ output: ev.text });
          ctx.trace.update({ output: { text: ev.text, kind: ev.kind } });
          activeTraces.delete(userId);
          return;
        }
        default:
          return;
      }
    },
  };
}

module.exports = { createLangfuseSink };
