import { describe, it, expect } from 'vitest';
import { composeSystem } from './composeSystem.js';
import type { Memory } from '../db/memories.js';

describe('composeSystem', () => {
  it('returns just the global prompt when no memories or skills', () => {
    expect(composeSystem('Hello bot', [])).toBe('Hello bot');
  });

  it('includes memory context', () => {
    const mem: Memory = {
      id: 1,
      title: 'Likes chocolate',
      body: 'User prefers dark chocolate over milk.',
      updatedAt: new Date(),
      useCount: 3,
      pinned: false,
    };
    const result = composeSystem('System prompt', [mem]);
    expect(result).toContain('<memory-context>');
    expect(result).toContain('Likes chocolate');
    expect(result).toContain('dark chocolate');
  });

  it('marks stale memories', () => {
    const mem: Memory = {
      id: 2,
      title: 'Old fact',
      body: 'Something from long ago',
      updatedAt: new Date(Date.now() - 2 * 24 * 3600_000),
      useCount: 0,
      pinned: false,
    };
    const result = composeSystem('Prompt', [mem]);
    expect(result).toContain('>1 day old');
  });

  it('includes skills before memories', () => {
    const mem: Memory = {
      id: 3,
      title: 'Fact',
      body: 'A fact',
      updatedAt: new Date(),
      useCount: 0,
      pinned: false,
    };
    const result = composeSystem('P', [mem], ['skill body']);
    const skillIdx = result.indexOf('<active-skills>');
    const memIdx = result.indexOf('<memory-context>');
    expect(skillIdx).toBeLessThan(memIdx);
  });

  it('truncates oversized memory blocks', () => {
    const mems: Memory[] = Array.from({ length: 100 }, (_, i) => ({
      id: i,
      title: `Memory ${i}`,
      body: 'x'.repeat(500),
      updatedAt: new Date(),
      useCount: 0,
      pinned: false,
    }));
    const result = composeSystem('P', mems);
    expect(result).toContain('truncated at 25 KB');
  });
});
