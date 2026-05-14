const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSseFanoutSink } = require('./sseFanoutSink');

function fakeRes() {
  const lines = [];
  let throwOnWrite = false;
  return {
    write: (s) => {
      if (throwOnWrite) throw new Error('disconnected');
      lines.push(s);
    },
    lines,
    setThrow: (v) => {
      throwOnWrite = v;
    },
  };
}

test('broadcasts event payloads to all subscribers', () => {
  const sink = createSseFanoutSink();
  const a = fakeRes();
  const b = fakeRes();
  sink.subscribe(a);
  sink.subscribe(b);

  sink.onEvent({ type: 'message_in', sessionUserId: 'U', text: 'hi' });

  assert.equal(a.lines.length, 1);
  assert.equal(b.lines.length, 1);
  assert.match(a.lines[0], /^event: message_in\n/);
  assert.match(a.lines[0], /"sessionUserId":"U"/);
});

test('subscribers whose write throws are auto-deregistered', () => {
  const sink = createSseFanoutSink();
  const flaky = fakeRes();
  const stable = fakeRes();
  sink.subscribe(flaky);
  sink.subscribe(stable);

  flaky.setThrow(true);
  sink.onEvent({ type: 'message_in', sessionUserId: 'U' });
  assert.equal(sink.subscriberCount(), 1);

  flaky.setThrow(false);
  sink.onEvent({ type: 'message_in', sessionUserId: 'U' });
  assert.equal(flaky.lines.length, 0); // flaky must not receive after deregister
  assert.equal(stable.lines.length, 2);
});

test('subscribe returns an unsubscribe function', () => {
  const sink = createSseFanoutSink();
  const a = fakeRes();
  const off = sink.subscribe(a);
  assert.equal(sink.subscriberCount(), 1);
  off();
  assert.equal(sink.subscriberCount(), 0);
});

test('heartbeat emits a ping line to every subscriber', () => {
  const sink = createSseFanoutSink();
  const a = fakeRes();
  sink.subscribe(a);
  sink.heartbeat();
  assert.equal(a.lines.length, 1);
  assert.match(a.lines[0], /^event: heartbeat\n/);
});

test('events without a type are skipped (defensive)', () => {
  const sink = createSseFanoutSink();
  const a = fakeRes();
  sink.subscribe(a);
  sink.onEvent({ sessionUserId: 'U' });
  assert.equal(a.lines.length, 0);
});
