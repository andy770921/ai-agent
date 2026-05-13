import { describe, it, expect } from 'vitest';
import { isAllowedUser } from '../src/allowlist';

describe('isAllowedUser', () => {
  it('returns false for undefined userId', () => {
    expect(isAllowedUser(undefined, 'U1,U2')).toBe(false);
  });

  it('matches an exact userId', () => {
    expect(isAllowedUser('U1', 'U1,U2')).toBe(true);
  });

  it('returns false for a userId not in the list', () => {
    expect(isAllowedUser('U3', 'U1,U2')).toBe(false);
  });

  it('trims whitespace around csv entries', () => {
    expect(isAllowedUser('U1', ' U1 , U2 ')).toBe(true);
  });

  it('ignores empty entries', () => {
    expect(isAllowedUser('U1', ',,U1,')).toBe(true);
  });

  it('allows any userId when allowlist is empty (open mode)', () => {
    expect(isAllowedUser('U1', '')).toBe(true);
  });

  it('allows any userId when allowlist is undefined', () => {
    expect(isAllowedUser('U1', undefined)).toBe(true);
  });
});
