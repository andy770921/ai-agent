import { db } from './client.js';

export interface Skill {
  body: string;
  frontmatter: Record<string, unknown>;
}

export async function findRelevantSkills(a: {
  userId: string;
  query: string;
}): Promise<Skill[]> {
  const [pinned, fts] = await Promise.all([
    db()
      .from('skills')
      .select('body, frontmatter')
      .or(`user_id.eq.${a.userId},user_id.is.null`)
      .eq('state', 'active')
      .eq('pinned', true),
    db().rpc('find_skills_fts', {
      p_user_id: a.userId,
      p_query: a.query,
      p_limit: 5,
    }),
  ]);

  const all = [...(pinned.data ?? []), ...(fts.data ?? [])];
  const seen = new Set<string>();
  return all.filter((s) => {
    const key = JSON.stringify(s.frontmatter);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
