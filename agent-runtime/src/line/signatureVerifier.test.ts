import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyLineSignature } from './signatureVerifier.js';

describe('verifyLineSignature', () => {
  const secret = 'test-secret-key';
  const body = '{"events":[]}';
  const validSig = createHmac('sha256', secret).update(body).digest('base64');

  it('accepts a valid signature', () => {
    expect(verifyLineSignature(body, validSig, secret)).toBe(true);
  });

  it('rejects an invalid signature', () => {
    expect(verifyLineSignature(body, 'bad-sig', secret)).toBe(false);
  });

  it('rejects empty signature', () => {
    expect(verifyLineSignature(body, '', secret)).toBe(false);
  });
});
