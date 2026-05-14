export interface LineSignatureVerifier {
  verify(rawBody: string, sigHeader: string | null): Promise<boolean>;
}

export function createHmacSignatureVerifier(secret: string): LineSignatureVerifier {
  return {
    async verify(rawBody, sigHeader) {
      if (!sigHeader) return false;
      const expected = await hmacSha256Base64(secret, rawBody);
      return constantTimeEqual(sigHeader, expected);
    },
  };
}

async function hmacSha256Base64(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  let bin = '';
  const view = new Uint8Array(sig);
  for (let i = 0; i < view.length; i++) bin += String.fromCharCode(view[i]!);
  return btoa(bin);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
