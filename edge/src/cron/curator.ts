import type { Env } from '../env';

export async function handleCuratorCron(env: Env) {
  if (!env.CURATOR_TOKEN) {
    console.error('curator cron: CURATOR_TOKEN not set, skipping');
    return;
  }
  const r = await fetch(`${env.GATEWAY_BASE_URL}/admin/curator`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.CURATOR_TOKEN}` },
  });
  if (!r.ok) {
    console.error(`curator cron failed: ${r.status} ${await r.text().catch(() => '')}`);
  }
}
