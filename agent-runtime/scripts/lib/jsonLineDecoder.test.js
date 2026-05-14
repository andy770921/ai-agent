const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createJsonLineDecoder } = require('./jsonLineDecoder');

test('emits a line per newline-terminated chunk', () => {
  const seen = [];
  const dec = createJsonLineDecoder((l) => seen.push(l));
  dec.push('a\nb\nc\n');
  assert.deepEqual(seen, ['a', 'b', 'c']);
});

test('reassembles a line split across multiple chunks', () => {
  const seen = [];
  const dec = createJsonLineDecoder((l) => seen.push(l));
  dec.push('{"a":');
  dec.push('1}');
  dec.push('\nnext\n');
  assert.deepEqual(seen, ['{"a":1}', 'next']);
});

test('does not emit a trailing partial line', () => {
  const seen = [];
  const dec = createJsonLineDecoder((l) => seen.push(l));
  dec.push('done\nstill-going');
  assert.deepEqual(seen, ['done']);
});

test('skips blank lines', () => {
  const seen = [];
  const dec = createJsonLineDecoder((l) => seen.push(l));
  dec.push('a\n\nb\n');
  assert.deepEqual(seen, ['a', 'b']);
});
