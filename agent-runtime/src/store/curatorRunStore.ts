// In-memory run bookkeeping for the memory-extraction gate (was the Supabase
// `curator_runs` table + the memory_extraction_stats RPC). Kept after the
// curator cron was removed because memory/gateCheck.ts + memory/extractMemory.ts
// still record and read extraction attempts here.
//
// NOTE: `newSessions` counts runs with phase `session-end`, but no code writes
// that phase (kept faithful to the Supabase version). It is therefore always 0,
// which is why the memory-extraction gate never opens. See memory/gateCheck.ts.

export interface CuratorRun {
  id: number;
  userId: string | null;
  phase: string;
  startedAt: Date;
}

let runSeq = 1;
const runs: CuratorRun[] = [];

export function recordCuratorRun(a: { userId?: string | null; phase: string }): CuratorRun {
  const run: CuratorRun = {
    id: runSeq++,
    userId: a.userId ?? null,
    phase: a.phase,
    startedAt: new Date(),
  };
  runs.push(run);
  return run;
}

/** Seconds since the newest run of `phase` for `userId`; 1e9 if none. */
function secondsSince(userId: string, phase: string): number {
  const times = runs
    .filter((r) => r.userId === userId && r.phase === phase)
    .map((r) => r.startedAt.getTime());
  if (times.length === 0) return 1e9;
  return (Date.now() - Math.max(...times)) / 1000;
}

export function memoryExtractionStats(userId: string): {
  sinceLastSuccess: number;
  sinceLastAttempt: number;
  newSessions: number;
} {
  const thirtyDaysAgo = Date.now() - 30 * 86_400_000;
  const newSessions = runs.filter(
    (r) =>
      r.userId === userId && r.phase === 'session-end' && r.startedAt.getTime() > thirtyDaysAgo,
  ).length;
  return {
    sinceLastSuccess: secondsSince(userId, 'extract-success'),
    sinceLastAttempt: secondsSince(userId, 'extract-attempt'),
    newSessions,
  };
}
