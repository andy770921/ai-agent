import type { Env } from './env';

export function corsHeaders(env: Env): Record<string, string> {
  return {
    'access-control-allow-origin': env.DASHBOARD_ORIGIN,
    'access-control-allow-headers': 'authorization, content-type, accept',
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-max-age': '86400',
  };
}

export function handlePreflight(env: Env): Response {
  return new Response(null, { status: 204, headers: corsHeaders(env) });
}
