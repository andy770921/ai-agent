import { db } from './client.js';

export async function upsertUser(userId: string, displayName?: string) {
  await db().from('users').upsert(
    {
      user_id: userId,
      display_name: displayName ?? null,
      last_active_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' },
  );
}
