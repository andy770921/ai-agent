import { getAgentConfig } from '../config/agentConfig.js';
import { memoryExtractionStats } from '../store/curatorRunStore.js';

export interface GateResult {
  allow: boolean;
  reason?: string;
}

export async function gateMemoryExtraction(userId: string): Promise<GateResult> {
  const enabled = await getAgentConfig('memory_extraction_enabled').catch(() => 'false');
  if (enabled !== 'true') return { allow: false, reason: 'feature_flag_off' };

  const stats = memoryExtractionStats(userId);
  if (stats.sinceLastSuccess < 86400) return { allow: false, reason: 'cooldown_24h' };
  if (stats.sinceLastAttempt < 600) return { allow: false, reason: 'throttle_10m' };
  if (stats.newSessions < 5) return { allow: false, reason: 'sessions_under_5' };
  return { allow: true };
}
