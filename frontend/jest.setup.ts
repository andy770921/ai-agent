import '@testing-library/jest-dom';

// jsdom lacks the Web Streams + encoder/Response globals our SSE tests depend on.
// Pull them from Node's runtime (Node 18+) before any other module touches them.
/* eslint-disable @typescript-eslint/no-require-imports */
const nodeUtil = require('node:util');
const nodeStreamWeb = require('node:stream/web');
/* eslint-enable @typescript-eslint/no-require-imports */

const g = globalThis as unknown as Record<string, unknown>;

if (!g.TextEncoder) g.TextEncoder = nodeUtil.TextEncoder;
if (!g.TextDecoder) g.TextDecoder = nodeUtil.TextDecoder;
if (!g.ReadableStream) g.ReadableStream = nodeStreamWeb.ReadableStream;
if (!g.Response) {
  // Node 18+ exposes global Response on the Node main; if jsdom hid it, restore.
  // Falls back to a require of undici only if absolutely needed.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const undici = require('undici');
  /* eslint-enable @typescript-eslint/no-require-imports */
  g.Response = undici.Response;
}
