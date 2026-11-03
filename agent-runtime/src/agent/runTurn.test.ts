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

  it('sends a free-only fallback chain and logs the model that actually served', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchMock = vi.fn(async () =>
      Response.json({
        id: 'gen-2',
        // OpenRouter fell back past the rate-limited primary.
        model: 'nvidia/nemotron-3-ultra-550b-a55b:free',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Hi!' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await runTurn({ userId: 'U1', userMessage: 'Hi', sessionId: 's2' });

    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.models[0]).toBe(body.model);
    expect(body.models.length).toBeGreaterThan(1);
    // A fallback is billed at its own price, so a paid entry would cost money.
    for (const m of body.models) expect(m).toMatch(/:free$/);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('served by nvidia/nemotron-3-ultra-550b-a55b:free'),
    );
    log.mockRestore();
  });
});
