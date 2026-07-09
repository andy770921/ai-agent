import { describe, it, expect } from 'vitest';
import { appendUserMessage, appendAssistantMessage, loadRecentMessages } from './messageStore.js';
import { insertMemory, patchMemory, findRelevantMemories } from './memoryStore.js';
import { upsertSkill, findRelevantSkills } from './skillStore.js';
import { recordCuratorRun, memoryExtractionStats } from './curatorRunStore.js';
import { withAdvisoryLock } from './locks.js';

describe('messageStore', () => {
  it('loads appended messages in order', async () => {
    const s = { userId: 'U-msg-1', sessionId: 'S1' };
    appendUserMessage({ ...s, content: 'hi' });
    appendAssistantMessage({ ...s, content: 'hello' });
    const rows = await loadRecentMessages({ ...s, limit: 50 });
    expect(rows.map((r) => [r.role, r.content.text])).toEqual([
      ['user', 'hi'],
      ['assistant', 'hello'],
    ]);
  });

  it('limit returns only the most recent N', async () => {
    const s = { userId: 'U-msg-2', sessionId: 'S1' };
    for (let i = 0; i < 5; i++) appendUserMessage({ ...s, content: `m${i}` });
    const rows = await loadRecentMessages({ ...s, limit: 2 });
    expect(rows.map((r) => r.content.text)).toEqual(['m3', 'm4']);
  });

  it('isolates sessions from each other', async () => {
    appendUserMessage({ userId: 'U-msg-3', sessionId: 'A', content: 'a' });
    appendUserMessage({ userId: 'U-msg-3', sessionId: 'B', content: 'b' });
    const rows = await loadRecentMessages({ userId: 'U-msg-3', sessionId: 'A', limit: 50 });
    expect(rows).toHaveLength(1);
    expect(rows[0].content.text).toBe('a');
  });
});

describe('memoryStore', () => {
  it('inserts and retrieves a memory', async () => {
    insertMemory({
      userId: 'U-mem-1',
      slug: 'likes-tea',
      category: 'user',
      title: 'Likes tea',
      body: 'Prefers green tea.',
    });
    const found = await findRelevantMemories({ userId: 'U-mem-1', query: 'tea', limit: 10 });
    expect(found.map((m) => m.title)).toContain('Likes tea');
  });

  it('rejects a duplicate slug', () => {
    insertMemory({ userId: 'U-mem-2', slug: 'dup', category: 'user', title: 'A', body: 'a' });
    const second = insertMemory({
      userId: 'U-mem-2',
      slug: 'dup',
      category: 'user',
      title: 'B',
      body: 'b',
    });
    expect(second.ok).toBe(false);
  });

  it('patches an existing memory body', async () => {
    insertMemory({ userId: 'U-mem-3', slug: 's', category: 'project', title: 'T', body: 'old' });
    const r = patchMemory({ userId: 'U-mem-3', slug: 's', body: 'new body' });
    expect(r.ok).toBe(true);
    const found = await findRelevantMemories({ userId: 'U-mem-3', query: 'new', limit: 10 });
    expect(found[0].body).toBe('new body');
  });

  it('scopes memories per user', async () => {
    insertMemory({ userId: 'U-mem-5a', slug: 'x', category: 'user', title: 'Mine', body: 'y' });
    const other = await findRelevantMemories({ userId: 'U-mem-5b', query: 'Mine', limit: 10 });
    expect(other).toHaveLength(0);
  });
});

describe('skillStore', () => {
  it('retrieves an active skill by keyword', async () => {
    upsertSkill({
      userId: 'U-skill-1',
      slug: 'screenshot',
      body: 'Take a screenshot of a webpage using the browser.',
      frontmatter: { name: 'screenshot', description: 'x' },
    });
    const found = await findRelevantSkills({ userId: 'U-skill-1', query: 'screenshot webpage' });
    expect(found.map((s) => s.frontmatter.name)).toContain('screenshot');
  });

  it('does not leak skills across users', async () => {
    upsertSkill({
      userId: 'U-skill-2a',
      slug: 'private',
      body: 'private skill body',
      frontmatter: { name: 'private', description: 'x' },
    });
    const found = await findRelevantSkills({ userId: 'U-skill-2b', query: 'private skill' });
    expect(found).toHaveLength(0);
  });
});

describe('curatorRunStore', () => {
  it('records a run with an incrementing id', () => {
    const run = recordCuratorRun({ phase: 'extract-attempt' });
    expect(run.id).toBeGreaterThan(0);
  });

  it('newSessions is always 0 (no session-end writer)', () => {
    recordCuratorRun({ userId: 'U-cur-1', phase: 'extract-attempt' });
    const stats = memoryExtractionStats('U-cur-1');
    expect(stats.newSessions).toBe(0);
    expect(stats.sinceLastAttempt).toBeLessThan(60);
    expect(stats.sinceLastSuccess).toBeGreaterThan(1e8);
  });
});

describe('locks', () => {
  it('runs the fn and returns its result', async () => {
    const r = await withAdvisoryLock('lock-a', async () => 42);
    expect(r).toBe(42);
  });

  it('skips when the lock is already held', async () => {
    const outer = withAdvisoryLock('lock-b', async () => {
      const inner = await withAdvisoryLock('lock-b', async () => 'inner');
      return inner;
    });
    expect(await outer).toEqual({ skipped: true, reason: 'lock_held' });
  });

  it('releases the lock after completion', async () => {
    await withAdvisoryLock('lock-c', async () => 'first');
    const second = await withAdvisoryLock('lock-c', async () => 'second');
    expect(second).toBe('second');
  });
});
