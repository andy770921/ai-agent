# REFACTOR-1 — Deepen six shallow / god-modules across the system

## Summary

Six modules in this repo expose nearly as much interface as implementation
("shallow"), or hide too many unrelated concerns behind a single function
("god"). REFACTOR-1 deepens each one into a narrow-interface module hiding
a substantial body of behavior, following Ousterhout's "deep module"
principle. Affected areas: Cloudflare Worker (LINE webhook, routing,
sidecar/KV adapters), HF Spaces Node sidecar (event bus + sinks), Next.js
dashboard (SSE parsing), and the agent's image-delivery shell scripts.

## Motivation

Today, friction shows up in three observable ways:

1. **Reading a single concept requires jumping across many files.** E.g. to
   understand "how a LINE event becomes a forwarded webhook," you must hold
   HMAC verification, KV dedup state, allowlist filtering, gateway
   forwarding, and the blocked-user Push fallback in your head simultaneously
   — all in `edge/src/lineWebhook.ts`.
2. **Modules are untestable in isolation.** `agent-runtime/scripts/healthz.js`
   has zero tests despite owning 200 lines of business logic (Langfuse trace
   lifecycle, SSE fan-out, ring buffer, child IPC). The Langfuse mapping is
   pure logic on `AgentEvent`s — but cannot be tested without spinning up a
   real HTTP server.
3. **The same patterns are re-implemented.** Four edge handlers each
   open-code `Bearer ${env.DASHBOARD_INGEST_TOKEN}` + `safeFetch → 502`
   wrapping + content-type passthrough. The frontend's `useEventStream`
   re-implements SSE protocol parsing inline in a React hook.

Deep modules attack all three by making the public surface much smaller than
the hidden surface, so callers compose primitives instead of re-implementing
them.

## Scope — six candidates

| ID | Cluster                                                       | Deepening                                              |
| -- | ------------------------------------------------------------- | ------------------------------------------------------ |
| A  | `edge/src/lineWebhook.ts`                                     | Split into pipeline of ports + thin orchestrator       |
| B  | `edge/src/index.ts` + per-handler path matching               | Tiny router primitive owning method/path/CORS dispatch |
| C  | `edge/src/{dashboardRest,dashboardSse,imageUpload,imageServe}.ts` | Two ports: `SidecarClient`, `ImageStore`            |
| D  | `agent-runtime/scripts/healthz.js`                            | `AgentEventBus` + pluggable sinks                      |
| E  | `frontend/src/hooks/useEventStream.ts`                        | Pure `parseSseStream` + `createReconnectingSseClient`  |
| F  | `agent-runtime/scripts/{post-screenshot,send-line-image}.sh`  | One `deliver-line-image.sh` with a single status       |

## Common philosophy

For every candidate we apply the same three moves:

1. **Identify the substantial implementation hidden inside.** This is the
   "deep" part — what we're protecting callers from.
2. **Pick a dependency strategy.**
   - In-process (pure) → just merge / inline.
   - Local-substitutable (KV, child process, fake `Response.body`) → keep
     a real but in-memory implementation in tests.
   - Ports & adapters (sidecar HTTP, KV store, LINE Push) → define a port
     interface, inject adapters.
3. **Test at the new boundary.** Delete the old shallow tests once the
   boundary tests exist. Do NOT layer "now I also unit-test the helper."

---

## Candidate A — LINE webhook orchestrator

### Current state

`edge/src/lineWebhook.ts` (190 lines) mixes:

- HMAC SHA-256 + base64 + constant-time compare (lines 23–30, 170–190)
- KV dedup with `processing | delivered` state strings + TTL (71–86,
  146–168)
- Allowlist filter + blocked-user LINE Push fallback (47–63, 120–144)
- Gateway forwarding + idempotency-key + status reconciliation (88–115)

### Proposed interface

A factory that wires four ports:

```ts
// edge/src/line/webhookHandler.ts
export interface LineSignatureVerifier {
  verify(rawBody: string, signatureHeader: string | null): Promise<boolean>;
}
export interface WebhookDedupStore {
  claim(eventId: string): Promise<'claimed' | 'duplicate'>;
  markDelivered(eventIds: string[]): Promise<void>;
}
export interface GatewayForwarder {
  forward(rawBody: string, signatureHeader: string, idempotencyKey: string): Promise<{ ok: boolean; status: number }>;
}
export interface BlockedUserReplier {
  notifyBlocked(events: LineEvent[]): Promise<void>;
}

export function createLineWebhookHandler(deps: {
  verifier: LineSignatureVerifier;
  dedup: WebhookDedupStore;
  forwarder: GatewayForwarder;
  blockedReplier: BlockedUserReplier;
  isUserAllowed: (userId: string | undefined) => boolean;
}): (req: Request, ctx: ExecutionContext) => Promise<Response>;
```

### What it hides

- Hand-rolled crypto helpers (`hmacSha256Base64`, `constantTimeEqual`).
- KV state-machine (`processing` → `delivered`, redelivery skip,
  TTL-based natural expiry).
- Idempotency-key composition from N event IDs.
- Per-event allowlist branching, blocked-user reply throttle.

### Dependency strategy

- **`LineSignatureVerifier`** — in-process pure. Real impl uses Web Crypto;
  test impl returns boolean.
- **`WebhookDedupStore`** — Cloudflare KV. Adapter built around `env.WEBHOOK_DEDUP`;
  test adapter is an in-memory `Map`.
- **`GatewayForwarder`** — true external (HF Spaces). Mock at boundary.
- **`BlockedUserReplier`** — true external (LINE Reply API). Mock at boundary.

### Testing strategy

- Boundary tests (`webhookHandler.test.ts`): given each port as a fake,
  assert correct port calls for: valid event, bad signature, redelivery,
  blocked user, mixed allowed+blocked, gateway failure.
- Keep `allowlist.test.ts` (it tests a pure function used by the wiring).
- Delete the integration-style assertions in the current
  `lineWebhook.test.ts` that overlap with the new boundary tests.

---

## Candidate B — Worker router primitive

### Current state

`edge/src/index.ts` hand-rolls `if (method === ... && path === ...)`
branches plus a one-off regex for `/api/sessions/:userId/history`. CORS is
applied only to `/api/*` via a `withCors` helper. Each new endpoint = more
branches.

### Proposed interface

```ts
// edge/src/router.ts
export type RouteHandler<E> = (
  req: Request,
  env: E,
  ctx: ExecutionContext,
  params: Record<string, string>,
) => Promise<Response> | Response;

export interface Route<E> {
  method: string;
  pattern: string;           // e.g. "/api/sessions/:userId/history"
  handler: RouteHandler<E>;
  cors?: boolean;            // default false
}

export interface RouterOptions<E> {
  corsHeaders: (env: E) => Record<string, string>;
  // Path prefixes that always preflight + CORS-wrap their 404 fallback,
  // even for paths that match no registered route. Preserves the original
  // index.ts behavior where every /api/* OPTIONS returned 204.
  corsPathPrefixes?: string[];
}

export function createRouter<E>(routes: Route<E>[], opts: RouterOptions<E>): {
  fetch(req: Request, env: E, ctx: ExecutionContext): Promise<Response>;
};
```

### What it hides

- Path-pattern matching with `:param` extraction.
- OPTIONS pre-flight handling (auto-generated for any CORS-tagged route
  AND for any path under `corsPathPrefixes`).
- CORS header injection on responses, including the 404 fallback when
  the path falls under a CORS-aware prefix.

### Dependency strategy

In-process — purely how the Worker dispatches.

### Testing strategy

- `router.test.ts` table tests: param extraction, OPTIONS short-circuit,
  CORS injection (incl. CORS-wrapped 404 fallback under `corsPathPrefixes`),
  method mismatch → 404 (we don't surface 405 — there are no shared
  paths across methods), unknown path → 404.
- Existing handler tests stay focused on handler logic.

---

## Candidate C — Sidecar + KV ports

### Current state

Four handlers each open-code outbound concerns:

- `dashboardRest.ts` — Bearer header, content-type passthrough, `safeFetch`
- `dashboardSse.ts` — Bearer header, stream passthrough, `try/catch → 502`
- `imageUpload.ts` — KV `put` with TTL + metadata, key validation
- `imageServe.ts` — KV `getWithMetadata`

### Proposed interfaces

```ts
// edge/src/ports/sidecarClient.ts
export interface SidecarClient {
  streamEvents(): Promise<Response>;
  listSessions(): Promise<Response>;
  getHistory(userId: string, limit: number): Promise<Response>;
}
export function createHttpSidecarClient(baseUrl: string, token: string): SidecarClient;

// edge/src/ports/imageStore.ts
export interface ImageStore {
  put(key: string, body: ArrayBuffer, contentType: string): Promise<void>;
  get(key: string): Promise<{ body: ArrayBuffer; contentType: string } | null>;
}
export function createKvImageStore(kv: KVNamespace, ttlSeconds: number): ImageStore;
```

### What it hides

- Authorization header construction.
- "Catch network error → 502" pattern.
- KV TTL + metadata shape.
- `arrayBuffer` decoding on read.

### Dependency strategy

Ports & Adapters. `SidecarClient` adapter wraps `fetch`; in-memory adapter
for tests. `ImageStore` adapter wraps Cloudflare KV; in-memory adapter for
tests (Miniflare also works).

### Testing strategy

- Add `imageStore.test.ts` with in-memory adapter assertions
  (round-trip, TTL behavior is Miniflare-level).
- Handlers become 3-line glue; remove any duplicated branch logic from
  their tests.

---

## Candidate D — Sidecar `AgentEventBus`

### Current state

`agent-runtime/scripts/healthz.js` (204 lines) tangles five concerns:

- Child-process spawn + JSON-line decoding across chunk boundaries
- In-memory ring buffer (write + query)
- SSE fan-out + heartbeat
- Langfuse trace lifecycle keyed by `AgentEvent.type`
- HTTP server + token auth + routing

### Proposed interface

```js
// agent-runtime/scripts/lib/agentEventBus.js
function createAgentEventBus({ sinks }) {
  return {
    publish(event) { /* fan to sinks, never throws */ },
  };
}

// sinks (each is { onEvent(event) } plus its own query/subscribe API):
createRingBufferSink({ limit })
  -> { onEvent, listSessions(), getHistory(userId, limit) }
createSseFanoutSink()
  -> { onEvent, subscribe(res), heartbeat() }
createLangfuseSink({ langfuse })
  -> { onEvent }

// lib/jsonLineDecoder.js (pure, no I/O)
createJsonLineDecoder(onLine) -> { push(chunk) }
```

`healthz.js` shrinks to: wire sinks, mount HTTP routes that delegate to
sink query APIs, attach SSE subscriber on `GET /events/stream`.

### What it hides

- Heartbeat timer.
- Per-subscriber write failure → auto-deregister.
- Ring-buffer eviction.
- Langfuse trace/generation/span lifecycle (still ~60 lines, but
  encapsulated and testable with a fake `langfuse` object).
- JSON-line buffer reconstruction across child-process stdout chunks.

### Dependency strategy

- `AgentEventBus`, ring buffer, JSON-line decoder → **in-process pure**.
- `SseFanoutSink` → fake `res` object in tests (just needs `.write(str)`).
- `LangfuseSink` → fake `langfuse` factory that records calls.

### Testing strategy

- `agentEventBus.test.js` — publish dispatches to all sinks, sink errors
  don't break the bus.
- `ringBufferSink.test.js` — write/query API; eviction at limit.
- `sseFanoutSink.test.js` — fake `res.write`; auto-deregister on throw.
- `langfuseSink.test.js` — fake langfuse client; assert trace/generation/
  span lifecycle for each `AgentEvent` arm.
- `jsonLineDecoder.test.js` — split chunks, embedded blank lines, bad JSON.

(Sidecar has no test infrastructure today; we add a minimal `node --test`
runner — no new tool, ships with Node 22.)

---

## Candidate E — Frontend SSE client

### Current state

`frontend/src/hooks/useEventStream.ts` (81 lines) bundles:

- Reconnect loop + backoff
- Heartbeat watchdog (30s)
- SSE frame parsing (`\n\n` separator, `event:` / `data:` line discrimination)
- AbortController lifecycle
- React `useState` updates

### Proposed interface

```ts
// frontend/src/lib/sse/parseSseStream.ts
export interface SseFrame { event?: string; data: string }
export interface ParseSseStreamOptions { signal?: AbortSignal }
export function parseSseStream(
  body: ReadableStream<Uint8Array>,
  options?: ParseSseStreamOptions,
): AsyncIterable<SseFrame>;

// frontend/src/lib/sse/reconnectingSseStream.ts
export interface ReconnectingSseStreamOptions {
  url: string;
  token: string;
  heartbeatTimeoutMs?: number;
  reconnectBackoffMs?: number;
  signal: AbortSignal;          // required — owns lifecycle
  fetchImpl?: typeof fetch;     // injectable for tests
}

// Yields connection-status events alongside frames so the hook can
// drive a `connected` UI indicator without a separate channel.
export interface StreamStatusEvent { type: 'connected' | 'disconnected' }
export type StreamYield = SseFrame | StreamStatusEvent;

export function reconnectingSseStream(
  opts: ReconnectingSseStreamOptions,
): AsyncIterable<StreamYield>;
```

The hook becomes ~37 lines: a `for await` over `reconnectingSseStream`
that branches on `'type' in frame` (status) vs `frame.data` (payload).

### What it hides

- SSE framing details (multi-line buffers, blank-line separators).
- Heartbeat-based dead-connection detection — including the non-obvious
  detail that the watchdog must abort the *reader's* signal, since
  `stream.cancel()` no-ops once `getReader()` has locked the body.
- Reconnect timing + backoff.
- AbortController plumbing for both reader cancellation and reconnect-loop
  exit.

### Dependency strategy

- `parseSseStream` — **in-process pure** (operates on any ReadableStream).
- `reconnectingSseStream` — **local-substitutable**: hand it a fake `fetch`
  to return controlled streams in tests.

### Testing strategy

- `parseSseStream.test.ts` — feed Uint8Array fixtures; assert framing
  across split chunks, heartbeat events, malformed frames.
- `reconnectingSseStream.test.ts` — fake `fetch` that returns one
  stream then errors; assert reconnect, heartbeat-timeout cancellation.
- Delete inline parsing assertions from any tests that touch
  `useEventStream` (there are none today, but the new tests close that gap).

---

## Candidate F — Agent's "deliver image to LINE" workflow

### Current state

Three independent hops, no shared contract:

1. Agent runs `post-screenshot.sh <local-path>` → uploads to Worker KV →
   echoes URL.
2. Agent runs `send-line-image.sh <userId> <url>` → POSTs LINE Push.
3. Failures at hop 1 leave orphaned KV entries with no cleanup; the
   agent has no single status indicator.

### Proposed interface

A single script: `deliver-line-image.sh <line-userId> <local-path>`.

```sh
deliver-line-image.sh U123 /tmp/screenshot.png
# stdout: {"ok":true,"imageUrl":"https://.../img/abc.png"}
# exit:    0 if delivered, 1 if upload failed, 2 if push failed
```

Internally: upload → push → emit single JSON status. On push failure, the
script logs the orphaned KV key so an operator can clean up (KV TTL
handles it eventually).

The old two scripts are deleted; Gemini's tool whitelist updates accordingly.

### What it hides

- Two-hop sequencing.
- UUID generation + key construction.
- Extension → content-type mapping.
- HTTP status interpretation.

### Dependency strategy

Two true-external calls (Worker + LINE Push). Boundary surface is the
script's exit code + JSON line.

### Testing strategy

No automated tests — same as before; this is a shell wrapper around two
HTTPS calls. Manual e2e via the existing Phase 0.3 runbook.

---

## Migration plan (ordered)

Order optimizes for shrinking blast radius first and ending with the
largest single change:

1. **F — `deliver-line-image.sh`** — pure additive on `agent-runtime/scripts/`;
   gemini policies update; old scripts deleted last.
2. **E — Frontend SSE primitives** — pure additive on `frontend/src/lib/sse/`;
   `useEventStream` rewrites to consume; no Worker / sidecar changes.
3. **C — Edge ports** — introduce `ports/sidecarClient.ts` +
   `ports/imageStore.ts`; rewrite the four handlers; existing handler tests
   for `lineWebhook`/`allowlist`/`auth` unchanged.
4. **B — Router primitive** — introduce `router.ts`; `index.ts` shrinks to
   a route table; existing handler tests unchanged.
5. **A — LINE webhook handler split** — extract four ports
   (`LineSignatureVerifier`, `WebhookDedupStore`, `GatewayForwarder`,
   `BlockedUserReplier`); rewrite `lineWebhook.ts` as a factory;
   replace integration tests with boundary tests.
6. **D — Sidecar `AgentEventBus`** — extract bus + sinks +
   JSON-line decoder; `healthz.js` shrinks to wiring; add `node --test`
   suites.

After each step the corresponding workspace tests must remain green
(`npm run test --workspace=@repo/edge`, `cd frontend && npx jest`).

## Risks and mitigations

| Risk                                                                | Mitigation                                                                                   |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Webhook split breaks LINE retry semantics                           | Keep dedup state strings (`processing | delivered`) and TTL identical; replay-by-key still works |
| Sidecar refactor breaks Langfuse traces silently                    | New `langfuseSink.test.js` asserts the trace/generation/span call sequence for every event arm |
| Router pattern-match has different semantics than current ad-hoc regex | Port the existing regex into one boundary test; keep behavior bit-exact                      |
| Shell script consolidation breaks Gemini's tool whitelist           | Update `agent-runtime/gemini/policies/feat1.toml` in the same commit                         |
| Frontend SSE rewrite drops heartbeat semantics                      | Boundary test asserts 30s no-data → cancel + reconnect                                       |

## Status

- [x] RFC drafted
- [x] Candidate F implemented (deliver-line-image.sh; old two scripts deleted; Gemini policy + system prompt updated)
- [x] Candidate E implemented (parseSseStream + reconnectingSseStream; 10 jest tests)
- [x] Candidate C implemented (SidecarClient + ImageStore ports; 9 vitest tests)
- [x] Candidate B implemented (router primitive; 8 vitest tests)
- [x] Candidate A implemented (4 LINE ports + handler factory; 15 vitest tests)
- [x] Candidate D implemented (AgentEventBus + 4 sinks; healthz.js 204→109 lines; 22 node --test tests)
- [x] Old shallow tests removed (lineWebhook.test.ts integration suite)
- [x] Post-implementation review fixes applied:
  - Fixed: `reconnectingSseStream` watchdog now cancels the reader via
    AbortSignal (previously flipped a flag that the blocked `read()` never
    saw) + new heartbeat-timeout boundary test
  - Fixed: `router` accepts `corsPathPrefixes` so unknown `/api/*` paths still
    preflight + CORS-wrap 404 (preserves old `index.ts` behavior)
  - Fixed: stale references to deleted scripts removed from `CLAUDE.md`
    and `.claude/settings.local.json`
  - Fixed: `agent-runtime/.dockerignore` now excludes `scripts/lib/*.test.js`
    from the runtime image
  - Fixed: `langfuseSink.test.js` now covers `message_out` with `kind: 'image'`
