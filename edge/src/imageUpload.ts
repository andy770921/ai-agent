import type { Env } from './env';

const KEY_RE = /^[a-zA-Z0-9._-]+\.(png|jpg|jpeg)$/;

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

  const today = new Date().toISOString().slice(0, 10);
  const objKey = `images/${today}/${key}`;

  if (!req.body) return new Response('no body', { status: 400 });
  await env.IMG_BUCKET.put(objKey, req.body, {
    httpMetadata: { contentType },
  });
  return new Response(JSON.stringify({ key: objKey }), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });
}
