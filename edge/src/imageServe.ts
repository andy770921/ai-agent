import type { ImageStore } from './ports/imageStore';

export async function handleImageServe(
  _req: Request,
  store: ImageStore,
  key: string,
): Promise<Response> {
  const found = await store.get(key);
  if (!found) {
    return new Response('not found', { status: 404 });
  }
  return new Response(found.body, {
    headers: {
      'content-type': found.contentType,
      'cache-control': 'public, max-age=86400',
    },
  });
}
