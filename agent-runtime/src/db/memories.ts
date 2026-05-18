import { db } from './client.js';

export interface Memory {
  id: number;
  title: string;
  body: string;
  updatedAt: Date;
  useCount: number;
  pinned: boolean;
}

export async function findRelevantMemories(a: {
  userId: string;
  query: string;
  limit: number;
}): Promise<Memory[]> {
  const [base, fts] = await Promise.all([
    db().rpc('find_memories_recent', {
      p_user_id: a.userId,
      p_limit: a.limit,
    }),
    db().rpc('find_memories_fts', {
      p_user_id: a.userId,
      p_query: a.query,
      p_limit: a.limit,
    }),
  ]);
  const merged = new Map<number, Memory>();
  for (const m of [...(base.data ?? []), ...(fts.data ?? [])]) {
    merged.set(m.id, toMemory(m));
  }
  return [...merged.values()].slice(0, a.limit);
}

export async function markUsed(ids: number[]) {
  if (ids.length === 0) return;
  await db().rpc('memories_mark_used', { p_ids: ids });
}

function toMemory(r: Record<string, unknown>): Memory {
  return {
    id: r.id as number,
    title: r.title as string,
    body: r.body as string,
    updatedAt: new Date(r.updated_at as string),
    useCount: r.use_count as number,
    pinned: r.pinned as boolean,
  };
}
