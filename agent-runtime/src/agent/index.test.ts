import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_MODEL } from '../config/agentConfig.js';

// PROVIDERS reads OPEN_ROUTER_API_KEY at module load, so each test stubs the
// env first and imports a fresh copy.
async function loadProviders() {
  vi.resetModules();
  return (await import('./index.js')).PROVIDERS;
}

describe('PROVIDERS', () => {
  beforeEach(() => {
    vi.stubEnv('OPEN_ROUTER_API_KEY', 'test-openrouter-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('contains the configured default model', async () => {
    const providers = await loadProviders();
    expect(providers).toHaveProperty(DEFAULT_MODEL);
  });

  it('routes Gemini through OpenRouter as an AI SDK 4 (v1) model', async () => {
    const providers = await loadProviders();
    for (const [key, slug] of [
      ['gemini-2.5-flash', 'google/gemini-2.5-flash'],
      ['gemini-2.5-pro', 'google/gemini-2.5-pro'],
    ]) {
      const model = providers[key];
      expect(model.provider).toBe('openrouter.chat');
      expect(model.modelId).toBe(slug);
      // @mastra/core@0.10 runs on ai@4, which rejects anything but v1 at call time.
      expect(model.specificationVersion).toBe('v1');
    }
  });

  it('sends OPEN_ROUTER_API_KEY and attribution headers to the OpenRouter API', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        id: 'gen-1',
        model: 'google/gemini-2.5-flash',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const providers = await loadProviders();
    const result = await providers['gemini-2.5-flash'].doGenerate({
      inputFormat: 'messages',
      mode: { type: 'regular' },
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
    });

    expect(result.text).toBe('pong');
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer test-openrouter-key',
      'HTTP-Referer': 'https://andy770921-ai-agent.hf.space',
      'X-Title': 'LINE AI Agent',
    });
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'google/gemini-2.5-flash' });
  });
});
