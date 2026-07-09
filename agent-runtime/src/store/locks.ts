// In-memory advisory lock (replaces Supabase pg_try_advisory_lock RPCs).
//
// The runtime is a single Node process, so a per-key in-process guard gives the
// same "only one holder at a time" guarantee the Postgres advisory lock did.

const held = new Set<string>();

export async function withAdvisoryLock<T>(
  name: string,
  fn: () => Promise<T>,
): Promise<T | { skipped: true; reason: 'lock_held' }> {
  if (held.has(name)) return { skipped: true, reason: 'lock_held' };
  held.add(name);
  try {
    return await fn();
  } finally {
    held.delete(name);
  }
}
