import { describe, it, expect } from 'vitest';
import { softTruncate } from './summarise.js';

describe('softTruncate', () => {
  it('passes through short strings', () => {
    expect(softTruncate('hello')).toBe('hello');
  });

  it('truncates long strings with suffix', () => {
    const long = 'a'.repeat(5000);
    const result = softTruncate(long);
    expect(result.length).toBeLessThan(5000);
    expect(result).toContain('truncated');
    expect(result).toContain('5000 chars');
  });
});
