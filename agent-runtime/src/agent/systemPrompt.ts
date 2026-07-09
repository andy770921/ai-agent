import { getAgentConfig } from '../config/agentConfig.js';

let cached: { value: string; loadedAt: number } | null = null;
const TTL_MS = 60_000;

export async function getSystemPrompt(): Promise<string> {
  const now = Date.now();
  if (cached && now - cached.loadedAt < TTL_MS) return cached.value;
  const value = await getAgentConfig('system_prompt');
  cached = { value, loadedAt: now };
  return value;
}
