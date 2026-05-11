import type { Env } from './env';

function passthrough(r: Response): Response {
  // Preserve upstream content-type so an error response that's text/plain
  // doesn't crash the dashboard's `r.json()` parser.
  const ct = r.headers.get('content-type') ?? 'application/json';
  return new Response(r.body, {
    status: r.status,
    headers: { 'content-type': ct },
  });
}

async function safeFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    // Sidecar unreachable (DNS, TLS, network) — surface as 502 instead of
    // letting the Worker runtime return a generic 500.
    return new Response('upstream error', { status: 502 });
  }
}

export async function handleSessionsList(_req: Request, env: Env): Promise<Response> {
  const r = await safeFetch(`${env.SIDECAR_BASE_URL}/sessions`, {
    headers: { authorization: `Bearer ${env.DASHBOARD_INGEST_TOKEN}` },
  });
  return passthrough(r);
}

export async function handleSessionsHistory(
  req: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const u = new URL(req.url);
  const limit = u.searchParams.get('limit') ?? '50';
  const r = await safeFetch(
    `${env.SIDECAR_BASE_URL}/sessions/${encodeURIComponent(userId)}/history?limit=${encodeURIComponent(limit)}`,
    { headers: { authorization: `Bearer ${env.DASHBOARD_INGEST_TOKEN}` } },
  );
  return passthrough(r);
}
