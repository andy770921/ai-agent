import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from '@mastra/core';

// Explicitly pass API keys — the default env var names don't match ours
// (e.g. @ai-sdk/google reads GOOGLE_GENERATIVE_AI_API_KEY, we use GEMINI_API_KEY).
const google = createGoogleGenerativeAI({
  apiKey: process.env.GEMINI_API_KEY ?? '',
});
const anthropic = createAnthropic({
  apiKey: process.env.ANTHROPIC_API_KEY ?? '',
});
const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY ?? '',
});

// Cast needed: @ai-sdk/*@3 returns LanguageModelV3, but @mastra/core@0.10
// expects LanguageModelV1. The runtime protocol is compatible; this is a
// type-level mismatch caused by the AI SDK v3↔v4 transition.
export const PROVIDERS: Record<string, LanguageModel> = {
  'gemini-2.5-flash': google('gemini-2.5-flash') as unknown as LanguageModel,
  'gemini-2.5-pro': google('gemini-2.5-pro') as unknown as LanguageModel,
  'claude-sonnet-4-6': anthropic('claude-sonnet-4-6') as unknown as LanguageModel,
  'claude-haiku-4-5': anthropic('claude-haiku-4-5-20251001') as unknown as LanguageModel,
  'gpt-4o': openai('gpt-4o') as unknown as LanguageModel,
};

export type ProviderKey = string;

export { Agent };

export const mastra: InstanceType<typeof Mastra> = new Mastra({});
