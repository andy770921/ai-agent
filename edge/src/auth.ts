import type { Env } from './env';

export function requireDashboardToken(req: Request, env: Env): Response | undefined {
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${env.DASHBOARD_TOKEN}`) {
    return new Response('unauthorized', { status: 401 });
  }
  return undefined;
}
