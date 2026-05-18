import { db } from './client.js';

export async function withAdvisoryLock<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T | { skipped: true; reason: 'lock_held' }> {
  const ack = await db().rpc('try_advisory_lock', { lock_key: name });
  if (!ack.data) return { skipped: true, reason: 'lock_held' };
  try {
    return await fn();
  } finally {
    await db().rpc('advisory_unlock', { lock_key: name });
  }
}
