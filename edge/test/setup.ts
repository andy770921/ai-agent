// Polyfill globalThis.crypto for Node 18 so the Worker code under test (and
// the test helpers) can use SubtleCrypto exactly as it would in the
// Cloudflare Workers runtime. Node 19+ exposes this globally already.
import { webcrypto } from 'node:crypto';

const g = globalThis as unknown as { crypto?: Crypto };
if (!g.crypto) {
  g.crypto = webcrypto as unknown as Crypto;
}
