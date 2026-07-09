// In-memory skill store (replaces the Supabase `skills` table + its FTS RPCs).
// Lives for the container's lifetime.
//
// `userId === null` marks a global skill shared across users (as the old
// `user_id IS NULL` rows did). FTS is approximated by keyword overlap on body.

export type SkillState = 'active' | 'stale' | 'archived';

/** Shape consumed by findRelevantSkills / runTurn. */
export interface Skill {
  body: string;
  frontmatter: Record<string, unknown>;
}

interface SkillRow {
  id: number;
  userId: string | null;
  slug: string;
  body: string;
  frontmatter: Record<string, unknown>;
  createdBy: 'agent' | 'user';
  state: SkillState;
  pinned: boolean;
  useCount: number;
  lastUsedAt: Date | null;
  createdAt: Date;
}

let seq = 1;
const rows: SkillRow[] = [];

/** Visible to a user = their own rows plus global (userId null) rows. */
function visibleTo(r: SkillRow, userId: string): boolean {
  return r.userId === userId || r.userId === null;
}

// ── Retrieval (runTurn) ─────────────────────────────────────────────

export async function findRelevantSkills(a: { userId: string; query: string }): Promise<Skill[]> {
  const pinned = rows.filter((r) => visibleTo(r, a.userId) && r.state === 'active' && r.pinned);

  const terms = a.query.toLowerCase().split(/\W+/).filter(Boolean);
  const fts =
    terms.length === 0
      ? []
      : rows
          .filter((r) => visibleTo(r, a.userId) && r.state === 'active')
          .map((r) => {
            const hay = r.body.toLowerCase();
            const score = terms.reduce((n, t) => (hay.includes(t) ? n + 1 : n), 0);
            return { r, score };
          })
          .filter((x) => x.score > 0)
          .sort((x, y) => y.score - x.score)
          .slice(0, 5)
          .map((x) => x.r);

  const all = [...pinned, ...fts].map((r) => ({ body: r.body, frontmatter: r.frontmatter }));
  const seen = new Set<string>();
  return all.filter((s) => {
    const key = JSON.stringify(s.frontmatter);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Skill creation (skills/createSkill.ts) ──────────────────────────

/** {slug,frontmatter} visible to a user, for the creator's "existing" prompt (limit 50). */
export function listSkillsForUser(
  userId: string,
): { slug: string; frontmatter: Record<string, unknown> }[] {
  return rows
    .filter((r) => visibleTo(r, userId))
    .slice(0, 50)
    .map((r) => ({ slug: r.slug, frontmatter: r.frontmatter }));
}

export function upsertSkill(a: {
  userId: string;
  slug: string;
  body: string;
  frontmatter: Record<string, unknown>;
  createdBy?: 'agent' | 'user';
  state?: SkillState;
}) {
  const row = rows.find((r) => r.userId === a.userId && r.slug === a.slug);
  if (row) {
    row.body = a.body;
    row.frontmatter = a.frontmatter;
    row.createdBy = a.createdBy ?? row.createdBy;
    row.state = a.state ?? row.state;
    return;
  }
  rows.push({
    id: seq++,
    userId: a.userId,
    slug: a.slug,
    body: a.body,
    frontmatter: a.frontmatter,
    createdBy: a.createdBy ?? 'agent',
    state: a.state ?? 'active',
    pinned: false,
    useCount: 0,
    lastUsedAt: null,
    createdAt: new Date(),
  });
}
