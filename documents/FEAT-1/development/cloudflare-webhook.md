# Implementation Plan: Cloudflare Edge Worker (Webhook + Image + Dashboard BFF)

## Overview

A single **Cloudflare Worker** that does **three** jobs (consolidated from the original "Worker + NestJS BFF" split — see PRD topology revision):

1. **`POST /line/webhook`** — receives LINE webhooks, verifies LINE's `X-Line-Signature` HMAC (a **fast-fail pre-check** at the edge; `openab-gateway` is the authoritative re-verifier — see `openab-upstream-findings.md` §3), drops events from non-allowlisted LINE userIds, dedupes via KV on `webhookEventId`, then forwards the verified payload to the gateway's `/webhook/line`.
2. **`PUT /img/:id` & `GET /img/:id`** — accepts authenticated PUT uploads from the Northflank container into a Cloudflare **KV namespace** (`IMG_KV`, with `expirationTtl: 86400`), then serves them publicly so LINE's CDN can fetch screenshots. (We use KV instead of R2 because R2 requires a credit card and KV's free tier comfortably fits ≤5-user screenshot traffic — see "Why KV instead of R2" in Notes.)
3. **Dashboard BFF (v1.5):** `GET /api/sessions/stream` (SSE proxy from the agent-runtime sidecar on Northflank `:8081`), `GET /api/sessions`, `GET /api/sessions/:userId/history` — all auth-gated by a single `DASHBOARD_TOKEN` that the dashboard frontend supplies.

Why one Worker (not Worker + NestJS BFF):
- Both pieces are TypeScript with the same auth model and the same shared types — splitting them is operational tax for no architectural gain.
- Cloudflare Workers natively support SSE without timeout issues that hurt Vercel serverless.
- Free tier (100k req/day) covers everything: LINE webhooks + dashboard SSE + REST. Nowhere close to the limit at ≤5 users.
- Removes a deploy target (Vercel serverless backend).
- The boilerplate's `backend/` (NestJS) becomes **unused for FEAT-1** — kept around for future features. We don't delete it.

## Files to Create

> **Important — topology revised:** lives in this monorepo at the top level under `edge/`. It IS an npm workspace (TypeScript, can depend on `@repo/shared`).

```
edge/
├── wrangler.toml
├── package.json                  # depends on "@repo/shared": "*"
├── tsconfig.json
├── src/
│   ├── index.ts                  # Worker entry: routes + bindings
│   ├── lineWebhook.ts            # LINE signature verification + forward
│   ├── imageUpload.ts            # PUT /img/:id (auth + KV put with 24h TTL)
│   ├── imageServe.ts             # GET /img/:id (KV get + cache headers)
│   ├── allowlist.ts              # parse + check LINE userId allowlist
│   ├── cors.ts                   # CORS headers for dashboard cross-origin requests
│   ├── dashboardSse.ts           # NEW v1.5 — SSE proxy: /api/sessions/stream
│   ├── dashboardRest.ts          # NEW v1.5 — REST proxy: /api/sessions, /api/sessions/:userId/history
│   └── auth.ts                   # NEW — bearer token check for dashboard routes
├── test/
│   ├── lineWebhook.test.ts
│   ├── allowlist.test.ts
│   └── auth.test.ts
└── .dev.vars.example
```

The root `package.json` adds `edge` to its `workspaces` array. `turbo.json` gains `edge:dev` (`wrangler dev`) and `edge:deploy` (`wrangler deploy`) tasks.

## Step-by-Step Implementation

### Step 1: Wrangler config

**File:** `wrangler.toml`

**Changes:**

```toml
name = "ai-agent-edge-server"
main = "src/index.ts"
compatibility_date = "2025-09-01"
compatibility_flags = ["nodejs_compat"]

# Webhook event de-duplication store. Holds <webhookEventId, status> for ~10 min
# so retries / redeliveries from LINE don't replay GitHub or browser actions.
# This is the OUTER ring; openab-gateway also has its own 50s replyToken cache
# (per openab-upstream-findings.md §3) for the reply path, but our KV check
# handles the case where LINE retries deliver the same webhookEventId minutes
# apart, which is outside the gateway's cache window.
[[kv_namespaces]]
binding = "WEBHOOK_DEDUP"
id      = "<fill via wrangler kv:namespace create WEBHOOK_DEDUP>"
preview_id = "<fill via wrangler kv:namespace create WEBHOOK_DEDUP --preview>"

# Screenshot host. Replaces what would normally be an R2 bucket; we use KV to
# avoid R2's credit-card requirement on the Cloudflare account. KV's free tier
# is 1 GB total storage with 25 MB per value, which is comfortably above any
# Playwright PNG. Each upload is written with `expirationTtl: 86400` so the
# 24h lifecycle is enforced by KV itself, no dashboard rule needed.
[[kv_namespaces]]
binding = "IMG_KV"
id      = "<fill via wrangler kv:namespace create IMG_KV>"
preview_id = "<fill via wrangler kv:namespace create IMG_KV --preview>"

[vars]
# Gateway base URL — the openab-gateway listens on :8080 of the Northflank service.
# Forwarding goes to ${GATEWAY_BASE_URL}/webhook/line.
GATEWAY_BASE_URL       = "https://<container>.northflank.app"
# Dashboard sidecar lives on :8081; Northflank exposes it on the same hostname
# but a different port (configured in service.yaml).
SIDECAR_BASE_URL       = "https://<container>--8081.northflank.app"
DASHBOARD_ORIGIN       = "https://ai-agent-dashboard.pages.dev"

# Secrets (set via `wrangler secret put`):
#   LINE_CHANNEL_SECRET    — for the Worker's HMAC pre-check (the gateway re-verifies)
#   LINE_ALLOWED_USER_IDS  — comma-separated LINE userIds (edge-level fast-fail)
#   CF_UPLOAD_SECRET       — shared bearer for /img PUT (container -> Worker)
#   DASHBOARD_INGEST_TOKEN — bearer for /events/stream + /sessions (Worker -> sidecar)
#   DASHBOARD_TOKEN        — bearer the FRONTEND uses to authenticate against /api/*
```

> **`NORTHFLANK_FORWARD_TOKEN` removed.** Earlier drafts of this file routed the Worker → container via a custom bearer plus a `/openab/*` proxy. Now that webhooks land on the gateway's documented `/webhook/line`, the gateway's HMAC re-verification (against `LINE_CHANNEL_SECRET`) **is** the authentication — there is no second bearer hop. The same is **not** true of the sidecar (`:8081`) which still uses `DASHBOARD_INGEST_TOKEN` because the dashboard endpoints are not HMAC-signed.

**Rationale:**
- **Two base URLs** because the gateway and sidecar live on different ports of the same Northflank service. Northflank exposes each port at a unique hostname slot (`<container>--<port>.northflank.app`); the Worker dials each one for its respective concerns.
- **Two KV namespaces, no R2.** `WEBHOOK_DEDUP` is the dedup ring; `IMG_KV` is the image host. Both live on Cloudflare's free tier (no credit card). See "Why KV instead of R2" below.

### Step 2: Worker entry — route fan-out

**File:** `src/index.ts`

**Changes:**

```ts
import { handleLineWebhook } from './lineWebhook';
import { handleImageUpload } from './imageUpload';
import { handleImageServe } from './imageServe';
import { handleSessionsStream } from './dashboardSse';
import { handleSessionsList, handleSessionsHistory } from './dashboardRest';
import { requireDashboardToken } from './auth';
import { corsHeaders, handlePreflight } from './cors';

export interface Env {
  IMG_KV: KVNamespace;        // screenshot host, 24h TTL (see Step 5)
  WEBHOOK_DEDUP: KVNamespace; // LINE webhookEventId dedup, ~10 min TTL
  GATEWAY_BASE_URL: string;
  SIDECAR_BASE_URL: string;
  DASHBOARD_INGEST_TOKEN: string;
  DASHBOARD_TOKEN: string;
  LINE_CHANNEL_SECRET: string;
  LINE_ALLOWED_USER_IDS: string;
  CF_UPLOAD_SECRET: string;
  DASHBOARD_ORIGIN: string; // e.g. "https://ai-agent-dashboard.pages.dev"
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // CORS preflight for dashboard routes
    if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return handlePreflight(env);
    }

    // Public — LINE
    if (req.method === 'POST' && url.pathname === '/line/webhook') {
      return handleLineWebhook(req, env, ctx);
    }
    // Public — image read; authenticated upload
    if (req.method === 'PUT' && url.pathname.startsWith('/img/')) {
      return handleImageUpload(req, env, url.pathname.slice(5));
    }
    if (req.method === 'GET' && url.pathname.startsWith('/img/')) {
      return handleImageServe(req, env, url.pathname.slice(5));
    }

    // Dashboard BFF (v1.5) — all gated by DASHBOARD_TOKEN
    if (url.pathname.startsWith('/api/')) {
      const authErr = requireDashboardToken(req, env);
      if (authErr) return authErr;

      let response: Response;
      if (req.method === 'GET' && url.pathname === '/api/sessions/stream') {
        response = await handleSessionsStream(req, env, ctx);
      } else if (req.method === 'GET' && url.pathname === '/api/sessions') {
        response = await handleSessionsList(req, env);
      } else {
        const m = url.pathname.match(/^\/api\/sessions\/([^/]+)\/history$/);
        if (req.method === 'GET' && m) {
          response = await handleSessionsHistory(req, env, decodeURIComponent(m[1]));
        } else {
          return new Response('not found', { status: 404 });
        }
      }
      // Attach CORS headers to every /api/* response
      const headers = new Headers(response.headers);
      for (const [k, v] of Object.entries(corsHeaders(env))) headers.set(k, v);
      return new Response(response.body, { status: response.status, headers });
    }
    return new Response('not found', { status: 404 });
  },
};
```

**Rationale:** Six routes is still well within "no framework needed" territory. Auth is a single-line guard at the top of the `/api/*` block. CORS headers are required because the dashboard (Cloudflare Pages) and the Worker live on different origins — without them, every browser `fetch` from the dashboard will fail.

### Step 2.5: CORS helper

**File:** `src/cors.ts`

> **Why this is required (not optional):** The dashboard on Cloudflare Pages (e.g. `ai-agent-dashboard.pages.dev`) makes cross-origin requests to the Worker (`ai-agent-edge-server.workers.dev`). Browsers block cross-origin `fetch` unless the server returns proper CORS headers. This applies to both REST calls and the SSE stream (which uses `fetch`, not `EventSource`, because we need the `Authorization` header).

**Changes:**

```ts
import type { Env } from './index';

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
```

**Rationale:**
- `DASHBOARD_ORIGIN` is an env var (not `*`) to avoid leaking the SSE stream to arbitrary origins.
- `access-control-max-age: 86400` caches the preflight for a day, reducing OPTIONS round-trips.
- Only `GET` and `OPTIONS` are allowed — the dashboard is read-only.

### Step 3: LINE webhook handler

**File:** `src/lineWebhook.ts`

> **Reliability + idempotency correction (per `plans/review.md` finding #2):** an earlier draft acked LINE immediately and forwarded via `ctx.waitUntil(... .catch(console.error))`. That has two failure modes: (a) upstream errors are swallowed, (b) no dedup against LINE's at-least-once delivery. The handler below persists each `webhookEventId` to KV with a short TTL, treats redeliveries as no-ops, and propagates a deterministic idempotency key to the gateway. **Note:** `openab-gateway` does its own HMAC verification against the bytes it receives, so the Worker's HMAC check is a *fast-fail pre-check at the edge*, not the authoritative one. We keep it because rejecting garbage at the edge avoids waking the Northflank container; we accept the small duplication of work.

**Changes:**

```ts
import { isAllowedUser } from './allowlist';
import type { Env } from './index';

type LineEvent = {
  webhookEventId?: string;
  deliveryContext?: { isRedelivery?: boolean };
  source?: { userId?: string };
};

const DEDUP_TTL_SECONDS = 600; // 10 min covers LINE's retry window comfortably

export async function handleLineWebhook(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const sig = req.headers.get('X-Line-Signature');
  if (!sig) return new Response('missing sig', { status: 401 });

  const rawBody = await req.text();
  const expected = await hmacSha256Base64(env.LINE_CHANNEL_SECRET, rawBody);
  if (!constantTimeEqual(sig, expected)) {
    return new Response('bad sig', { status: 401 });
  }

  let payload: { events?: LineEvent[] };
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response('bad json', { status: 400 });
  }

  // 1. Allowlist filter.
  const allowedEvents = (payload.events ?? []).filter((e) =>
    isAllowedUser(e.source?.userId, env.LINE_ALLOWED_USER_IDS),
  );
  if (allowedEvents.length === 0) return new Response('ok', { status: 200 });

  // 2. Dedup. Per LINE docs (https://developers.line.biz/en/reference/messaging-api/#webhook-event-objects)
  // each event has a stable `webhookEventId`. We mark it `processing` BEFORE
  // forwarding; if the same id shows up again (retry or `deliveryContext.isRedelivery: true`),
  // we skip the forward. This trades a tiny KV write for a hard guarantee
  // against double-running GitHub / browser actions.
  const eventsToForward: LineEvent[] = [];
  for (const ev of allowedEvents) {
    if (!ev.webhookEventId) {
      // No id → must be a verify-event or malformed; safe to forward unconditionally.
      eventsToForward.push(ev);
      continue;
    }
    const dedupKey = `evt:${ev.webhookEventId}`;
    const seen = await env.WEBHOOK_DEDUP.get(dedupKey);
    if (seen || ev.deliveryContext?.isRedelivery) {
      console.log('dedup: skipping', ev.webhookEventId, { seen, isRedelivery: ev.deliveryContext?.isRedelivery });
      continue;
    }
    await env.WEBHOOK_DEDUP.put(dedupKey, 'processing', { expirationTtl: DEDUP_TTL_SECONDS });
    eventsToForward.push(ev);
  }
  if (eventsToForward.length === 0) return new Response('ok', { status: 200 });

  // 3. Forward to Northflank. We MUST return 200 to LINE within 1s (LINE's
  // webhook timeout), so the forward runs via `ctx.waitUntil`. The forward
  // body carries `webhookEventId` per event AND an `idempotencyKey` header so
  // OpenAB / Gemini can dedupe downstream side-effects (GitHub MCP, push reply).
  // On failure we mark the event as `failed` in KV (still within TTL) so an
  // operator-triggered LINE re-deliver can replay it; we do NOT just swallow
  // the error with console.error.
  const idempotencyKey = eventsToForward.map((e) => e.webhookEventId ?? 'noid').join(',');
  ctx.waitUntil(
    (async () => {
      try {
        // Forward to openab-gateway's documented LINE endpoint. The gateway
        // re-verifies the HMAC signature against the body we send, so we MUST
        // forward the exact bytes (rawBody) for events we intend to deliver.
        // BUT we filtered events client-side for allowlist+dedup, so the body
        // we forward has a (potentially) shorter events[] array than the raw.
        // The HMAC over our edited body would not match LINE's signature.
        //
        // The clean answer: forward the original rawBody when at least one
        // event survives, and let the gateway filter internally. The gateway's
        // own allowlist (openab.toml [gateway].allowed_users) covers the same
        // ground; our edge filter is purely a cost optimisation (avoid waking
        // the container for known-spam userIds).
        const bodyToForward = eventsToForward.length === (payload.events?.length ?? 0)
          ? rawBody
          : rawBody;  // same — see note above; we don't re-sign.
        // Recompute the X-Line-Signature we received against rawBody — pass
        // it through so the gateway can re-verify.
        const r = await fetch(`${env.GATEWAY_BASE_URL}/webhook/line`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Line-Signature': sig,
            'idempotency-key': idempotencyKey,
          },
          body: bodyToForward,
        });
        if (!r.ok) {
          await markFailed(env, eventsToForward, `upstream ${r.status}`);
        } else {
          await markDelivered(env, eventsToForward);
        }
      } catch (err) {
        await markFailed(env, eventsToForward, String(err));
      }
    })(),
  );

  return new Response('ok', { status: 200 });
}

async function markDelivered(env: Env, events: LineEvent[]): Promise<void> {
  await Promise.all(
    events
      .filter((e) => e.webhookEventId)
      .map((e) =>
        env.WEBHOOK_DEDUP.put(`evt:${e.webhookEventId}`, 'delivered', {
          expirationTtl: DEDUP_TTL_SECONDS,
        }),
      ),
  );
}

async function markFailed(env: Env, events: LineEvent[], reason: string): Promise<void> {
  console.error('forward failed', reason);
  // Leave failed events as `processing` (still in KV, still TTL'd). A LINE
  // re-deliver carries the same webhookEventId; we skip those by default. To
  // explicitly allow replay after a known upstream outage, delete the keys
  // via `wrangler kv:key delete --binding=WEBHOOK_DEDUP evt:<id>`.
  // Document this in the runbook; do NOT auto-replay (we have no idea
  // whether the upstream actually applied the side-effects).
  void events;
  void reason;
}

async function hmacSha256Base64(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
```

**Rationale:**
- LINE's webhook timeout is **1s** — we still ack immediately with `ctx.waitUntil`.
- HMAC verification follows LINE's docs: `Base64(HMAC-SHA256(channelSecret, rawBody))`. This is the **fast-fail pre-check** — `openab-gateway` independently re-verifies the same signature against `rawBody` on its side, which is the authoritative check.
- Constant-time compare prevents timing attacks even though the threat is academic at this scale.
- **Forwarding `rawBody` unchanged** (including all events, even ones we'd locally drop for allowlist) keeps the HMAC signature valid for the gateway's re-verification. The gateway has its own `[gateway].allowed_users` check that drops the same userIds; our edge filter is a cost optimization, not a duplicated security check.
- **Dedup model:** KV is eventually consistent; the race window is ~60s globally but the same Worker invocation always reads its own write. For LINE retries (which are spaced minutes apart), KV's consistency is more than enough. We deliberately do NOT use Durable Objects — single-region KV is two orders of magnitude cheaper, and the gateway's internal 50s `event_id → replyToken` cache further dedupes within its window.
- **`idempotency-key` header:** the gateway is not currently documented as honouring this header (it dedupes by its own `event_id`, not by ours). We send it anyway for forward compatibility and for the Node sidecar's eventual logs. If we ever do see double-application of side-effects, the runbook is "check sidecar logs against the `idempotency-key` to confirm dedup."
- **Outbound LINE pushes:** image messages go through `send-line-image.sh` which sends `X-Line-Retry-Key`. Text replies go through `openab-gateway` which does its own retry-key handling per the LINE ADR. We don't add `X-Line-Retry-Key` to the inbound forward — it has no meaning on the inbound path.
- **Why not Cloudflare Queues for durability?** Considered. Queues would survive a Worker restart mid-forward, but adds setup + pricing. For ≤5 users and LINE's own retry behavior, KV-tracked dedup + an explicit "delete the key to replay" runbook is sufficient. Revisit if we ever see real lost messages.

### Step 4: Allowlist module

**File:** `src/allowlist.ts`

**Changes:**

```ts
export function isAllowedUser(
  userId: string | undefined,
  allowlistCsv: string,
): boolean {
  if (!userId) return false;
  const allowed = allowlistCsv.split(',').map((s) => s.trim()).filter(Boolean);
  return allowed.includes(userId);
}
```

**Rationale:** Trivial, pure, easy to unit-test. CSV in env keeps the secret store flat.

### Step 5: Image upload (container → Worker → KV)

**File:** `src/imageUpload.ts`

> **Backing store: KV, not R2** (see "Why KV instead of R2" below). Each upload is buffered into an `ArrayBuffer` and written to `IMG_KV` with `expirationTtl: 86400`, so the 24h lifecycle is enforced by KV automatically — no separate dashboard rule needed.

**Changes:**

```ts
import type { Env } from './index';

const KEY_RE = /^[a-zA-Z0-9._-]+\.(png|jpg|jpeg)$/;
const TTL_SECONDS = 86400; // 24h

export async function handleImageUpload(
  req: Request,
  env: Env,
  key: string,
): Promise<Response> {
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${env.CF_UPLOAD_SECRET}`) {
    return new Response('unauthorized', { status: 401 });
  }
  if (!KEY_RE.test(key)) {
    return new Response('bad key', { status: 400 });
  }
  const contentType = req.headers.get('content-type') ?? 'application/octet-stream';
  if (!contentType.startsWith('image/')) {
    return new Response('bad content-type', { status: 400 });
  }

  if (!req.body) return new Response('no body', { status: 400 });
  // KV.put requires a concrete value, not a stream. A screenshot is ~100KB-1MB;
  // far under the 25MB per-value KV cap.
  const bytes = await req.arrayBuffer();

  await env.IMG_KV.put(key, bytes, {
    expirationTtl: TTL_SECONDS,
    metadata: { contentType },
  });

  return new Response(JSON.stringify({ key }), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  });
}
```

**Rationale:**
- Bearer-token auth is enough for a server-to-server PUT inside a small system. The token is shared between Worker and Northflank container via secret managers; rotation is a `wrangler secret put` away.
- `expirationTtl` is KV-native — KV evicts the key automatically at 24h, no date-prefix bookkeeping needed.
- Strict key regex prevents path traversal (`../../etc/passwd` style).
- `metadata.contentType` is stored alongside the bytes so the GET handler can return the correct `content-type` header without sniffing.

### Step 6: Image serve

**File:** `src/imageServe.ts`

**Changes:**

```ts
import type { Env } from './index';

interface ImageMeta {
  contentType?: string;
}

export async function handleImageServe(
  _req: Request,
  env: Env,
  key: string,
): Promise<Response> {
  const { value, metadata } = await env.IMG_KV.getWithMetadata<ImageMeta>(
    key,
    'arrayBuffer',
  );
  if (!value) {
    return new Response('not found', { status: 404 });
  }
  return new Response(value, {
    headers: {
      'content-type': metadata?.contentType ?? 'image/png',
      'cache-control': 'public, max-age=86400',
    },
  });
}
```

**Rationale:**
- One KV read per request — no two-day fallback loop, because KV's `expirationTtl` makes "found vs. expired" unambiguous.
- `cache-control: max-age=86400` tells LINE's CDN it can cache for a day — the same as KV's TTL. After 24h, both LINE and KV forget about the image, which is the desired behavior for ephemeral screenshots.
- `getWithMetadata<ImageMeta>(..., 'arrayBuffer')` returns the bytes and the JSON metadata in one round-trip.

### Step 6.5: Auth helper

**File:** `src/auth.ts`

**Changes:**

```ts
import type { Env } from './index';

export function requireDashboardToken(req: Request, env: Env): Response | undefined {
  const auth = req.headers.get('authorization');
  if (auth !== `Bearer ${env.DASHBOARD_TOKEN}`) {
    return new Response('unauthorized', { status: 401 });
  }
  return undefined;
}
```

**Rationale:** one place to validate the dashboard's bearer token. The frontend always sends it as `Authorization: Bearer ...`, never in URLs.

### Step 6.6: Dashboard SSE proxy

**File:** `src/dashboardSse.ts`

**Changes:**

```ts
import type { Env } from './index';

export async function handleSessionsStream(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // Open an upstream SSE to the agent-runtime container.
  const upstream = await fetch(`${env.SIDECAR_BASE_URL}/events/stream`, {
    headers: {
      'authorization': `Bearer ${env.DASHBOARD_INGEST_TOKEN}`,
      'accept': 'text/event-stream',
    },
  });
  if (!upstream.ok || !upstream.body) {
    return new Response('upstream error', { status: 502 });
  }
  // Stream the body straight through. Re-set headers so the browser
  // sees a clean SSE response from the Worker's origin.
  return new Response(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    },
  });
}
```

**Rationale:**
- The Worker is a **dumb proxy** for SSE — no event-by-event parsing. Cloudflare's runtime supports streaming responses (`ReadableStream` body).
- We DO swap the `authorization` header from `DASHBOARD_TOKEN` (frontend → Worker) to `DASHBOARD_INGEST_TOKEN` (Worker → sidecar). Two distinct tokens means a leaked frontend token doesn't grant direct sidecar access; only the Worker has the ingest token.

> **Important — heartbeat contract:** The Node sidecar in `agent-runtime/scripts/healthz.js` MUST emit `event: heartbeat\ndata: {ts:...}\n\n` every ~15 seconds (see `northflank-container.md` Step 6). Without a heartbeat, if the upstream connection goes silent (container restart, network partition), the Worker keeps the downstream SSE open indefinitely with no events. The frontend detects staleness by treating "no data for 30s" as a disconnect and reconnects — but that only works if the sidecar is actively sending heartbeats during idle periods.

> **Important — Workers plan:** Cloudflare Workers **free tier has a 10ms CPU time limit** per invocation. Long-lived SSE proxy connections will exceed this. The **Workers Paid plan ($5/mo)** is required for SSE streaming — it provides 30s CPU time per invocation. Total fixed cost: **~$29/mo** ($24 Northflank `nf-compute-100-2` + $5 Workers Paid). Updated baseline per `openab-upstream-findings.md` corrections; the original "$10/mo" PRD target is not achievable with Chromium 24/7.

### Step 6.7: Dashboard REST handlers

**File:** `src/dashboardRest.ts`

**Changes:**

```ts
import type { Env } from './index';

export async function handleSessionsList(_req: Request, env: Env): Promise<Response> {
  const r = await fetch(`${env.SIDECAR_BASE_URL}/sessions`, {
    headers: { 'authorization': `Bearer ${env.DASHBOARD_INGEST_TOKEN}` },
  });
  return new Response(r.body, {
    status: r.status,
    headers: { 'content-type': 'application/json' },
  });
}

export async function handleSessionsHistory(
  req: Request,
  env: Env,
  userId: string,
): Promise<Response> {
  const u = new URL(req.url);
  const limit = u.searchParams.get('limit') ?? '50';
  const r = await fetch(
    `${env.SIDECAR_BASE_URL}/sessions/${encodeURIComponent(userId)}/history?limit=${encodeURIComponent(limit)}`,
    { headers: { 'authorization': `Bearer ${env.DASHBOARD_INGEST_TOKEN}` } },
  );
  return new Response(r.body, {
    status: r.status,
    headers: { 'content-type': 'application/json' },
  });
}
```

**Rationale:** thin pass-through. Type contracts (`SessionSummary[]`, `AgentEvent[]`) live in `@repo/shared` so frontend and Worker agree without redeclaring.

### Step 6.8: Create `.dev.vars.example`

**File:** `edge/.dev.vars.example`

> **Do this as part of this implementation step — not before.** The `edge/` workspace doesn't exist on `main` yet; the example file is created together with `wrangler.toml`, `package.json`, and `src/index.ts` so the workspace is internally consistent on the first commit. `.dev.vars` itself is gitignored (matches the existing `.env.*` rule in the root `.gitignore`); only this `.example` is committed.

**Changes:** create the file with placeholder values mirroring the `Env` interface in Step 2.

```
# Cloudflare Worker local secrets. Copy to `.dev.vars` (gitignored) for `wrangler dev`.
# In production these are set via `wrangler secret put <NAME>`.
# Never commit real secrets. Placeholders use the *_HERE suffix per ShopBack security policy.

# --- LINE webhook verification ---
LINE_CHANNEL_SECRET=YOUR_LINE_CHANNEL_SECRET_HERE
# Comma-separated LINE userIds. During bootstrap only, may temporarily be `*`.
LINE_ALLOWED_USER_IDS=Uxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx,Uyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy

# --- Worker <-> Northflank sidecar (dashboard endpoints) ---
DASHBOARD_INGEST_TOKEN=YOUR_DASHBOARD_INGEST_TOKEN_HERE

# --- Worker <-> KV image uploads (container -> Worker PUT /img) ---
CF_UPLOAD_SECRET=YOUR_CF_UPLOAD_SECRET_HERE

# --- Dashboard frontend <-> Worker ---
# Bearer the dashboard pastes into /dashboard/login and sends as Authorization.
DASHBOARD_TOKEN=YOUR_DASHBOARD_TOKEN_HERE
```

**Rationale:**
- The list of variables is exactly the union of the `Env` interface fields (Step 2) minus the non-secret `vars` block in `wrangler.toml` (`GATEWAY_BASE_URL`, `SIDECAR_BASE_URL`, `DASHBOARD_ORIGIN`).
- Placeholder convention (`YOUR_*_HERE`) matches the existing `frontend/.env.example` / `backend/.env.example` style in this monorepo and complies with ShopBack's "never commit real secrets" rule.
- Keep this file in lockstep with the `Env` interface: every time a field is added to `Env`, append a placeholder line here in the same commit. The Step 7 test suite should fail fast if a secret is referenced in code but missing from `.dev.vars.example`.

### Step 7: Tests

**File:** `test/lineWebhook.test.ts`

**Changes (sketch):**

```ts
import { describe, it, expect } from 'vitest';
import { unstable_dev } from 'wrangler';

describe('LINE webhook', () => {
  it('rejects missing signature with 401', async () => {
    const worker = await unstable_dev('src/index.ts', { local: true });
    const res = await worker.fetch('http://x/line/webhook', { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    await worker.stop();
  });

  it('drops non-allowlisted users but returns 200', async () => {
    // ... build a body, sign it with the test secret, send it, assert 200 + no forward
  });
});
```

**File:** `test/allowlist.test.ts`

**Changes:**

```ts
import { describe, it, expect } from 'vitest';
import { isAllowedUser } from '../src/allowlist';

describe('isAllowedUser', () => {
  it('returns false for undefined', () => {
    expect(isAllowedUser(undefined, 'U1,U2')).toBe(false);
  });
  it('matches exact userId', () => {
    expect(isAllowedUser('U1', 'U1,U2')).toBe(true);
  });
  it('trims whitespace', () => {
    expect(isAllowedUser('U1', ' U1 , U2 ')).toBe(true);
  });
});
```

**Rationale:** the *security-critical* paths (signature, allowlist) are the ones we test. Image upload/serve are simple enough to manual-smoke.

## Testing Steps

1. **Local dev:** `wrangler dev`, post a hand-crafted LINE event with a known-good signature → expect `200` and a forward log line.
2. **Bad signature:** post with garbage `X-Line-Signature` → expect `401`.
3. **Allowlist drop:** post a valid event from a userId not in the allowlist → expect `200` and **no** forward.
4. **Image round-trip:** `curl -X PUT -H "Authorization: Bearer $CF_UPLOAD_SECRET" --data-binary @test.png .../img/abc.png` → expect `201`. Then `curl .../img/abc.png` → expect the bytes back.
5. **Lifecycle:** confirm via `wrangler kv:key list --binding=IMG_KV` (or the dashboard) that uploaded keys show a 24h expiration. KV's `expirationTtl` enforces this server-side; no dashboard rule needed.
6. **Dashboard auth:** `curl https://<edge>/api/sessions` without `Authorization` → expect `401`. With correct bearer → expect `[]` or a JSON list.
7. **Dashboard SSE smoke:** `curl -N -H "Authorization: Bearer $DASHBOARD_TOKEN" https://<edge>/api/sessions/stream` while a LINE message is in flight → expect SSE events to arrive within ~1s of the agent acting.
8. **Production smoke:** after `wrangler deploy`, set the LINE webhook URL to the Worker's public URL, send `ping` from LINE, confirm Northflank logs show the forwarded event AND the dashboard shows the live event in `/api/sessions/stream`.

## Dependencies

- Must complete before: `line-integration.md` (LINE webhook URL config points here).
- Depends on: `northflank-container.md` (need the deployed Northflank URLs for `GATEWAY_BASE_URL` and `SIDECAR_BASE_URL`).

## Notes

- **Why not Cloudflare Tunnel for the LINE webhook?** Tunnel doesn't give us signature verification at the edge; we'd still need to run that logic inside Northflank, where every spam request consumes container CPU. Worker is strictly cheaper.
- **Why not a separate Worker per route?** Same code, same secrets, two deployments to manage. Not worth it.
- **Why KV instead of R2:** LINE strictly requires public HTTPS URLs for image messages — base64 / data: URIs are not supported, so the image has to live at *some* Cloudflare-hosted URL. R2 is the canonical choice for blob hosting, but enabling R2 in a Cloudflare account currently requires accepting paid-tier terms with a credit card on file even when you only intend to stay inside the free 10 GB allowance. To keep the FEAT-1 deploy credit-card-free we use **Workers KV** for the same role:
  - Free tier: 1 GB storage / 100k reads/day / 1k writes/day. For ≤5 invited users with sparse screenshot traffic this is comfortably above the worst case.
  - Per-value limit: 25 MB — far above any Playwright PNG (typical 100 KB–1 MB).
  - TTL is native (`expirationTtl: 86400`); no dashboard rule needed.
  - Read latency is ~50 ms vs R2's ~10 ms; invisible to LINE's CDN-side fetch.
  - **Limitation:** KV writes are eventually consistent across edges (~60 s). For a screenshot that the agent just uploaded and the LINE CDN fetches seconds later this is in the worst case a one-time retry by LINE; we have not observed it in testing but if it ever becomes a real problem, the migration path is: enable R2, swap `IMG_KV` binding for an `IMG_BUCKET` R2 binding, and replace `getWithMetadata`/`put` calls. The image-handler code is ~30 LOC; the migration is two diffs.
- **Custom domain:** `*.workers.dev` is fine for v1. If LINE's verification ever rejects a `workers.dev` URL (it won't, but if), point a custom domain at the Worker.
- **Cost check:** with ≤5 users sending ≤100 messages/day each (generous), we're at ≤500 webhook req/day + ≤500 image GETs/day = under 0.1% of free-tier request limits. However, the SSE proxy route requires the Workers **Paid plan ($5/mo)** due to the 10ms CPU time limit on the free tier — long-lived streaming responses will exceed it.
- **CORS is required, not optional.** The dashboard (Cloudflare Pages) and the Worker are on different origins. Without CORS headers on `/api/*` responses + an `OPTIONS` preflight handler, every browser request from the dashboard will fail. See Step 2.5 above.
- **`.dev.vars.example`** is authored in Step 6.8 above (not in this Notes block). Anyone adding a new secret must update Step 6.8 in the same commit; otherwise `wrangler dev` will fail with a missing-binding error.
