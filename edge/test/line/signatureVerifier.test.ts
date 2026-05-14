import { describe, it, expect } from 'vitest';
import { createHmacSignatureVerifier } from '../../src/line/signatureVerifier';

async function expectedSig(secret: string, body: string): Promise<string> {
  // Compute the expected HMAC the same way the verifier does, so we
  // are testing the verify() decision, not the algorithm itself.
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const buf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  let bin = '';
  const v = new Uint8Array(buf);
  for (let i = 0; i < v.length; i++) bin += String.fromCharCode(v[i]!);
  return btoa(bin);
}

describe('createHmacSignatureVerifier', () => {
  it('returns true when the signature matches', async () => {
    const verifier = createHmacSignatureVerifier('shh');
    const body = '{"events":[]}';
    expect(await verifier.verify(body, await expectedSig('shh', body))).toBe(true);
  });

  it('returns false when the signature is wrong', async () => {
    const verifier = createHmacSignatureVerifier('shh');
    expect(await verifier.verify('{}', 'definitely-wrong')).toBe(false);
  });

  it('returns false when the header is missing', async () => {
    const verifier = createHmacSignatureVerifier('shh');
    expect(await verifier.verify('{}', null)).toBe(false);
  });

  it('returns false when the body has been tampered with', async () => {
    const verifier = createHmacSignatureVerifier('shh');
    const sig = await expectedSig('shh', '{"events":[]}');
    expect(await verifier.verify('{"events":[1]}', sig)).toBe(false);
  });
});
