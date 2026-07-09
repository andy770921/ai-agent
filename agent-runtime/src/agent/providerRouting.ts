import { PROVIDERS, type ProviderKey } from './index.js';
import { getAgentConfig } from '../config/agentConfig.js';

export async function pickProvider(
  _userId: string,
  hint?: 'main' | 'extractor' | 'skill-creator',
): Promise<ProviderKey> {
  const roleKey = hint ? `default_model:${hint}` : 'default_model';
  const v = await getAgentConfig(roleKey).catch(() => null);
  if (v && v in PROVIDERS) return v as ProviderKey;
  return (await getAgentConfig('default_model')) as ProviderKey;
}
