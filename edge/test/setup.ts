// Polyfill globalThis.crypto for Node 18 so the Worker code under test (and
// the test helpers) can use SubtleCrypto exactly as it would in the
// Cloudflare Workers runtime.
import { webcrypto } from 'node:crypto';

if (!globalThis.crypto) {
  // The Node 18 `webcrypto` shape matches the Web Crypto API closely enough
  // for HMAC sign/verify. Node 19+ exposes this globally already.
  (globalThis as unknown as { crypto: Crypto }).crypto = webcrypto as unknown as Crypto;
}
