import type { Context } from 'hono';

export async function imageUploadHandler(c: Context) {
  const auth = c.req.header('authorization') ?? '';
  if (auth !== `Bearer ${process.env.CF_UPLOAD_SECRET}`)
    return c.json({ ok: false }, 401);

  const body = await c.req.arrayBuffer();
  const filename =
    c.req.header('x-filename') ??
    `${Date.now()}-${Math.random().toString(36).slice(2)}.png`;

  // Forward to the Cloudflare Worker's /img endpoint
  const cfUrl = `${process.env.CF_IMG_BASE_URL}/img/${filename}`;
  const r = await fetch(cfUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'image/png',
      Authorization: `Bearer ${process.env.CF_UPLOAD_SECRET}`,
    },
    body,
  });

  if (!r.ok) return c.json({ ok: false, status: r.status }, 502);
  return c.json({ ok: true, url: cfUrl });
}
