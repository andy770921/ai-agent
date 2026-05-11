import type { Env } from './env';

const KEY_RE = /^[a-zA-Z0-9._-]+\.(png|jpg|jpeg)$/;
const TTL_SECONDS = 86400; // 24h, matches the lifecycle window the dashboard expects

export async function handleImageUpload(
  req: Request,
  env: Env,
  key: string,
): Promise<Response> {
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${env.CF_UPLOAD_SECRET}`) {
    return new Response('unauthorized', { status: 401 });
  }
  if (!KEY_RE.test(key)) {
    return new Response('bad key', { status: 400 });
  }
  const contentType = req.headers.get('content-type') ?? 'application/octet-stream';
  if (!contentType.startsWith('image/')) {
    return new Response('bad content-type', { status: 400 });
  }

  if (!req.body) return new Response('no body', { status: 400 });
  // Read the full body into an ArrayBuffer — KV.put requires a concrete value,
  // not a stream. A screenshot is typically 100KB-1MB; the 25MB hard cap on
  // KV values is far above the worst-case Playwright PNG.
  const bytes = await req.arrayBuffer();

  await env.IMG_KV.put(key, bytes, {
    expirationTtl: TTL_SECONDS,
    metadata: { contentType },
  });

  return new Response(JSON.stringify({ key }), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });
}
