import { isAllowedUser } from './allowlist';
import type { Env } from './env';
import { createLineReplyBlockedUserReplier } from './line/blockedUserReplier';
import { createHttpGatewayForwarder } from './line/gatewayForwarder';
import { createHmacSignatureVerifier } from './line/signatureVerifier';
import { createLineWebhookHandler } from './line/webhookHandler';
import { createKvWebhookDedupStore } from './line/webhookDedupStore';

const DEDUP_TTL_SECONDS = 600;

export function handleLineWebhook(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const handler = createLineWebhookHandler({
    verifier: createHmacSignatureVerifier(env.LINE_CHANNEL_SECRET),
    dedup: createKvWebhookDedupStore(env.WEBHOOK_DEDUP, DEDUP_TTL_SECONDS),
    forwarder: createHttpGatewayForwarder(env.GATEWAY_BASE_URL),
    blockedReplier: createLineReplyBlockedUserReplier(env.LINE_CHANNEL_ACCESS_TOKEN),
    isUserAllowed: (id) => isAllowedUser(id, env.LINE_ALLOWED_USER_IDS),
  });
  return handler(req, ctx);
}
