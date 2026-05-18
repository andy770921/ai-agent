import type { Context } from 'hono';
import { runCurator } from './runCurator.js';
import { db } from '../db/client.js';

export async function curatorHandler(c: Context) {
  const auth = c.req.header('authorization') ?? '';
  if (auth !== `Bearer ${process.env.CURATOR_TOKEN}`) return c.json({ ok: false }, 401);

  const { data: runRow } = await db()
    .from('curator_runs')
    .insert({ phase: 'cron-start' })
    .select()
    .single();

  try {
    await runCurator();
    await db()
      .from('curator_runs')
      .update({
        phase: 'cron-success',
        finished_at: new Date().toISOString(),
      })
      .eq('id', runRow!.id);
    return c.json({ ok: true });
  } catch (e) {
    await db()
      .from('curator_runs')
      .update({
        phase: 'cron-error',
        finished_at: new Date().toISOString(),
        report: { error: String(e) },
      })
      .eq('id', runRow!.id);
    return c.json({ ok: false, error: String(e) }, 500);
  }
}
