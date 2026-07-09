// In-memory user store (replaces the Supabase `users` table).
//
// Tracks who has talked to the bot and when. Lives for the container's lifetime.

interface UserRow {
  userId: string;
  displayName: string | null;
  createdAt: Date;
  lastActiveAt: Date;
}

const users = new Map<string, UserRow>();

export async function upsertUser(userId: string, displayName?: string) {
  const existing = users.get(userId);
  const now = new Date();
  if (existing) {
    if (displayName !== undefined) existing.displayName = displayName;
    existing.lastActiveAt = now;
    return;
  }
  users.set(userId, {
    userId,
    displayName: displayName ?? null,
    createdAt: now,
    lastActiveAt: now,
  });
}
