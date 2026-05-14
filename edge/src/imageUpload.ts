import type { ImageStore } from './ports/imageStore';

const KEY_RE = /^[a-zA-Z0-9._-]+\.(png|jpg|jpeg)$/;

export async function handleImageUpload(
  req: Request,
  store: ImageStore,
  uploadSecret: string,
  key: string,
): Promise<Response> {
  if (req.headers.get('authorization') !== `Bearer ${uploadSecret}`) {
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

  // Read the full body — KV.put requires a concrete value, not a stream.
  // Worst case is a Playwright PNG well under KV's 25MB limit.
  const bytes = await req.arrayBuffer();
  await store.put(key, bytes, contentType);

  return new Response(JSON.stringify({ key }), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });
}
