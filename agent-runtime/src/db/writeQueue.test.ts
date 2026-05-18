import { describe, it, expect } from 'vitest';
import { enqueueWrite, flushQueue } from './writeQueue.js';

describe('writeQueue', () => {
  it('executes all enqueued writes in order', async () => {
    const results: number[] = [];
    for (let i = 0; i < 5; i++) {
      enqueueWrite(async () => {
        results.push(i);
      });
    }
    await flushQueue();
    expect(results).toEqual([0, 1, 2, 3, 4]);
  });

  it('continues on error without crashing', async () => {
    const results: string[] = [];
    enqueueWrite(async () => {
      results.push('a');
    });
    enqueueWrite(async () => {
      throw new Error('boom');
    });
    enqueueWrite(async () => {
      results.push('c');
    });
    await flushQueue();
    expect(results).toEqual(['a', 'c']);
  });
});
