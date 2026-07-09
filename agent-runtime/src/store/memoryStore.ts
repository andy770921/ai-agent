// In-memory long-term memory store (replaces the Supabase `memories` table +
// its FTS RPCs). Lives for the container's lifetime.
//
// The Postgres tsvector search is approximated with a keyword-overlap ranker —
// good enough for the small per-user memory banks this bot accumulates.

export type MemoryCategory = 'user' | 'feedback' | 'project' | 'reference';
export type MemoryState = 'active' | 'stale' | 'archived';

/** Shape consumed by composeSystem / runTurn. */
export interface Memory {
  id: number;
  title: string;
  body: string;
  updatedAt: Date;
  useCount: number;
  pinned: boolean;
}

interface MemoryRow {
  id: number;
  userId: string;
  slug: string;
  category: MemoryCategory;
  title: string;
  body: string;
  state: MemoryState;
  pinned: boolean;
  useCount: number;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

let seq = 1;
const rows: MemoryRow[] = [];

function toMemory(r: MemoryRow): Memory {
  return {
    id: r.id,
    title: r.title,
    body: r.body,
    updatedAt: r.updatedAt,
    useCount: r.useCount,
    pinned: r.pinned,
  };
}

function recencyKey(r: MemoryRow): number {
  return r.lastUsedAt ? r.lastUsedAt.getTime() : 0;
}

// ── Retrieval (runTurn) ─────────────────────────────────────────────

export async function findRelevantMemories(a: {
  userId: string;
  query: string;
  limit: number;
}): Promise<Memory[]> {
  const active = rows.filter((r) => r.userId === a.userId && r.state === 'active');

  // Stage 1: pinned-first, most-recently-used order (find_memories_recent).
  const recent = [...active]
    .sort(
      (x, y) => Number(y.pinned) - Number(x.pinned) || recencyKey(y) - recencyKey(x) || y.id - x.id,
    )
    .slice(0, a.limit);

  // Stage 2: keyword full-text ranking (find_memories_fts).
  const terms = a.query.toLowerCase().split(/\W+/).filter(Boolean);
  const fts =
    terms.length === 0
      ? []
      : active
          .map((r) => {
            const hay = `${r.title} ${r.body}`.toLowerCase();
            const score = terms.reduce((n, t) => (hay.includes(t) ? n + 1 : n), 0);
            return { r, score };
          })
          .filter((x) => x.score > 0)
          .sort((x, y) => y.score - x.score)
          .slice(0, a.limit)
          .map((x) => x.r);

  const merged = new Map<number, Memory>();
  for (const r of [...recent, ...fts]) merged.set(r.id, toMemory(r));
  return [...merged.values()].slice(0, a.limit);
}

/** Atomic-ish increment of use_count + touch last_used_at (memories_mark_used). */
export async function markUsed(ids: number[]) {
  if (ids.length === 0) return;
  const now = new Date();
  for (const r of rows) {
    if (ids.includes(r.id)) {
      r.useCount += 1;
      r.lastUsedAt = now;
    }
  }
}

// ── Extractor CRUD (memory/extractMemory.ts) ────────────────────────

/** Active {slug,title} for the extractor's "existing index" prompt (limit 50). */
export function existingMemoryIndex(userId: string): { slug: string; title: string }[] {
  return rows
    .filter((r) => r.userId === userId && r.state === 'active')
    .slice(0, 50)
    .map((r) => ({ slug: r.slug, title: r.title }));
}

/** Active memories for the memory_list tool, most-recently-used first (limit 50). */
export function listMemories(
  userId: string,
): { slug: string; title: string; category: MemoryCategory }[] {
  return rows
    .filter((r) => r.userId === userId && r.state === 'active')
    .sort((x, y) => recencyKey(y) - recencyKey(x) || y.id - x.id)
    .slice(0, 50)
    .map((r) => ({ slug: r.slug, title: r.title, category: r.category }));
}

export function insertMemory(a: {
  userId: string;
  slug: string;
  category: MemoryCategory;
  title: string;
  body: string;
}): { ok: boolean; error?: string } {
  const clash = rows.find((r) => r.userId === a.userId && r.slug === a.slug);
  if (clash) return { ok: false, error: `slug "${a.slug}" already exists` };
  const now = new Date();
  rows.push({
    id: seq++,
    userId: a.userId,
    slug: a.slug,
    category: a.category,
    title: a.title,
    body: a.body,
    state: 'active',
    pinned: false,
    useCount: 0,
    lastUsedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  return { ok: true };
}

export function patchMemory(a: {
  userId: string;
  slug: string;
  title?: string;
  body?: string;
  category?: MemoryCategory;
}): { ok: boolean; error?: string } {
  const row = rows.find((r) => r.userId === a.userId && r.slug === a.slug);
  if (!row) return { ok: false, error: `slug "${a.slug}" not found` };
  if (a.title !== undefined) row.title = a.title;
  if (a.body !== undefined) row.body = a.body;
  if (a.category !== undefined) row.category = a.category;
  row.updatedAt = new Date();
  return { ok: true };
}
