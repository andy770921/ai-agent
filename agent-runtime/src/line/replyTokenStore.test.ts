import { describe, it, expect } from 'vitest';
import { rememberReplyToken, consumeReplyToken } from './replyTokenStore.js';

describe('replyTokenStore', () => {
  it('stores and consumes a token', () => {
    rememberReplyToken('U1', 'tok-abc');
    expect(consumeReplyToken('U1')).toBe('tok-abc');
  });

  it('returns null after consumption (single-use)', () => {
    rememberReplyToken('U2', 'tok-def');
    consumeReplyToken('U2');
    expect(consumeReplyToken('U2')).toBeNull();
  });

  it('returns null for unknown users', () => {
    expect(consumeReplyToken('Uxxx')).toBeNull();
  });
});
