import { db } from './client.js';

const cache = new Map<string, { value: string; loadedAt: number }>();
const TTL_MS = 60_000;

export async function getAgentConfig(key: string): Promise<string> {
  const cached = cache.get(key);
  const now = Date.now();
  if (cached && now - cached.loadedAt < TTL_MS) return cached.value;
  const r = await db()
    .from('agent_config')
    .select('value')
    .eq('key', key)
    .single();
  if (r.error)
    throw new Error(`agent_config[${key}] missing: ${r.error.message}`);
  cache.set(key, { value: r.data.value, loadedAt: now });
  return r.data.value;
}

export function invalidateAgentConfig(key?: string) {
  if (key) cache.delete(key);
  else cache.clear();
}
