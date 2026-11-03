import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from '@mastra/core';

// Explicitly pass API keys — the default env var names don't match ours
// (e.g. @openrouter/ai-sdk-provider reads OPENROUTER_API_KEY, we use OPEN_ROUTER_API_KEY).
const openrouter = createOpenRouter({
  apiKey: process.env.OPEN_ROUTER_API_KEY ?? '',
  // Optional app attribution, shown on the OpenRouter activity dashboard.
  headers: {
    'HTTP-Referer': 'https://andy770921-ai-agent.hf.space',
    'X-Title': 'LINE AI Agent',
  },
});
const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? '',
});
const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY ?? '',
});

// Free models share an upstream rate-limit pool and 429 under load ("temporarily
// rate-limited upstream"). OpenRouter tries `models` in order on any error, so
// spread the chain across providers. Every entry must stay `:free`: a request is
// billed at the price of whichever model ends up serving it.
const FREE_MODEL_CHAIN = [
  'google/gemma-4-31b-it:free', // Google AI Studio
  'nvidia/nemotron-3-ultra-550b-a55b:free', // Nvidia
  'google/gemma-4-26b-a4b-it:free', // Google AI Studio
];

// Cast needed: @ai-sdk/*@3 returns LanguageModelV3, but @mastra/core@0.10
// expects LanguageModelV1. The runtime protocol is compatible; this is a
// type-level mismatch caused by the AI SDK v3↔v4 transition.
export const PROVIDERS: Record<string, LanguageModel> = {
  // No cast: @openrouter/ai-sdk-provider@0.7 is the AI SDK 4 line (LanguageModelV1).
  'gemini-2.5-flash': openrouter('google/gemini-2.5-flash'),
  'gemini-2.5-pro': openrouter('google/gemini-2.5-pro'),
  // $0 per token; OpenRouter allows 20 req/min and 50 req/day until $10 of credits are bought.
  'gemma-4-31b-it:free': openrouter(FREE_MODEL_CHAIN[0], { models: FREE_MODEL_CHAIN }),
  'claude-sonnet-4-6': anthropic('claude-sonnet-4-6') as unknown as LanguageModel,
  'claude-haiku-4-5': anthropic('claude-haiku-4-5-20251001') as unknown as LanguageModel,
  'gpt-4o': openai('gpt-4o') as unknown as LanguageModel,
};

export type ProviderKey = string;

export { Agent };

export const mastra: InstanceType<typeof Mastra> = new Mastra({});
