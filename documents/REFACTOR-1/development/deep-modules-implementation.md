# REFACTOR-1 — Deep modules: step-by-step implementation guide

This is the build-order companion to `plans/prd.md`. Each step is a
self-contained slice that leaves the codebase green (tests passing, types
clean) before the next one starts. Don't reorder — later steps consume
ports introduced earlier.

Naming convention: all new files use the same code style as the rest of
the workspace (Prettier, semi, 2-space, single quotes, 100-col).

## Pre-flight

```sh
npm install                            # ensure workspaces resolved
npm run lint                           # baseline must be green
npm run test --workspace=@repo/edge    # baseline must be green
cd frontend && npx jest                # baseline must be green (if any tests)
```

If any of those fail before we start, fix that first.

---

## Step F — `deliver-line-image.sh`

### New file

`agent-runtime/scripts/deliver-line-image.sh`

Contract:

```sh
deliver-line-image.sh <line-userId> <local-image-path>
# exit  0  delivered
# exit  1  upload failed (no LINE push attempted, no orphan to clean)
# exit  2  upload succeeded but LINE push failed (orphan logged to stderr)
# stdout: single JSON line {"ok":true,"imageUrl":"https://…"}  on success
```

Implementation outline:

1. Validate args + env (`CF_UPLOAD_SECRET`, `CF_IMG_BASE_URL`,
   `LINE_CHANNEL_ACCESS_TOKEN`) — fail-fast with exit 1 + stderr message.
2. UUID + extension → `key`; build `ct` (`image/png|jpeg`).
3. PUT to `${CF_IMG_BASE_URL}/img/${key}`. On non-2xx: exit 1.
4. POST to LINE Push with the resulting public URL. On non-200: write
   `orphan key=${key}` to stderr, exit 2.
5. On success: print `{"ok":true,"imageUrl":"…"}` to stdout, exit 0.

### Files to delete

- `agent-runtime/scripts/post-screenshot.sh`
- `agent-runtime/scripts/send-line-image.sh`

### Dockerfile

`agent-runtime/Dockerfile` — replace the two `COPY scripts/post-screenshot.sh`
+ `COPY scripts/send-line-image.sh` lines with a single
`COPY scripts/deliver-line-image.sh`. Update the `RUN chmod +x` list.

### Validation

- `docker build agent-runtime/` succeeds.
- Manually invoke inside container shell:
  `deliver-line-image.sh <test-userId> /tmp/sample.png`.

---

## Step E — Frontend SSE primitives

### New files

- `frontend/src/lib/sse/parseSseStream.ts` — pure async iterator over
  `ReadableStream<Uint8Array>`. Decodes UTF-8, splits on `\n\n`, returns
  `{ event?, data }`. Skips frames without a `data:` line. Accepts an
  optional `AbortSignal` so the caller can cancel the locked reader from
  outside (necessary because `stream.cancel()` doesn't work after
  `getReader()` has locked the stream).
- `frontend/src/lib/sse/reconnectingSseStream.ts` — owns reconnect loop,
  heartbeat watchdog, AbortController, and Bearer auth. Uses
  `parseSseStream` internally and aborts its inner signal when the
  watchdog fires (this is what actually unblocks `reader.read()` —
  flipping a flag does not). Filters out `event: heartbeat` frames
  (they're for the watchdog only). Yields `{ type: 'connected' }` /
  `{ type: 'disconnected' }` status events alongside SSE frames so the
  hook can drive a `connected` indicator.

### Rewrite

`frontend/src/hooks/useEventStream.ts` becomes ~25 lines: spawn an effect
that loops `for await (const frame of reconnectingSseStream({url, token, signal}))`,
JSON-parses `frame.data` to `AgentEvent`, pushes into state with the
rolling-window cap.

### New tests

`frontend/src/lib/sse/parseSseStream.spec.ts`:

- Multi-chunk frame reassembly (split `\n\n` across `push()` calls).
- Heartbeat frames pass through unchanged (the client filters them).
- Malformed frames are skipped.
- Stream ends mid-frame → iterator completes cleanly.

`frontend/src/lib/sse/reconnectingSseStream.spec.ts`:

- Connected → frames → disconnected on normal stream end.
- Heartbeat frames are filtered out of the public output.
- Non-2xx response → disconnected → reconnect.
- Heartbeat timeout (silent stream + short `heartbeatTimeoutMs`, e.g. 60ms)
  → reader cancelled → disconnected → reconnect.
- AbortSignal already aborted → iterator returns immediately, fetch never called.

(Use real timers with short `heartbeatTimeoutMs` values rather than Jest
fake timers; the polling interval inside the watchdog scales with the
configured timeout so a 60ms test runs in well under one second.)

### Validation

```sh
cd frontend && npx jest src/lib/sse
npm run lint --workspace=frontend
npm run build --workspace=frontend
```

Smoke: `npm run dev --workspace=frontend`, open `/dashboard`, confirm SSE
events still flow.

---

## Step C — Edge ports

### New files

- `edge/src/ports/sidecarClient.ts`
  ```ts
  export interface SidecarClient {
    streamEvents(): Promise<Response>;
    listSessions(): Promise<Response>;
    getHistory(userId: string, limit: number): Promise<Response>;
  }
  export function createHttpSidecarClient(baseUrl: string, token: string): SidecarClient;
  ```
  Implementation owns: Bearer header, `safeFetch → 502`, content-type
  passthrough, URL-component encoding.

- `edge/src/ports/imageStore.ts`
  ```ts
  export interface ImageStore {
    put(key: string, body: ArrayBuffer, contentType: string): Promise<void>;
    get(key: string): Promise<{ body: ArrayBuffer; contentType: string } | null>;
  }
  export function createKvImageStore(kv: KVNamespace, ttlSeconds: number): ImageStore;
  ```
  Implementation owns: TTL, metadata shape, `arrayBuffer` decoding on read.

### Rewrites

- `edge/src/dashboardRest.ts` → handlers take `SidecarClient`, become 3-line
  glue. Remove `safeFetch` + `passthrough` (now inside the adapter).
- `edge/src/dashboardSse.ts` → handler takes `SidecarClient`, calls
  `streamEvents()`.
- `edge/src/imageUpload.ts` → handler takes `ImageStore`. Keeps key
  validation + auth header check (these are policy, not storage).
- `edge/src/imageServe.ts` → handler takes `ImageStore`.

### Wiring

`edge/src/index.ts` (still pre-router for now) constructs the ports once
per request from `env` and passes them in. (Cheap because they hold no
state.)

### New tests

`edge/test/imageStore.test.ts` — in-memory KV stand-in: round-trip put/get,
nonexistent key returns null.

`edge/test/sidecarClient.test.ts` — fake `fetch`:
- 200 passes through with correct content-type.
- Network error → 502.
- `getHistory` URL-encodes `userId` and `limit`.

### Validation

```sh
cd edge && npx vitest run
```

---

## Step B — Router primitive

### New file

`edge/src/router.ts`:

```ts
export type RouteHandler<E> = (
  req: Request,
  env: E,
  ctx: ExecutionContext,
  params: Record<string, string>,
) => Promise<Response> | Response;

export interface Route<E> {
  method: string;
  pattern: string;
  handler: RouteHandler<E>;
  cors?: boolean;
}

export interface RouterOptions<E> {
  corsHeaders: (env: E) => Record<string, string>;
  // Path prefixes that should always be CORS-aware (preflight + CORS-wrapped
  // 404) even if no matching route exists. Required to preserve the original
  // index.ts behavior where every /api/* OPTIONS got a 204 preflight.
  corsPathPrefixes?: string[];
}

export function createRouter<E>(
  routes: Route<E>[],
  opts: RouterOptions<E>,
): { fetch(req: Request, env: E, ctx: ExecutionContext): Promise<Response> };
```

Pattern syntax: literal segments + `:name` params. Trailing slash is
significant (matches existing handler URLs). Wildcards not needed.

### Rewrite

`edge/src/index.ts` → registers routes as a table:

```ts
const router = createRouter<Env>(
  [
    { method: 'POST', pattern: '/line/webhook', handler: ... },
    { method: 'PUT',  pattern: '/img/:key', handler: ... },
    { method: 'GET',  pattern: '/img/:key', handler: ... },
    { method: 'GET',  pattern: '/api/sessions/stream', cors: true, handler: dashboardRoute(...) },
    { method: 'GET',  pattern: '/api/sessions',        cors: true, handler: dashboardRoute(...) },
    { method: 'GET',  pattern: '/api/sessions/:userId/history', cors: true, handler: dashboardRoute(...) },
  ],
  { corsHeaders, corsPathPrefixes: ['/api/'] },
);
export default { fetch: router.fetch };
```

The `dashboardRoute(inner)` adapter wraps a handler to short-circuit with
401 when the bearer is missing/wrong. It replaces the inline
`if (authErr) return …` in today's `index.ts`.

`corsPathPrefixes: ['/api/']` matters: the old `index.ts` returned a
preflight 204 (and CORS-wrapped its 404 fallback) for ANY `/api/*` path,
not just the three known routes. Without this option the router would
reject preflight for unknown dashboard paths, breaking the browser's
CORS check at dev time.

### New tests

`edge/test/router.test.ts`:

- `:param` extraction populates `params`.
- OPTIONS on a CORS route returns 204 with CORS headers (no handler invoked).
- OPTIONS on an unknown path UNDER `corsPathPrefixes` also returns 204 with CORS headers.
- CORS headers added to all responses from CORS routes (including 4xx).
- 404 fallback under `corsPathPrefixes` is CORS-wrapped (browser sees the CORS error,
  not a preflight failure).
- Method mismatch → 404 (we don't have 405-bearing endpoints).
- Unknown path → 404.

### Validation

```sh
cd edge && npx vitest run
```

End-to-end smoke against the deployed Worker stays unchanged.

---

## Step A — LINE webhook handler split

### New files

`edge/src/line/signatureVerifier.ts`:

```ts
export interface LineSignatureVerifier {
  verify(rawBody: string, sigHeader: string | null): Promise<boolean>;
}
export function createHmacSignatureVerifier(secret: string): LineSignatureVerifier;
```

Houses `hmacSha256Base64` + `constantTimeEqual` (moved verbatim from
`lineWebhook.ts`).

`edge/src/line/webhookDedupStore.ts`:

```ts
export interface WebhookDedupStore {
  claim(eventId: string): Promise<'claimed' | 'duplicate'>;
  markDelivered(eventIds: string[]): Promise<void>;
}
export function createKvWebhookDedupStore(kv: KVNamespace, ttlSeconds: number): WebhookDedupStore;
```

Encapsulates the `processing → delivered` state string + TTL.

`edge/src/line/gatewayForwarder.ts`:

```ts
export interface GatewayForwarder {
  forward(rawBody: string, sigHeader: string, idempotencyKey: string): Promise<{ ok: boolean; status: number }>;
}
export function createHttpGatewayForwarder(baseUrl: string): GatewayForwarder;
```

`edge/src/line/blockedUserReplier.ts`:

```ts
export interface BlockedUserReplier {
  notifyBlocked(events: LineEvent[]): Promise<void>;
}
export function createLineReplyBlockedUserReplier(accessToken: string): BlockedUserReplier;
```

`edge/src/line/webhookHandler.ts`:

```ts
export function createLineWebhookHandler(deps: {
  verifier: LineSignatureVerifier;
  dedup: WebhookDedupStore;
  forwarder: GatewayForwarder;
  blockedReplier: BlockedUserReplier;
  isUserAllowed: (userId: string | undefined) => boolean;
}): (req: Request, ctx: ExecutionContext) => Promise<Response>;
```

The factory's returned function is what the router invokes.

### Wiring

`edge/src/lineWebhook.ts` becomes a ~24-line wiring shim: it constructs
the four adapters from `env` and returns the handler. This keeps
`index.ts`'s route table readable instead of inlining the builder.

```ts
// edge/src/lineWebhook.ts
export function handleLineWebhook(req: Request, env: Env, ctx: ExecutionContext) {
  const handler = createLineWebhookHandler({
    verifier: createHmacSignatureVerifier(env.LINE_CHANNEL_SECRET),
    dedup: createKvWebhookDedupStore(env.WEBHOOK_DEDUP, DEDUP_TTL_SECONDS),
    forwarder: createHttpGatewayForwarder(env.GATEWAY_BASE_URL),
    blockedReplier: createLineReplyBlockedUserReplier(env.LINE_CHANNEL_ACCESS_TOKEN),
    isUserAllowed: (id) => isAllowedUser(id, env.LINE_ALLOWED_USER_IDS),
  });
  return handler(req, ctx);
}
```

The router registration: `{ method: 'POST', pattern: '/line/webhook',
handler: (req, env, ctx) => handleLineWebhook(req, env, ctx) }`.

### Replaced (not deleted)

`edge/src/lineWebhook.ts` shrinks from 190 lines (god module) to ~24
lines (pure wiring). All behavior moves into the new files under
`edge/src/line/`.

### New tests

`edge/test/line/webhookHandler.test.ts` — uses fake ports:

- Bad sig → 401, no dedup write, no forward.
- Valid + allowed user → forward called once, dedup `markDelivered` called.
- Redelivery (`deliveryContext.isRedelivery=true`) → no forward.
- Same `webhookEventId` arrives twice → second is dropped.
- Blocked user → `blockedReplier.notifyBlocked` called; no forward.
- Mixed allowed + blocked → blocked replier and forwarder both called
  with correct subsets.
- Gateway returns 500 → dedup entry not promoted to `delivered`.

`edge/test/line/signatureVerifier.test.ts` — known-good HMAC vector
(reuse one from upstream LINE docs).

`edge/test/line/webhookDedupStore.test.ts` — in-memory KV: claim returns
`'duplicate'` on the second call; `markDelivered` overwrites.

### Delete

Most of `edge/test/lineWebhook.test.ts` — replaced by the boundary tests
above. Keep only any cases not covered by the new fakes (e.g. raw HTTP
shape regression).

### Validation

```sh
cd edge && npx vitest run
```

---

## Step D — Sidecar `AgentEventBus`

### New directory

`agent-runtime/scripts/lib/`:

- `agentEventBus.js` — `createAgentEventBus({ sinks })`. Publish iterates
  sinks; each sink call is wrapped in `try/catch` with `console.error`.
- `ringBufferSink.js` — `createRingBufferSink({ limit })`. `onEvent` writes;
  exposes `listSessions()` and `getHistory(userId, limit)`.
- `sseFanoutSink.js` — `createSseFanoutSink()`. `onEvent` writes
  `event: <type>\ndata: <json>\n\n` to all subscribers; `subscribe(res)`
  returns unsubscribe fn; `heartbeat()` writes ping frames.
- `langfuseSink.js` — `createLangfuseSink({ langfuse })`. The 60-line
  trace/generation/span lifecycle from today's `sendToLangfuse`.
- `jsonLineDecoder.js` — `createJsonLineDecoder(onLine)`. Cross-chunk
  buffer, blank-line skip, malformed JSON swallowed.

All files use CommonJS (matches the sidecar's existing style).

### Rewrite

`agent-runtime/scripts/healthz.js` becomes the wiring layer:

```js
const ringBuffer = createRingBufferSink({ limit: 200 });
const sseFanout = createSseFanoutSink();
const langfuseSink = langfuse ? createLangfuseSink({ langfuse }) : null;
const bus = createAgentEventBus({
  sinks: [ringBuffer, sseFanout, ...(langfuseSink ? [langfuseSink] : [])],
});

const decoder = createJsonLineDecoder((raw) => {
  try { bus.publish(JSON.parse(raw)); } catch { /* skip */ }
});
emitter.stdout.on('data', (chunk) => decoder.push(chunk.toString('utf8')));

// HTTP routes delegate to ringBuffer.listSessions / getHistory.
// SSE route calls sseFanout.subscribe(res).
// Heartbeat interval calls sseFanout.heartbeat().
```

Target line count after rewrite: ~90 (down from 204).

### New tests

`agent-runtime/scripts/lib/*.test.js` — use Node's built-in test runner
(`node --test`). Each file tests one sink.

Add to `agent-runtime/package.json` (or create one if missing) a `test`
script: `node --test scripts/lib/`. Hook into the root `turbo.json` only
if convenient — otherwise document the local invocation.

Test coverage:

- `agentEventBus.test.js` — sink errors are swallowed; publish reaches all
  sinks even when one throws.
- `ringBufferSink.test.js` — events accrue per `sessionUserId`; eviction
  at `limit`; `listSessions()` shape; `getHistory(userId, n)` returns last
  `n`.
- `sseFanoutSink.test.js` — fake `res` with `.write(s)` recording; subscriber
  whose write throws gets removed; heartbeat writes the ping line.
- `langfuseSink.test.js` — fake langfuse client (`{ trace: jest.fn() … }`
  but in plain functions); assert call sequence for full
  `message_in → tool_call → tool_result → message_out` flow.
- `jsonLineDecoder.test.js` — chunk boundary in the middle of a line;
  multiple lines per chunk; trailing partial line; bad JSON skipped.

### Validation

```sh
cd agent-runtime && node --test scripts/lib/
docker build agent-runtime/                  # still builds
```

Manual smoke in HF Space: run a LINE message, confirm dashboard SSE
receives events and Langfuse trace appears.

---

## Final cleanup

After all six steps:

1. **Sweep stale references** outside the source tree:
   ```sh
   grep -rln "post-screenshot\|send-line-image\|handlePreflight" \
     --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist .
   ```
   Update `CLAUDE.md`, `agent-runtime/README.md`, `agent-runtime/.env.example`,
   `agent-runtime/gemini/policies/feat1.toml`, `agent-runtime/gemini/system.md`
   and `.claude/settings.local.json` if any matches remain.
2. **Add `.dockerignore` entry** for `scripts/lib/*.test.js` so the
   `node --test` files do not ship into the runtime image.
3. **Re-run everything green.**
   ```sh
   npm run lint
   npm run build
   npm run test --workspace=@repo/edge
   cd frontend && npx jest
   cd agent-runtime && node --test scripts/lib/
   ```
4. **Update PRD status checkboxes** in `plans/prd.md`.

## Notes

- Each port lives under a `ports/` or `line/` subfolder to make it
  obvious at a glance that it's an interface boundary, not a leaf util.
- Adapters live next to their port (same file). The factory function
  (`createHttpSidecarClient`, etc.) is the only export besides the
  `interface` declaration.
- Avoid backwards-compat shims: when you delete a file, also delete
  any stale `import` in tests rather than re-exporting a stub.
