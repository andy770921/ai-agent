import { describe, it, expect } from 'vitest';
import { sessionIdFor } from './session.js';

describe('sessionIdFor', () => {
  it('returns userId:yyyy-mm-dd format', () => {
    const id = sessionIdFor('U123');
    expect(id).toMatch(/^U123:\d{4}-\d{2}-\d{2}$/);
  });

  it('returns same id for same user on same day', () => {
    expect(sessionIdFor('U1')).toBe(sessionIdFor('U1'));
  });
});
