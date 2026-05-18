import { db } from '../db/client.js';

export interface GateResult {
  allow: boolean;
  reason?: string;
}

export async function gateMemoryExtraction(
  userId: string,
): Promise<GateResult> {
  const cfg = await db()
    .from('agent_config')
    .select('value')
    .eq('key', 'memory_extraction_enabled')
    .single();
  if (cfg.data?.value !== 'true')
    return { allow: false, reason: 'feature_flag_off' };

  const r = await db().rpc('memory_extraction_stats', {
    p_user_id: userId,
  });

  const row = r.data?.[0];
  if (row?.since_last_success < 86400)
    return { allow: false, reason: 'cooldown_24h' };
  if (row?.since_last_attempt < 600)
    return { allow: false, reason: 'throttle_10m' };
  if ((row?.new_sessions ?? 0) < 5)
    return { allow: false, reason: 'sessions_under_5' };
  return { allow: true };
}
