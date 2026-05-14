const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRingBufferSink } = require('./ringBufferSink');

test('appends events per sessionUserId', () => {
  const sink = createRingBufferSink({ limit: 5 });
  sink.onEvent({ sessionUserId: 'U1', type: 'message_in', text: 'a', ts: '1' });
  sink.onEvent({ sessionUserId: 'U1', type: 'message_in', text: 'b', ts: '2' });
  sink.onEvent({ sessionUserId: 'U2', type: 'message_in', text: 'c', ts: '3' });

  const u1 = sink.getHistory('U1', 10);
  const u2 = sink.getHistory('U2', 10);
  assert.equal(u1.length, 2);
  assert.equal(u2.length, 1);
  assert.equal(u1[1].text, 'b');
});

test('evicts oldest when over limit', () => {
  const sink = createRingBufferSink({ limit: 3 });
  for (let i = 0; i < 5; i++) {
    sink.onEvent({ sessionUserId: 'U', type: 'message_in', text: String(i), ts: String(i) });
  }
  const hist = sink.getHistory('U', 100);
  assert.equal(hist.length, 3);
  assert.deepEqual(
    hist.map((e) => e.text),
    ['2', '3', '4'],
  );
});

test('listSessions reports lastSeen + msgCount + lastEvent', () => {
  const sink = createRingBufferSink({ limit: 10 });
  sink.onEvent({ sessionUserId: 'U', type: 'message_in', text: 'a', ts: 't1' });
  sink.onEvent({ sessionUserId: 'U', type: 'message_out', text: 'b', ts: 't2' });
  const list = sink.listSessions();
  assert.equal(list.length, 1);
  assert.deepEqual(list[0], {
    userId: 'U',
    lastSeen: 't2',
    msgCount: 2,
    lastEvent: { sessionUserId: 'U', type: 'message_out', text: 'b', ts: 't2' },
  });
});

test('ignores events with no sessionUserId', () => {
  const sink = createRingBufferSink({ limit: 5 });
  sink.onEvent({ type: 'whatever' });
  assert.deepEqual(sink.listSessions(), []);
});

test('getHistory caps the request at the configured limit', () => {
  const sink = createRingBufferSink({ limit: 4 });
  for (let i = 0; i < 4; i++) {
    sink.onEvent({ sessionUserId: 'U', type: 'message_in', text: String(i), ts: String(i) });
  }
  const hist = sink.getHistory('U', 100);
  assert.equal(hist.length, 4);
});
