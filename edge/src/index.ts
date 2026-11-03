import type { Env } from './env';
import { handleLineWebhook } from './lineWebhook';
import { handleImageUpload } from './imageUpload';
import { handleImageServe } from './imageServe';
import { handleSessionsStream } from './dashboardSse';
import { handleSessionsList, handleSessionsHistory } from './dashboardRest';
import { requireDashboardToken } from './auth';
import { corsHeaders } from './cors';
import { createHttpSidecarClient } from './ports/sidecarClient';
import { createKvImageStore } from './ports/imageStore';
import { createRouter, type RouteHandler } from './router';
import { pingAgentRuntime } from './keepAlive';

export type { Env };

const IMAGE_TTL_SECONDS = 86400;

function dashboardRoute(
  inner: (
    req: Request,
    env: Env,
    ctx: ExecutionContext,
    params: Record<string, string>,
  ) => Promise<Response>,
): RouteHandler<Env> {
  return async (req, env, ctx, params) => {
    const authErr = requireDashboardToken(req, env);
    if (authErr) return authErr;
    return inner(req, env, ctx, params);
  };
}

const router = createRouter<Env>(
  [
    {
      method: 'POST',
      pattern: '/line/webhook',
      handler: (req, env, ctx) => handleLineWebhook(req, env, ctx),
    },
    {
      method: 'PUT',
      pattern: '/img/:key',
      handler: (req, env, _ctx, params) =>
        handleImageUpload(
          req,
          createKvImageStore(env.IMG_KV, IMAGE_TTL_SECONDS),
          env.CF_UPLOAD_SECRET,
          params.key!,
        ),
    },
    {
      method: 'GET',
      pattern: '/img/:key',
      handler: (req, env, _ctx, params) =>
        handleImageServe(req, createKvImageStore(env.IMG_KV, IMAGE_TTL_SECONDS), params.key!),
    },
    {
      method: 'GET',
      pattern: '/api/sessions/stream',
      cors: true,
      handler: dashboardRoute((req, env) =>
        handleSessionsStream(
          req,
          createHttpSidecarClient(env.SIDECAR_BASE_URL, env.DASHBOARD_INGEST_TOKEN),
        ),
      ),
    },
    {
      method: 'GET',
      pattern: '/api/sessions',
      cors: true,
      handler: dashboardRoute((req, env) =>
        handleSessionsList(
          req,
          createHttpSidecarClient(env.SIDECAR_BASE_URL, env.DASHBOARD_INGEST_TOKEN),
        ),
      ),
    },
    {
      method: 'GET',
      pattern: '/api/sessions/:userId/history',
      cors: true,
      handler: dashboardRoute((req, env, _ctx, params) =>
        handleSessionsHistory(
          req,
          createHttpSidecarClient(env.SIDECAR_BASE_URL, env.DASHBOARD_INGEST_TOKEN),
          params.userId!,
        ),
      ),
    },
  ],
  { corsHeaders, corsPathPrefixes: ['/api/'] },
);

export default {
  fetch: router.fetch,
  // Cron Trigger (wrangler.toml `[triggers]`): keep the HF Space awake.
  // Awaited so a failed ping fails the invocation instead of passing silently.
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    await pingAgentRuntime(env.GATEWAY_BASE_URL);
  },
};
