import type { Env } from './env';
import { handleLineWebhook } from './lineWebhook';
import { handleImageUpload } from './imageUpload';
import { handleImageServe } from './imageServe';
import { handleSessionsStream } from './dashboardSse';
import { handleSessionsList, handleSessionsHistory } from './dashboardRest';
import { requireDashboardToken } from './auth';
import { corsHeaders, handlePreflight } from './cors';

export type { Env };

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return handlePreflight(env);
    }

    if (req.method === 'POST' && url.pathname === '/line/webhook') {
      return handleLineWebhook(req, env, ctx);
    }

    if (req.method === 'PUT' && url.pathname.startsWith('/img/')) {
      return handleImageUpload(req, env, url.pathname.slice(5));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/img/')) {
      return handleImageServe(req, env, url.pathname.slice(5));
    }

    if (url.pathname.startsWith('/api/')) {
      const authErr = requireDashboardToken(req, env);
      if (authErr) return withCors(authErr, env);

      let response: Response;
      if (req.method === 'GET' && url.pathname === '/api/sessions/stream') {
        response = await handleSessionsStream(req, env, ctx);
      } else if (req.method === 'GET' && url.pathname === '/api/sessions') {
        response = await handleSessionsList(req, env);
      } else {
        const m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/history$/);
        if (req.method === 'GET' && m) {
          response = await handleSessionsHistory(req, env, decodeURIComponent(m[1]!));
        } else {
          return withCors(new Response('not found', { status: 404 }), env);
        }
      }
      return withCors(response, env);
    }

    return new Response('not found', { status: 404 });
  },
};

function withCors(response: Response, env: Env): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(env))) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}
