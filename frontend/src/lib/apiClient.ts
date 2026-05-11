import type { AgentEvent, SessionSummary } from '@repo/shared';

const WORKER_BASE = process.env.NEXT_PUBLIC_WORKER_URL ?? '';

function authHeader(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` };
}

export async function fetchSessions(token: string): Promise<SessionSummary[]> {
  const r = await fetch(`${WORKER_BASE}/api/sessions`, { headers: authHeader(token) });
  if (!r.ok) throw new Error(`sessions ${r.status}`);
  return (await r.json()) as SessionSummary[];
}

export async function fetchHistory(
  token: string,
  userId: string,
  limit = 50,
): Promise<AgentEvent[]> {
  const r = await fetch(
    `${WORKER_BASE}/api/sessions/${encodeURIComponent(userId)}/history?limit=${limit}`,
    { headers: authHeader(token) },
  );
  if (!r.ok) throw new Error(`history ${r.status}`);
  return (await r.json()) as AgentEvent[];
}

export function streamUrl(): string {
  return `${WORKER_BASE}/api/sessions/stream`;
}
