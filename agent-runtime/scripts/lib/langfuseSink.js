// LangfuseSink — maps the AgentEvent stream to Langfuse traces.
//
// One trace per conversation turn (message_in → turn_end). Within the trace:
//   - One generation per LLM API call (api_request → api_response pair)
//   - One span per tool call
//
// Conversation flow:
//   message_in   → create trace + start generation #1
//   llm_response → end current generation (record token usage)
//   tool_call    → start span (creates new generation if needed)
//   tool_result  → end span
//   llm_response → end generation #2 (final answer)
//   turn_end     → close trace

const STALE_MS = 10 * 60 * 1000; // 10 minutes

function createLangfuseSink({ langfuse, modelName = 'gemini-2.5-flash' }) {
  // userId -> { trace, generation, generationCount, spans, startedAt }
  const activeTraces = new Map();

  function ensureGeneration(ctx, model) {
    if (!ctx.generation) {
      ctx.generationCount++;
      ctx.generation = ctx.trace.generation({
        name: `${model || modelName} #${ctx.generationCount}`,
        model: model || modelName,
      });
    }
    return ctx.generation;
  }

  return {
    onEvent(ev) {
      try {
        if (!ev || !ev.sessionUserId) return;
        const userId = ev.sessionUserId;

        switch (ev.type) {
          case 'message_in': {
            // Close stale trace for same user if present
            const prev = activeTraces.get(userId);
            if (prev) {
              try {
                if (prev.generation) prev.generation.end({ output: '(interrupted)' });
                prev.trace.update({ output: { text: '(interrupted)' } });
              } catch { /* best-effort */ }
              activeTraces.delete(userId);
            }

            const trace = langfuse.trace({
              name: 'line-message',
              sessionId: userId,
              userId,
              input: { text: ev.text },
            });
            const generation = trace.generation({
              name: ev.model || modelName,
              model: ev.model || modelName,
              input: ev.text,
            });
            activeTraces.set(userId, {
              trace,
              generation,
              generationCount: 1,
              spans: new Map(),
              startedAt: Date.now(),
            });
            return;
          }

          case 'llm_response': {
            const ctx = activeTraces.get(userId);
            if (!ctx) return;

            const gen = ensureGeneration(ctx, ev.model);
            const endData = {};

            if (ev.error) {
              endData.output = ev.error;
              endData.level = 'ERROR';
              endData.statusMessage = ev.error;
            } else {
              endData.output = '(response)';
            }

            if (ev.inputTokens || ev.outputTokens) {
              endData.usage = {
                input: ev.inputTokens || 0,
                output: ev.outputTokens || 0,
                unit: 'TOKENS',
              };
            }

            if (ev.durationMs) {
              endData.metadata = { durationMs: ev.durationMs, statusCode: ev.statusCode };
            }

            gen.end(endData);
            // Clear generation — next tool_call or api_request will create a new one
            ctx.generation = null;
            return;
          }

          case 'tool_call': {
            const ctx = activeTraces.get(userId);
            if (!ctx) return;
            // If no active generation (previous one ended), create one for
            // this tool-use phase.
            const gen = ensureGeneration(ctx, null);
            const span = gen.span({
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

          case 'turn_end': {
            const ctx = activeTraces.get(userId);
            if (!ctx) return;
            // End any open generation
            if (ctx.generation) {
              ctx.generation.end({ output: '(turn complete)' });
              ctx.generation = null;
            }
            ctx.trace.update({
              output: { turnCount: ev.turnCount },
            });
            activeTraces.delete(userId);
            return;
          }

          // Legacy message_out — treat as turn_end for backward compatibility.
          case 'message_out': {
            const ctx = activeTraces.get(userId);
            if (!ctx) return;
            if (ctx.generation) {
              ctx.generation.end({ output: ev.text || '' });
              ctx.generation = null;
            }
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
