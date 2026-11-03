import { describe, it, expect, vi, afterEach } from 'vitest';
import { runTurn } from './runTurn.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runTurn', () => {
  it('sends the default free model with a max_tokens cap, system prompt and tools', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        id: 'gen-1',
        model: 'google/gemma-4-31b-it:free',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await runTurn({ userId: 'U1', userMessage: 'Hi', sessionId: 's1' });

    expect(result.reply).toBe('Hello!');
    expect(result.toolCallCount).toBe(0);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('google/gemma-4-31b-it:free');
    // Without this, OpenRouter budgets the model's full output limit and can 402.
    expect(body.max_tokens).toBe(8192);
    expect(body.messages[0].role).toBe('system');
    expect(body.tools.map((t: { function: { name: string } }) => t.function.name).sort()).toEqual([
      'send_image',
      'task_browser',
      'task_github',
    ]);
  });
});
