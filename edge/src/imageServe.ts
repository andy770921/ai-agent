import type { Env } from './env';

export async function handleImageServe(
  _req: Request,
  env: Env,
  key: string,
): Promise<Response> {
  for (const offset of [0, 1]) {
    const d = new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
    const obj = await env.IMG_BUCKET.get(`images/${d}/${key}`);
    if (obj) {
      return new Response(obj.body, {
        headers: {
          'content-type': obj.httpMetadata?.contentType ?? 'image/png',
          'cache-control': 'public, max-age=86400',
        },
      });
    }
  }
  return new Response('not found', { status: 404 });
}
