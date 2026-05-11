# Implementation Plan: Dashboard UI (v1.5)

## Overview

Build the agent monitoring dashboard inside the existing `frontend/` (Next.js 15) workspace. **Deploy target: Cloudflare Pages** (static export). No SSR, no Vercel.

Three views:

1. **`/dashboard`** — live event feed across all active LINE sessions. New events appear at the top in real time via `EventSource`.
2. **`/dashboard/sessions/[userId]`** — drill-down timeline for one LINE userId: chronological `message_in → tool_call → tool_result → message_out` with timestamps and tool durations.
3. **`/dashboard/login`** — one-field form (paste bearer token), stored in `localStorage`, used as `Authorization: Bearer <token>` for every Worker call.

The dashboard is **read-only in v1.5**. No "kill session" or "send manual reply" — those are v2.

## Files to Create / Modify

```
frontend/
├── next.config.js                                  # MODIFY: output: 'export', images.unoptimized
├── package.json                                    # MODIFY: add "pages-deploy" script
├── src/
│   ├── app/
│   │   ├── dashboard/
│   │   │   ├── page.tsx                            # NEW — live feed (route: /dashboard)
│   │   │   ├── sessions/[userId]/page.tsx          # NEW — per-user timeline
│   │   │   ├── login/page.tsx                      # NEW — paste-token form
│   │   │   └── layout.tsx                          # NEW — auth guard, top nav
│   │   └── ... (existing)
│   ├── components/dashboard/
│   │   ├── EventStream.tsx                         # NEW — EventSource hook + UI
│   │   ├── EventRow.tsx                            # NEW — single event renderer
│   │   ├── SessionList.tsx                         # NEW — left sidebar of active users
│   │   └── Timeline.tsx                            # NEW — chronological view
│   ├── hooks/
│   │   ├── useDashboardToken.ts                    # NEW — localStorage gate
│   │   ├── useEventStream.ts                       # NEW — EventSource lifecycle
│   │   └── useSessions.ts                          # NEW — REST polling fallback
│   └── lib/
│       └── apiClient.ts                            # NEW — fetch wrapper with bearer
shared/
└── src/types/agent-events.ts                       # NEW — AgentEvent, SessionSummary
```

## Step-by-Step Implementation

### Step 1: Add shared types

**File:** `shared/src/types/agent-events.ts`

**Changes:** create the file with the union types from PRD section "Shared types (NEW, v1.5)". Re-export from `shared/src/index.ts`.

**Rationale:** the Worker (`edge/`) and the frontend both need to know the shape of `AgentEvent`. `@repo/shared` is the natural home.

### Step 2: Configure Next.js for static export

**File:** `frontend/next.config.js` (or `.ts`)

**Changes:**

```js
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  images: { unoptimized: true },        // next/image needs an image optimizer (Vercel-only); turn off
  trailingSlash: true,                   // safer default for Pages' static routing
};
module.exports = nextConfig;
```

**Rationale:**
- `output: 'export'` produces a fully-static `out/` directory at `next build`.
- `images.unoptimized: true` is required: Cloudflare Pages doesn't run Vercel's image optimizer.
- `trailingSlash: true` makes `/dashboard/sessions/abc/` resolve to `dashboard/sessions/abc/index.html`, which is how Pages static routing prefers it.

> **Important — dynamic route `[userId]` with static export:** Next.js `output: 'export'` requires dynamic routes to either provide `generateStaticParams` or be handled as client-side-only routes. Since LINE userIds are not known at build time, the `[userId]` segment cannot be pre-rendered. Two approaches:
>
> **Approach A (recommended): Use a catch-all route with client-side param parsing.**
> Replace `dashboard/sessions/[userId]/page.tsx` with `dashboard/sessions/page.tsx` and read the userId from a query parameter: `/dashboard/sessions?user=U123`. This avoids the static export limitation entirely.
>
> **Approach B: Use optional catch-all `[[...slug]]`.**
> Create `dashboard/sessions/[[...slug]]/page.tsx` with an empty `generateStaticParams` that returns `[]`. The page reads `params.slug[0]` client-side. This works but is less intuitive.
>
> **Decision: Approach A** — simpler, no build-time hacks. The SessionList component links to `/dashboard/sessions?user=<userId>` instead of `/dashboard/sessions/<userId>`.

### Step 3: Add the deploy script

**File:** `frontend/package.json`

**Changes (add):**

```json
{
  "scripts": {
    "build": "next build",
    "pages-deploy": "next build && wrangler pages deploy out --project-name=openab-dashboard --branch=main"
  },
  "devDependencies": {
    "wrangler": "^3.78.0"
  }
}
```

Also add to `turbo.json`:

```json
{
  "tasks": {
    "frontend#pages-deploy": {
      "dependsOn": ["frontend#build", "shared#build"]
    }
  }
}
```

**Rationale:** keeps deploy a one-liner (`turbo run frontend#pages-deploy`). Wrangler is already a project-level dep for the `edge/` workspace; we just hoist its CLI usage.

### Step 4: Auth gate + token storage

**File:** `frontend/src/hooks/useDashboardToken.ts`

**Changes:**

```ts
'use client';
import { useEffect, useState } from 'react';

const KEY = 'openab.dashboard.token';

export function useDashboardToken() {
  const [token, setTokenState] = useState<string | null>(null);
  useEffect(() => {
    setTokenState(localStorage.getItem(KEY));
  }, []);
  const setToken = (t: string) => {
    localStorage.setItem(KEY, t);
    setTokenState(t);
  };
  const clear = () => {
    localStorage.removeItem(KEY);
    setTokenState(null);
  };
  return { token, setToken, clear };
}
```

**File:** `frontend/src/app/dashboard/layout.tsx`

**Changes:** wrap children, redirect to `/dashboard/login` if `token === null`. Render a top nav with a "Sign out" button.

**File:** `frontend/src/app/dashboard/login/page.tsx`

**Changes:** a simple controlled `<input type="password">` and a "Save" button. On save, call `setToken(value)` and `router.push('/dashboard')`.

**Rationale:**
- `localStorage` is acceptable because the dashboard is single-user and the token is rotatable. No httpOnly cookies needed (no SSR).
- We deliberately avoid keeping the token in a URL fragment or query string — both leak via Referer headers and browser history.

### Step 5: API client with bearer

**File:** `frontend/src/lib/apiClient.ts`

**Changes:**

```ts
const WORKER_BASE = process.env.NEXT_PUBLIC_WORKER_URL ?? '';

function authHeader(token: string): HeadersInit {
  return { 'authorization': `Bearer ${token}` };
}

export async function fetchSessions(token: string) {
  const r = await fetch(`${WORKER_BASE}/api/sessions`, { headers: authHeader(token) });
  if (!r.ok) throw new Error(`sessions ${r.status}`);
  return r.json();
}

export async function fetchHistory(token: string, userId: string, limit = 50) {
  const r = await fetch(
    `${WORKER_BASE}/api/sessions/${encodeURIComponent(userId)}/history?limit=${limit}`,
    { headers: authHeader(token) },
  );
  if (!r.ok) throw new Error(`history ${r.status}`);
  return r.json();
}

export function streamUrl(): string {
  return `${WORKER_BASE}/api/sessions/stream`;
}
```

**Note on `EventSource` + bearer:** The browser `EventSource` API does **not** support custom headers. Two ways to send the token:

- **(A) Query param:** append `?token=...`. Worker accepts both `Authorization: Bearer` and `?token=`. Risk: token leaks via Referer headers and CF logs.
- **(B) Polyfill:** use a library (e.g., `eventsource-parser` + `fetch` with `ReadableStream`) instead of `EventSource`. Lets us send `Authorization: Bearer ...` natively.

**Decision: (B).** Implement a tiny SSE-over-fetch helper in `useEventStream.ts`. Token never appears in URLs.

**Rationale:** since this is a security-sensitive read-only dashboard, the small upfront cost of writing a fetch-based SSE consumer is worth not leaking tokens. ~30 LOC.

### Step 6: SSE-over-fetch hook

**File:** `frontend/src/hooks/useEventStream.ts`

**Changes:**

```ts
'use client';
import { useEffect, useRef, useState, useCallback } from 'react';
import type { AgentEvent } from '@repo/shared';
import { streamUrl } from '@/lib/apiClient';

const HEARTBEAT_TIMEOUT_MS = 30_000; // If no data for 30s, assume connection is dead

export function useEventStream(token: string | null, max = 200) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!token) return;
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    (async () => {
      while (!ctrl.signal.aborted) {
        try {
          const r = await fetch(streamUrl(), {
            headers: { 'authorization': `Bearer ${token}`, 'accept': 'text/event-stream' },
            signal: ctrl.signal,
          });
          if (!r.ok || !r.body) throw new Error(`stream ${r.status}`);
          setConnected(true);

          const reader = r.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          let lastDataAt = Date.now();

          // Heartbeat staleness detector: if the server sends heartbeats every
          // 15s but we haven't received ANY data (heartbeat or event) for 30s,
          // the connection is silently dead. Abort and reconnect.
          const heartbeatCheck = setInterval(() => {
            if (Date.now() - lastDataAt > HEARTBEAT_TIMEOUT_MS) {
              clearInterval(heartbeatCheck);
              reader.cancel();
            }
          }, 5_000);

          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              lastDataAt = Date.now(); // any data resets the staleness timer
              buf += dec.decode(value, { stream: true });
              // Split on blank-line SSE frame separator.
              let sep;
              while ((sep = buf.indexOf('\n\n')) !== -1) {
                const frame = buf.slice(0, sep);
                buf = buf.slice(sep + 2);
                // Skip heartbeat events (they're just keep-alives)
                const eventLine = frame.split('\n').find((l) => l.startsWith('event:'));
                if (eventLine && eventLine.trim() === 'event: heartbeat') continue;

                const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
                if (!dataLine) continue;
                try {
                  const ev: AgentEvent = JSON.parse(dataLine.slice(5).trim());
                  setEvents((prev) => [ev, ...prev].slice(0, max));
                } catch { /* skip malformed */ }
              }
            }
          } finally {
            clearInterval(heartbeatCheck);
          }
        } catch (err) {
          setConnected(false);
          if (ctrl.signal.aborted) return;
          // Reconnect with simple backoff.
          await new Promise((res) => setTimeout(res, 2000));
        }
      }
    })();

    return () => ctrl.abort();
  }, [token, max]);

  return { events, connected };
}
```

**Rationale:**
- Auto-reconnect on disconnect with a 2-second backoff. Matches "container restart → dashboard recovers" expectation.
- Bounded buffer (`max = 200`) prevents memory growth during long sessions.
- **Heartbeat staleness detection:** The Node sidecar in `agent-runtime/scripts/healthz.js` emits `event: heartbeat` every 15 seconds. If no data (neither heartbeat nor real event) arrives for 30 seconds, the connection is assumed dead and the hook cancels the reader and reconnects. Without this, a silently-dead upstream (e.g. container restart) would leave the browser SSE connection open indefinitely with no events and no error.
- The `connected` state lets the UI show a "Reconnecting..." indicator.

### Step 7: Live feed page

**File:** `frontend/src/app/dashboard/page.tsx`

**Changes (sketch):**

```tsx
'use client';
import { useDashboardToken } from '@/hooks/useDashboardToken';
import { useEventStream } from '@/hooks/useEventStream';
import { EventRow } from '@/components/dashboard/EventRow';

export default function DashboardPage() {
  const { token } = useDashboardToken();
  const { events, connected } = useEventStream(token);

  return (
    <main>
      <h1>Live agent activity</h1>
      {!connected && <p style={{ color: 'orange' }}>Reconnecting to agent...</p>}
      <p>{events.length === 0 && connected ? 'No events yet — send a LINE message to your bot.' : null}</p>
      <ul>
        {events.map((ev, i) => (
          <li key={i}><EventRow event={ev} /></li>
        ))}
      </ul>
    </main>
  );
}
```

`EventRow` switches on `event.type` and renders:
- `message_in` — green chevron, the user text
- `tool_call` — blue chip with the tool name and a JSON-pretty-printed args summary
- `tool_result` — same chip with `ok`/`error` and `durationMs`
- `message_out` — yellow chevron, the reply text (and a thumbnail if `kind === 'image'`)

Each row links the LINE userId to `/dashboard/sessions/[userId]`.

### Step 8: Per-session timeline

**File:** `frontend/src/app/dashboard/sessions/[userId]/page.tsx`

**Changes:** fetch history once via `apiClient.fetchHistory(token, userId)`, render chronologically (oldest → newest), include duration arrows between `tool_call` and `tool_result`. Subscribe to the live stream too and append new events for this user.

**Rationale:** single canonical view of "what happened in this conversation," tying live and recent history together. Critical for debugging weird agent behavior.

### Step 9: Cloudflare Pages project setup

**Steps (one-time, in Cloudflare dashboard):**

1. Create a Pages project named `openab-dashboard`.
2. Connect the Git repo (or use direct upload via `wrangler pages deploy`).
3. Build settings (only used if Git-integrated):
   - **Build command:** `npm install && npm run build --workspace=frontend`
   - **Build output:** `frontend/out`
   - **Root directory:** repository root
4. Environment variables:
   - `NEXT_PUBLIC_WORKER_URL` = `https://openab-line-edge.<account>.workers.dev` (or the custom domain).

**Note:** static export means the only "env" baked in is `NEXT_PUBLIC_WORKER_URL`. The dashboard token is **never** baked into the build — users paste it at runtime.

### Step 10: Custom domain (optional, v1.5)

If desired:
- Add a custom domain to the Pages project (e.g., `dash.example.com`).
- Add a custom domain to the Worker (e.g., `api.example.com`).
- Set `NEXT_PUBLIC_WORKER_URL` accordingly. CORS: the Worker must allow the Pages origin in its responses (currently we don't set CORS at all because the Worker is the only consumer; add `Access-Control-Allow-Origin: <pages domain>` once the Pages domain is known).

## Testing Steps

1. **Static build smoke:** `npm run build --workspace=frontend` → `frontend/out/index.html` exists.
2. **Local dev with the Worker:** `wrangler dev` (Worker) + `next dev` (frontend). Set `NEXT_PUBLIC_WORKER_URL=http://localhost:8787`. Paste a test bearer in `/dashboard/login`. Trigger a fake event. Confirm the row appears.
3. **Auth redirect:** clear `localStorage`, navigate to `/dashboard` → expect redirect to `/dashboard/login`.
4. **Reconnect:** stop the Worker mid-session. Confirm the dashboard shows a "Reconnecting…" indicator and resumes when the Worker is back.
5. **Pages deploy smoke:** `npm run pages-deploy --workspace=frontend` succeeds and the URL serves the latest UI.
6. **End-to-end:** with the full system (LINE → Worker → Northflank) live, send a LINE message and watch the event in production at `https://dash.<domain>/dashboard`.

## Dependencies

- Must complete after: `cloudflare-webhook.md` (Worker exposes `/api/sessions/*` and `/api/sessions/stream`), `northflank-container.md` (events emitter is wired).
- Depends on: `shared/src/types/agent-events.ts` (added in Step 1).

## Notes

- **Why not Cloudflare Pages Functions?** They'd let us add server logic in Pages, but the Worker (`edge/`) already owns that role. Splitting between Pages Functions and the Worker would re-create the very split we just merged.
- **Why not Cloudflare Workers Sites for the frontend too?** Pages is the better-supported, batteries-included path for static + (optional) functions. Workers Sites is legacy.
- **`backend/` (NestJS) status:** untouched. We add no Vercel deploys for FEAT-1. The boilerplate's `backend/vercel.json` is dormant.
- **Future v2 — write actions:** kill session, send manual LINE reply, edit allowlist. These will need new POST/DELETE routes on the Worker (mutating routes) — fine, just add them.
- **Future v2 — auth upgrade:** swap localStorage bearer for GitHub OAuth via Cloudflare Access. Pages integrates cleanly with Access; the Worker can validate Access JWTs.
