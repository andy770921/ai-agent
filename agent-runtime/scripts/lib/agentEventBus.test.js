const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAgentEventBus } = require('./agentEventBus');

test('publishes the event to every sink', () => {
  const seen = [];
  const a = { onEvent: (e) => seen.push(['a', e]) };
  const b = { onEvent: (e) => seen.push(['b', e]) };
  const bus = createAgentEventBus({ sinks: [a, b] });
  bus.publish({ type: 'x', sessionUserId: 'U' });
  assert.deepEqual(seen, [
    ['a', { type: 'x', sessionUserId: 'U' }],
    ['b', { type: 'x', sessionUserId: 'U' }],
  ]);
});

test('a sink that throws does not break the others', () => {
  const seen = [];
  const bad = {
    onEvent: () => {
      throw new Error('boom');
    },
  };
  const good = { onEvent: (e) => seen.push(e) };
  const bus = createAgentEventBus({ sinks: [bad, good] });

  // Swallow stderr from the bus' console.error during this test.
  const origErr = console.error;
  console.error = () => {};
  try {
    bus.publish({ type: 'x' });
  } finally {
    console.error = origErr;
  }
  assert.deepEqual(seen, [{ type: 'x' }]);
});

test('sinks without onEvent are ignored', () => {
  const bus = createAgentEventBus({ sinks: [{}] });
  bus.publish({ type: 'x' }); // must not throw
});
