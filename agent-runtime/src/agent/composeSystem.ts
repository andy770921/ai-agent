import type { Memory } from '../store/memoryStore.js';

const MAX_MEMORY_BLOCK_BYTES = 25_000;

export function composeSystem(
  globalPrompt: string,
  memories: Memory[],
  skills: string[] = [],
): string {
  const parts = [globalPrompt];

  if (skills.length > 0) {
    parts.push(`\n\n<active-skills>\n${skills.join('\n---\n')}\n</active-skills>`);
  }

  if (memories.length > 0) {
    let block = memories
      .map((m) => {
        const stale = Date.now() - m.updatedAt.getTime() > 24 * 3600_000;
        return `- ${m.title}${stale ? ' (NOTE: >1 day old, verify before recommending)' : ''}: ${m.body}`;
      })
      .join('\n');

    if (block.length > MAX_MEMORY_BLOCK_BYTES) {
      block = block.slice(0, block.lastIndexOf('\n', MAX_MEMORY_BLOCK_BYTES));
      block += '\n> Memory index truncated at 25 KB.';
    }

    parts.push(`\n\n<memory-context>\n${block}\n</memory-context>`);
  }

  return parts.join('');
}
