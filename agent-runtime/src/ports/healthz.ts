import type { Context } from 'hono';

export async function healthzHandler(c: Context) {
  return c.json({ ok: true, uptime: process.uptime() });
}
