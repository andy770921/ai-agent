import type { Env } from './env';

interface ImageMeta {
  contentType?: string;
}

export async function handleImageServe(
  _req: Request,
  env: Env,
  key: string,
): Promise<Response> {
  const { value, metadata } = await env.IMG_KV.getWithMetadata<ImageMeta>(
    key,
    'arrayBuffer',
  );
  if (!value) {
    return new Response('not found', { status: 404 });
  }
  return new Response(value, {
    headers: {
      'content-type': metadata?.contentType ?? 'image/png',
      'cache-control': 'public, max-age=86400',
    },
  });
}
