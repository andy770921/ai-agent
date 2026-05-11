import type { Env } from './env';

export async function handleSessionsStream(
  _req: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(`${env.SIDECAR_BASE_URL}/events/stream`, {
      headers: {
        'authorization': `Bearer ${env.DASHBOARD_INGEST_TOKEN}`,
        'accept': 'text/event-stream',
      },
    });
  } catch {
    return new Response('upstream error', { status: 502 });
  }
  if (!upstream.ok || !upstream.body) {
    return new Response('upstream error', { status: 502 });
  }
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    },
  });
}
