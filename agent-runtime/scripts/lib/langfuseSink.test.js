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

test('full lifecycle: message_in → tool_call → tool_result → message_out', () => {
  const lf = fakeLangfuse();
  const sink = createLangfuseSink({ langfuse: lf });

  sink.onEvent({ type: 'message_in', sessionUserId: 'U', text: 'hi' });
  sink.onEvent({ type: 'tool_call', sessionUserId: 'U', tool: 'playwright', args: { url: 'x' } });
  sink.onEvent({
    type: 'tool_result',
    sessionUserId: 'U',
    tool: 'playwright',
    ok: true,
    durationMs: 120,
  });
  sink.onEvent({ type: 'message_out', sessionUserId: 'U', text: 'done', kind: 'text' });

  const ops = lf.calls.map((c) => c.op);
  assert.deepEqual(ops, [
    'trace',
    'trace.generation',
    'generation.span',
    'span.end',
    'generation.end',
    'trace.update',
  ]);
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

test('message_out with kind=image records the kind on trace.update', () => {
  const lf = fakeLangfuse();
  const sink = createLangfuseSink({ langfuse: lf });
  sink.onEvent({ type: 'message_in', sessionUserId: 'U', text: 'screenshot please' });
  sink.onEvent({
    type: 'message_out',
    sessionUserId: 'U',
    text: 'Screenshot above',
    kind: 'image',
  });
  const update = lf.calls.find((c) => c.op === 'trace.update');
  assert.equal(update.args.output.kind, 'image');
  assert.equal(update.args.output.text, 'Screenshot above');
});

test('events outside a known trace context are ignored', () => {
  const lf = fakeLangfuse();
  const sink = createLangfuseSink({ langfuse: lf });
  sink.onEvent({ type: 'tool_call', sessionUserId: 'U', tool: 'p', args: {} });
  sink.onEvent({ type: 'message_out', sessionUserId: 'U', text: 'orphan' });
  assert.equal(lf.calls.length, 0);
});
