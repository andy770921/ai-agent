const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLangfuseSink } = require('./langfuseSink');

function fakeLangfuse() {
  const calls = [];
  function makeSpan(name) {
    return {
      end: (args) => calls.push({ op: 'span.end', name, args }),
    };
  }
  function makeGeneration() {
    return {
      span: (args) => {
        calls.push({ op: 'generation.span', args });
        return makeSpan(args.name);
      },
      end: (args) => calls.push({ op: 'generation.end', args }),
    };
  }
  function makeTrace() {
    return {
      generation: (args) => {
        calls.push({ op: 'trace.generation', args });
        return makeGeneration();
      },
      update: (args) => calls.push({ op: 'trace.update', args }),
    };
  }
  return {
    calls,
    trace: (args) => {
      calls.push({ op: 'trace', args });
      return makeTrace();
    },
  };
}

test('full lifecycle: message_in → llm_response → tool → llm_response → turn_end', () => {
  const lf = fakeLangfuse();
  const sink = createLangfuseSink({ langfuse: lf });

  // User sends message
  sink.onEvent({ type: 'message_in', sessionUserId: 'U', text: 'find repos', model: 'gemini-2.5-flash' });
  // First LLM response (model decides to use tool)
  sink.onEvent({ type: 'llm_response', sessionUserId: 'U', inputTokens: 100, outputTokens: 20, durationMs: 800 });
  // Tool call
  sink.onEvent({ type: 'tool_call', sessionUserId: 'U', tool: 'search_repos', args: { q: 'test' } });
  sink.onEvent({ type: 'tool_result', sessionUserId: 'U', tool: 'search_repos', ok: true, durationMs: 1500 });
  // Second LLM response (final answer)
  sink.onEvent({ type: 'llm_response', sessionUserId: 'U', inputTokens: 200, outputTokens: 80, durationMs: 1200 });
  // Turn ends
  sink.onEvent({ type: 'turn_end', sessionUserId: 'U', turnCount: 1 });

  const ops = lf.calls.map((c) => c.op);
  assert.deepEqual(ops, [
    'trace',                // message_in creates trace
    'trace.generation',     // message_in starts generation #1
    'generation.end',       // llm_response ends generation #1 (with tokens)
    'trace.generation',     // tool_call needs a generation → creates #2
    'generation.span',      // tool_call creates span
    'span.end',             // tool_result ends span
    'generation.end',       // llm_response ends generation #2 (with tokens)
    'trace.update',         // turn_end closes trace
  ]);

  // Verify generation #1 has token usage
  const gen1End = lf.calls.find((c) => c.op === 'generation.end');
  assert.deepEqual(gen1End.args.usage, { input: 100, output: 20, unit: 'TOKENS' });
});

test('simple conversation without tool calls', () => {
  const lf = fakeLangfuse();
  const sink = createLangfuseSink({ langfuse: lf });

  sink.onEvent({ type: 'message_in', sessionUserId: 'U', text: 'hello' });
  sink.onEvent({ type: 'llm_response', sessionUserId: 'U', inputTokens: 50, outputTokens: 30 });
  sink.onEvent({ type: 'turn_end', sessionUserId: 'U', turnCount: 1 });

  const ops = lf.calls.map((c) => c.op);
  assert.deepEqual(ops, [
    'trace',
    'trace.generation',
    'generation.end',
    'trace.update',
  ]);
});

test('llm_response with error records level=ERROR', () => {
  const lf = fakeLangfuse();
  const sink = createLangfuseSink({ langfuse: lf });

  sink.onEvent({ type: 'message_in', sessionUserId: 'U', text: 'hello' });
  sink.onEvent({ type: 'llm_response', sessionUserId: 'U', error: 'quota exceeded', statusCode: 500 });
  sink.onEvent({ type: 'turn_end', sessionUserId: 'U' });

  const genEnd = lf.calls.find((c) => c.op === 'generation.end');
  assert.equal(genEnd.args.level, 'ERROR');
  assert.equal(genEnd.args.statusMessage, 'quota exceeded');
});

test('tool_result without a matching tool_call is ignored', () => {
  const lf = fakeLangfuse();
  const sink = createLangfuseSink({ langfuse: lf });
  sink.onEvent({ type: 'message_in', sessionUserId: 'U', text: 'hi' });
  sink.onEvent({
    type: 'tool_result',
    sessionUserId: 'U',
    tool: 'never-called',
    ok: true,
  });
  const spans = lf.calls.filter((c) => c.op === 'span.end');
  assert.equal(spans.length, 0);
});

test('failed tool_result records level=ERROR with statusMessage', () => {
  const lf = fakeLangfuse();
  const sink = createLangfuseSink({ langfuse: lf });
  sink.onEvent({ type: 'message_in', sessionUserId: 'U', text: 'hi' });
  sink.onEvent({ type: 'tool_call', sessionUserId: 'U', tool: 'playwright', args: {} });
  sink.onEvent({
    type: 'tool_result',
    sessionUserId: 'U',
    tool: 'playwright',
    ok: false,
    error: 'timeout',
    durationMs: 5000,
  });
  const spanEnd = lf.calls.find((c) => c.op === 'span.end');
  assert.equal(spanEnd.args.level, 'ERROR');
  assert.equal(spanEnd.args.statusMessage, 'timeout');
  assert.equal(spanEnd.args.metadata.durationMs, 5000);
});

test('events without a sessionUserId are ignored', () => {
  const lf = fakeLangfuse();
  const sink = createLangfuseSink({ langfuse: lf });
  sink.onEvent({ type: 'message_in', text: 'hi' });
  assert.equal(lf.calls.length, 0);
});

test('legacy message_out still works (backward compatibility)', () => {
  const lf = fakeLangfuse();
  const sink = createLangfuseSink({ langfuse: lf });
  sink.onEvent({ type: 'message_in', sessionUserId: 'U', text: 'hi' });
  sink.onEvent({ type: 'message_out', sessionUserId: 'U', text: 'bye', kind: 'text' });

  const ops = lf.calls.map((c) => c.op);
  assert.deepEqual(ops, ['trace', 'trace.generation', 'generation.end', 'trace.update']);

  const update = lf.calls.find((c) => c.op === 'trace.update');
  assert.equal(update.args.output.text, 'bye');
});

test('events outside a known trace context are ignored', () => {
  const lf = fakeLangfuse();
  const sink = createLangfuseSink({ langfuse: lf });
  sink.onEvent({ type: 'tool_call', sessionUserId: 'U', tool: 'p', args: {} });
  sink.onEvent({ type: 'turn_end', sessionUserId: 'U' });
  assert.equal(lf.calls.length, 0);
});

test('stale trace is closed when new message_in arrives', () => {
  const lf = fakeLangfuse();
  const sink = createLangfuseSink({ langfuse: lf });
  sink.onEvent({ type: 'message_in', sessionUserId: 'U', text: 'first' });
  // No turn_end — simulate stale trace
  sink.onEvent({ type: 'message_in', sessionUserId: 'U', text: 'second' });

  const genEnds = lf.calls.filter((c) => c.op === 'generation.end');
  assert.equal(genEnds.length, 1); // stale generation ended
  assert.equal(genEnds[0].args.output, '(interrupted)');

  const traces = lf.calls.filter((c) => c.op === 'trace');
  assert.equal(traces.length, 2); // two traces created
});
