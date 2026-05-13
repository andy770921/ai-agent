# Implementation Plan: Northflank Container

## Overview

Build and deploy the **single Docker image** that hosts:
- the **`openab-gateway`** binary (handles LINE webhooks, HMAC verification, hybrid replyToken/Push dispatch),
- the **`openab`** binary (ACP harness; dials the gateway over WebSocket on loopback),
- **Gemini CLI** spawned per session by OpenAB,
- **Chromium + Playwright MCP** + **GitHub MCP** invoked as MCP subprocesses,
- a tiny **Node sidecar** for the dashboard's `/events/stream` + `/sessions` REST.

Three Linux processes inside one container. This is a deliberate v1 deviation from OpenAB's upstream Helm recommendation of "gateway in its own pod" (per `openab-upstream-findings.md` §1) — chosen to keep the Northflank bill at one `nf-compute-100-2` slot. Two pods would double the cost (~$48/mo).

## Files to Create

> **Important — topology revised:** This work lives **inside this monorepo** under a new top-level folder `agent-runtime/`, alongside the existing `frontend/`, `backend/`, and `shared/`. It is **not** an npm workspace (it's a Docker build context with Rust binaries baked in); we explicitly exclude it from `package.json` `workspaces`. The dashboard frontend lives in the existing `frontend/` package — see `dashboard-ui.md`. The boilerplate's `backend/` is unused for FEAT-1.

New folder layout (inside the existing monorepo):

```
agent-runtime/
├── Dockerfile
├── .dockerignore
├── docker-compose.yml          # local dev only
├── config/
│   └── openab.toml             # OpenAB TOML (see openab-config.md)
├── gemini/
│   ├── settings.json           # Gemini CLI settings (see gemini-cli-tools.md Step 3)
│   ├── system.md               # System-prompt override (see gemini-cli-tools.md Step 4)
│   └── policies/
│       └── feat1.toml          # Policy Engine TOML (see gemini-cli-tools.md Step 3b)
├── scripts/
│   ├── entrypoint.sh           # boot order: render-config → gateway → healthz → openab
│   ├── healthz.js              # Node sidecar: /healthz + /events/stream SSE + /sessions REST
│   ├── render-config.sh        # env → TOML interpolation (see openab-config.md Step 3)
│   ├── events-emitter.js       # tails GEMINI_TELEMETRY_OUTFILE → AgentEvent stream
│   ├── post-screenshot.sh      # uploads screenshot to edge worker /img endpoint
│   └── send-line-image.sh      # POSTs LINE Push API image message
├── .northflank/
│   └── service.yaml            # Northflank IaC (or use UI; commit either way)
├── .env.example
└── README.md
```

## Step-by-Step Implementation

### Step 1: Pick base image and build both OpenAB binaries

**File:** `Dockerfile` (top section)

> **Correction (per `openab-upstream-findings.md` §1).** OpenAB ships **two** binaries: `openab` (core) and `openab-gateway` (separate cargo crate at `gateway/` in upstream). We need both, and **upstream does not publish pre-built binaries** — we have to compile from source. Compilation takes ~8 min the first time and is fully cached after.
>
> Both binaries link to the OpenAB workspace's `Cargo.lock`, so they're built in the same `cargo build --release` invocation.

**Changes:**

```dockerfile
# === Stage 1: Build openab + openab-gateway from source ===
FROM rust:1.95-slim-bookworm AS openab-build
RUN apt-get update && apt-get install -y --no-install-recommends \
      pkg-config libssl-dev ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
ARG OPENAB_REF=main
WORKDIR /src
RUN git clone --depth 1 --branch ${OPENAB_REF} https://github.com/openabdev/openab.git .
# One cargo invocation builds the workspace; both binaries end up in target/release.
RUN cargo build --release --bin openab --bin openab-gateway

# === Stage 2: Runtime (mirrors upstream Dockerfile.gemini layout) ===
# We use node:22-bookworm-slim as the base (same as upstream Dockerfile.gemini)
# and install Chromium ourselves via Playwright's CLI — gives us a known-good
# Chromium pinned to the Playwright MCP version, ~150 MB.
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl procps ripgrep tini gettext-base \
      # Chromium runtime deps (the Playwright CLI will install Chromium itself):
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libxkbcommon0 \
      libatspi2.0-0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
      libasound2 libpangocairo-1.0-0 libpango-1.0-0 libcairo2 \
 && rm -rf /var/lib/apt/lists/*
```

**Rationale:**
- **Two binaries from one cargo invocation.** `openab` (the core harness) + `openab-gateway` (the LINE webhook receiver) are separate `[[bin]]` targets in the same Cargo workspace; building both together is one stage, one cache layer.
- **Base = `node:22-bookworm-slim`, not `mcr.microsoft.com/playwright`.** Upstream's `Dockerfile.gemini` uses node:22-slim because Gemini CLI is a Node app; using the same base means we get the exact runtime env that's been tested upstream. We then install Chromium via Playwright (Step 2) — ~150 MB extra, vs ~1.1 GB if we'd used the full Playwright image with Firefox+WebKit we don't need.
- **`OPENAB_REF` is a build arg.** Set it to a specific commit SHA before production rollout so reproducible rebuilds don't accidentally pick up upstream breakage.

### Step 2: Install Gemini CLI, Playwright MCP, GitHub MCP, gh CLI

**File:** `Dockerfile` (continuation)

**Changes:**

```dockerfile
# Gemini CLI — pin to the version OpenAB's Dockerfile.gemini ships with.
# Bump in sync with upstream OPENAB_REF whenever you upgrade.
ARG GEMINI_CLI_VERSION=0.41.2
RUN npm install -g @google/gemini-cli@${GEMINI_CLI_VERSION} --retry 3

# Playwright MCP — pin a release. The Playwright CLI bundled by @playwright/mcp
# will install Chromium into PLAYWRIGHT_BROWSERS_PATH at first run; do it now so
# image builds carry a cached browser instead of paying for the download on each
# container start.
ARG PLAYWRIGHT_MCP_VERSION=0.0.30
RUN npm install -g @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} --retry 3
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx --yes playwright install chromium

# GitHub MCP server (Go binary). The upstream tutorial (bundle/docs/cli/tutorials/mcp-setup.md)
# uses the docker image; we use the bare binary because docker-in-docker on
# Northflank's smaller plans is finicky. Both produce the same protocol.
ARG GH_MCP_VERSION=1.0.4
RUN curl -fsSL "https://github.com/github/github-mcp-server/releases/download/v${GH_MCP_VERSION}/github-mcp-server_Linux_x86_64.tar.gz" \
    | tar -xz -C /tmp \
 && mv /tmp/github-mcp-server /usr/local/bin/github-mcp-server \
 && rm -rf /tmp/github-mcp-server*

# gh CLI — installed via Debian repo, same as OpenAB upstream Dockerfile.gemini.
# Used by the agent for any GitHub action the MCP server doesn't cover.
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*
```

**Rationale:**
- **Three pinned versions** (`GEMINI_CLI_VERSION`, `PLAYWRIGHT_MCP_VERSION`, `GH_MCP_VERSION`) bump independently; never use `latest` in a deployed image.
- **`npx playwright install chromium` at build time** bakes Chromium into the image layer. Without this, the first cold-start pays a ~150 MB download on each new pod (Northflank's `nf-compute-100-2` typically keeps the same pod up for weeks, but redeploys still benefit).
- **GitHub MCP as a bare binary** instead of the docker pattern. The Policy Engine rule for `mcpName = "github"` doesn't care which transport — both speak the same JSON-RPC over stdio.
- **`gh` CLI as a fallback,** but the Policy Engine denies it by default (no `commandPrefix = "gh"` allow rule). It's there so an operator can `docker exec` and use `gh` interactively for debugging without rebuilding the image.

### Step 3: Copy binaries, configs, and scripts

**File:** `Dockerfile` (continuation)

**Changes:**

```dockerfile
# Copy both compiled binaries from the build stage.
COPY --from=openab-build /src/target/release/openab         /usr/local/bin/openab
COPY --from=openab-build /src/target/release/openab-gateway /usr/local/bin/openab-gateway

# OpenAB TOML lives at /etc/openab/openab.toml (read by render-config.sh at boot).
COPY config/openab.toml /etc/openab/openab.toml

# Gemini CLI config — lives in /home/node/.gemini/ because the agent runs as `node`
# (matching upstream Dockerfile.gemini's USER directive).
RUN mkdir -p /home/node/.gemini/policies /home/node/.gemini/sessions /var/log/openab \
 && chown -R node:node /home/node/.gemini /var/log/openab
COPY --chown=node:node gemini/settings.json        /home/node/.gemini/settings.json
COPY --chown=node:node gemini/system.md            /home/node/.gemini/system.md
COPY --chown=node:node gemini/policies/feat1.toml  /home/node/.gemini/policies/feat1.toml

# Scripts run as root for the entrypoint chain; helpers run as `node` since they
# only need network access. We install them all in /usr/local/bin so the Policy
# Engine commandPrefix matches.
COPY scripts/entrypoint.sh        /usr/local/bin/entrypoint.sh
COPY scripts/render-config.sh     /usr/local/bin/render-config.sh
COPY scripts/healthz.js           /usr/local/bin/healthz.js
COPY scripts/events-emitter.js    /usr/local/bin/events-emitter.js
COPY scripts/post-screenshot.sh   /usr/local/bin/post-screenshot.sh
COPY scripts/send-line-image.sh   /usr/local/bin/send-line-image.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
             /usr/local/bin/render-config.sh \
             /usr/local/bin/post-screenshot.sh \
             /usr/local/bin/send-line-image.sh
```

**Rationale:**
- **Two binaries copied separately** so a change to one cargo target invalidates only its layer (in practice they share a build stage, so this is mostly cosmetic).
- **`/home/node/.gemini/` is the right path.** Upstream `Dockerfile.gemini` does `RUN mkdir -p /home/node/.gemini` and `USER node`; we follow the same pattern. The previous draft's `/root/.gemini/` was wrong — Gemini CLI looks in `$HOME/.gemini/`, and `HOME=/home/node` per the upstream image's `ENV` block.
- **`policies/feat1.toml` is User-tier** (per `gemini-cli-tools.md` Step 3b rationale) — `/home/node/.gemini/policies/` rather than `/etc/gemini-cli/policies/`. Avoids the Admin-tier `chmod 755` / UID 0 ownership requirements that would complicate the build.
- **`gettext-base` is no longer in this step** — already installed in Step 1 alongside the other Chromium runtime deps.
- **Two new scripts** that the previous draft did not COPY but other docs referenced: `render-config.sh` (per `openab-config.md` Step 3) and `send-line-image.sh` (per `gemini-cli-tools.md` Step 5b). Missing either causes container boot failure or runtime tool errors.

### Step 4: Declare runtime contract

**File:** `Dockerfile` (bottom)

**Changes:**

```dockerfile
ENV NODE_ENV=production \
    HOME=/home/node \
    OPENAB_CONFIG=/etc/openab/openab.toml \
    OPENAB_SESSION_DIR=/var/lib/openab/sessions \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

# Port 8080 is openab-gateway (LINE webhook + WebSocket for openab core).
# Port 8081 is the Node sidecar (/healthz + /events/stream + /sessions).
# Northflank exposes 8080 publicly; 8081 is internal-only (no port: public: true).
EXPOSE 8080 8081
VOLUME ["/var/lib/openab/sessions"]

# Healthcheck hits the gateway's /health (NOT the sidecar's /healthz) because
# the gateway is the one Northflank's probe ultimately routes traffic to. If
# the gateway is down, the container is broken even if the sidecar still answers.
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8080/health || exit 1

USER node
ENTRYPOINT ["tini", "--", "/usr/local/bin/entrypoint.sh"]
```

**Rationale:**
- **Two ports** because we now have two HTTP-listening processes in the container. Only `:8080` (gateway) is exposed publicly to Northflank's router; `:8081` (sidecar) is referenced internally by the Cloudflare Worker's `/events/stream` proxy, which talks to Northflank over `:8080` and is routed inside the pod to the sidecar via a Northflank port mapping. (Alternative: have the sidecar mount under a path the gateway proxies through; rejected because it couples the gateway to dashboard concerns.)
- **`HEALTHCHECK` hits the gateway**, not the sidecar — the gateway is the critical path. A sidecar-only health probe could pass while LINE webhooks were failing.
- **`tini` is the init.** OpenAB itself spawns Gemini subprocesses, the gateway spawns nothing but the sidecar spawns the events-emitter — `tini` reaps zombies for all three trees without us having to wire signal forwarding.
- **`USER node`** matches upstream `Dockerfile.gemini`. The entrypoint runs as `node`; the `node` user owns `/home/node/.gemini/` and `/var/log/openab/` (set in Step 3) which is enough.

### Step 5: Entrypoint orchestrates three processes

**File:** `scripts/entrypoint.sh`

> **Rewritten (per `openab-upstream-findings.md` §1 and §10.5).** The new boot chain is:
> 1. Validate env (fail-fast on missing).
> 2. Render `openab.toml` via `render-config.sh`.
> 3. Start `openab-gateway` in the background (listens on `:8080`, handles LINE webhooks).
> 4. Start the Node sidecar (listens on `:8081`, serves dashboard endpoints, spawns `events-emitter.js`).
> 5. `exec openab run -c /tmp/openab.toml` — this is the foreground process tied to `tini`.

**Changes:**

```sh
#!/bin/sh
set -eu

# === 1. Validate env (fail-fast on misconfig) ===
# Gateway-only env (consumed by openab-gateway):
: "${LINE_CHANNEL_SECRET:?missing}"
: "${LINE_CHANNEL_ACCESS_TOKEN:?missing}"
# OpenAB-only env (consumed by openab via [agent].env passthrough):
: "${GEMINI_API_KEY:?missing}"
: "${GITHUB_TOKEN:?missing}"
: "${CF_UPLOAD_SECRET:?missing}"             # for /img PUTs
: "${CF_IMG_BASE_URL:?missing}"              # e.g. https://<worker>.workers.dev
# Optional shared secret between OAB core and gateway (recommended):
: "${GATEWAY_TOKEN:?missing}"
# Dashboard sidecar:
: "${DASHBOARD_INGEST_TOKEN:?missing}"       # bearer the edge Worker sends on /events/stream

# === 2. Render OpenAB TOML (env-var expansion + allowlist array conversion) ===
/usr/local/bin/render-config.sh /etc/openab/openab.toml /tmp/openab.toml

# === 3. Start openab-gateway (background, LINE webhook + WebSocket on :8080) ===
GATEWAY_LISTEN="${GATEWAY_LISTEN:-0.0.0.0:8080}" \
LINE_CHANNEL_SECRET="$LINE_CHANNEL_SECRET" \
LINE_CHANNEL_ACCESS_TOKEN="$LINE_CHANNEL_ACCESS_TOKEN" \
GATEWAY_TOKEN="$GATEWAY_TOKEN" \
  openab-gateway &
gw_pid=$!

# === 4. Start the Node sidecar (background, dashboard endpoints on :8081) ===
GEMINI_TELEMETRY_OUTFILE="${GEMINI_TELEMETRY_OUTFILE:-/var/log/openab/gemini-events.jsonl}" \
DASHBOARD_INGEST_TOKEN="$DASHBOARD_INGEST_TOKEN" \
  node /usr/local/bin/healthz.js &
hz_pid=$!

# Trap SIGTERM/SIGINT so we kill the background processes cleanly on shutdown.
trap "kill -TERM $gw_pid $hz_pid 2>/dev/null || true; wait" TERM INT

# === 5. Wait for the gateway to bind, then exec openab core ===
# Without this, openab tries to dial the WebSocket before the gateway is listening.
for i in 1 2 3 4 5 6 7 8 9 10; do
  curl -fsS http://127.0.0.1:8080/health >/dev/null && break
  sleep 0.5
done

exec openab run -c /tmp/openab.toml
```

**Rationale:**
- **Fail-fast env validation up front** beats silent misbehavior at request time. Every var listed here also appears in `.env.example` (Step 8) — if the two drift, the container won't boot, which is the right failure mode.
- **`render-config.sh` is the sole source of `openab.toml` interpolation** — see `openab-config.md` Step 3. The previous draft hand-rolled `sed | envsubst` inside the entrypoint with `${env:VAR}` syntax that doesn't match OpenAB's native `${VAR}` form; that's now fixed.
- **Gateway env scoping:** the gateway only needs LINE secrets and `GATEWAY_TOKEN`. The OpenAB core process doesn't see them (per OpenAB's `env_clear()` plus our `[agent].env` discipline). The `LINE_CHANNEL_ACCESS_TOKEN` reaches the agent **only** via OpenAB's `[agent].env` block — the gateway also reads it for its own outbound push API, that's fine because both processes need it for different reasons.
- **Wait-for-gateway loop** prevents OpenAB from crashing on the first WebSocket dial. The gateway typically binds within ~100 ms; 5 s of retries is plenty.
- **SIGTERM trap** ensures Northflank's stop signal kills the gateway and sidecar cleanly. Without it, `openab` exits via `exec` but the gateway and sidecar linger as zombies — `tini` would reap them eventually but it's noisy in the logs.

### Step 6: Node sidecar — dashboard endpoints + events emitter

> **Rewritten (per `openab-upstream-findings.md` §1, §7, §10.5).** The sidecar no longer reverse-proxies anything to OpenAB (there's no OpenAB HTTP port to proxy to). Its sole role is the dashboard endpoints, all auth-gated by `Authorization: Bearer ${DASHBOARD_INGEST_TOKEN}`.

This Node process owns four routes (all on `:8081`, internal-only):

1. `GET /healthz` → `200 ok` — Northflank's *secondary* health probe (the primary is the gateway's `/health` on :8080).
2. `GET /events/stream` → SSE stream of `AgentEvent` JSON, sourced from `events-emitter.js` (which tails `GEMINI_TELEMETRY_OUTFILE`).
3. `GET /sessions` → JSON list of currently active LINE sessions.
4. `GET /sessions/:userId/history` → recent `AgentEvent`s for one userId.

Routes 2–4 are auth-gated.

**File:** `scripts/healthz.js`

**Changes (sketch — keep it ~120 LOC, pure stdlib):**

```js
const http = require('node:http');
const { spawn } = require('node:child_process');

const PORT = 8081;
const DASHBOARD_TOKEN = process.env.DASHBOARD_INGEST_TOKEN;
if (!DASHBOARD_TOKEN) {
  console.error('DASHBOARD_INGEST_TOKEN missing — sidecar refusing to start');
  process.exit(1);
}

// In-memory ring buffer of recent events, keyed by sessionUserId. Bounded
// to 200 events per user; older events evicted. Survives only while the
// container runs — long-term history lives in the OpenAB persistent volume.
const recent = new Map();         // userId -> AgentEvent[]
const subscribers = new Set();    // SSE res objects

const emitter = spawn('node', ['/usr/local/bin/events-emitter.js'], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
let buf = '';
emitter.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    appendRecent(ev);
    fanOut(ev);
  }
});

function appendRecent(ev) {
  const arr = recent.get(ev.sessionUserId) ?? [];
  arr.push(ev);
  while (arr.length > 200) arr.shift();
  recent.set(ev.sessionUserId, arr);
}
function fanOut(ev) {
  const data = `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
  for (const res of subscribers) {
    try { res.write(data); } catch { subscribers.delete(res); }
  }
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  // /healthz — unauth'd
  if (req.method === 'GET' && url.pathname === '/healthz') {
    return res.writeHead(200).end('ok');
  }
  // All dashboard routes require the ingest bearer.
  if (req.headers.authorization !== `Bearer ${DASHBOARD_TOKEN}`) {
    return res.writeHead(401).end('unauthorized');
  }
  if (req.method === 'GET' && url.pathname === '/events/stream') {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
    });
    subscribers.add(res);
    req.on('close', () => subscribers.delete(res));
    res.write(': hello\n\n');
    return;
  }
  if (req.method === 'GET' && url.pathname === '/sessions') {
    const list = [...recent.entries()].map(([userId, evs]) => {
      const last = evs[evs.length - 1];
      return { userId, lastSeen: last?.ts, msgCount: evs.length, lastEvent: last };
    });
    return res.writeHead(200, { 'content-type': 'application/json' })
              .end(JSON.stringify(list));
  }
  const m = url.pathname.match(/^\/sessions\/([^/]+)\/history$/);
  if (req.method === 'GET' && m) {
    const userId = decodeURIComponent(m[1]);
    const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50', 10), 200);
    const evs = (recent.get(userId) ?? []).slice(-limit);
    return res.writeHead(200, { 'content-type': 'application/json' })
              .end(JSON.stringify(evs));
  }
  res.writeHead(404).end();
}).listen(PORT);

// Heartbeat: emit a keep-alive every 15s so the Worker's SSE proxy + the
// browser don't treat an idle upstream as dead.
setInterval(() => {
  const ping = `event: heartbeat\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`;
  for (const res of subscribers) {
    try { res.write(ping); } catch { subscribers.delete(res); }
  }
}, 15_000);
```

**File:** `scripts/events-emitter.js`

> **Strategy resolved (per `openab-upstream-findings.md` §10.5).** Gemini CLI natively writes JSON telemetry to `$GEMINI_TELEMETRY_OUTFILE` when `GEMINI_TELEMETRY_ENABLED=true GEMINI_TELEMETRY_TARGET=local`. We tail that file and reshape its events into our `AgentEvent` contract. No upstream patch, no wrap script, no log-format guessing — the events are already structured JSON.

**Purpose:** tail `$GEMINI_TELEMETRY_OUTFILE`, reshape each line into the canonical `AgentEvent` shape (see `shared/src/types/agent-events.ts`), and emit one JSON line per event on stdout (where `healthz.js` reads it).

```js
// events-emitter.js — emits one AgentEvent JSON per stdout line.
// Source: Gemini CLI's GEMINI_TELEMETRY_OUTFILE (one JSON line per event).
// The exact shape Gemini writes is documented in
//   node_modules/@google/gemini-cli/bundle/docs/cli/acp-mode.md
// and demonstrated in the upstream integration-tests/acp-telemetry.test.ts.
const fs = require('node:fs');
const readline = require('node:readline');

const SRC = process.env.GEMINI_TELEMETRY_OUTFILE || '/var/log/openab/gemini-events.jsonl';

function tail() {
  // Wait for the file to exist (Gemini creates it on first tool call).
  if (!fs.existsSync(SRC)) {
    setTimeout(tail, 1000);
    return;
  }
  // Start reading from the end so we don't replay history on every restart.
  const start = fs.statSync(SRC).size;
  const stream = fs.createReadStream(SRC, { encoding: 'utf8', start });
  const rl = readline.createInterface({ input: stream });
  rl.on('line', (line) => {
    try {
      const raw = JSON.parse(line);
      const ev = reshape(raw);
      if (ev) process.stdout.write(JSON.stringify(ev) + '\n');
    } catch {
      // skip non-JSON lines silently
    }
  });
  rl.on('close', () => setTimeout(tail, 500)); // file rotated? re-open from EOF
}

// Map a Gemini telemetry event to our AgentEvent shape.
// VERIFY against an actual telemetry sample during Phase 0.3 — the field names
// below are best-effort, derived from the bundled docs. Update once we see real
// output.
function reshape(raw) {
  // sessionUserId: Gemini doesn't natively know the LINE userId, but OpenAB
  // injects a <sender_context> JSON block at the top of every prompt (per
  // openab-upstream-findings.md §6). We extract sender_id from the most recent
  // prompt event we've seen and tag subsequent events with it.
  // This requires keeping a tiny per-session state map — kept in module scope.
  // Implementation detail; document the shape after Phase 0.3.
  const ts = raw.timestamp || raw.ts || new Date().toISOString();
  const session = sessionFor(raw);
  if (!session) return null;
  switch (raw.event || raw.type) {
    case 'prompt_received':
      return { type: 'message_in', sessionUserId: session, ts, text: raw.prompt ?? '' };
    case 'tool_call':
      return { type: 'tool_call', sessionUserId: session, ts,
               tool: raw.tool_name, args: raw.tool_args };
    case 'tool_result':
      return { type: 'tool_result', sessionUserId: session, ts,
               tool: raw.tool_name, durationMs: raw.duration_ms ?? 0,
               ok: raw.ok ?? !raw.error, error: raw.error };
    case 'response_sent':
      return { type: 'message_out', sessionUserId: session, ts,
               text: raw.text ?? '', kind: raw.has_image ? 'image' : 'text',
               imageUrl: raw.image_url };
    default:
      return null;
  }
}

const recentSession = new Map(); // gemini session_id -> LINE userId
function sessionFor(raw) {
  const sid = raw.session_id;
  if (!sid) return undefined;
  // Try to extract sender_id from a prompt event; cache it.
  if (raw.prompt) {
    const m = raw.prompt.match(/"sender_id"\s*:\s*"([^"]+)"/);
    if (m) recentSession.set(sid, m[1]);
  }
  return recentSession.get(sid);
}

tail();
```

**Rationale:**
- **Tailing a JSON file is the simplest possible source of truth.** Gemini's telemetry output is documented (`bundle/docs/cli/acp-mode.md` and the upstream integration test) and changes follow standard semver; we're not parsing log strings.
- **Reshape function is a placeholder until Phase 0.3.** The Gemini telemetry event field names (`event`, `tool_name`, etc.) are derived from the bundled docs but not yet verified against a real run. The TODO in section 11 of `openab-upstream-findings.md` is the gate — first real telemetry sample updates this function.
- **Session-id → LINE userId map** is the only stateful bit. We extract `sender_id` from the OpenAB `<sender_context>` block that appears verbatim in every prompt; subsequent tool_call / tool_result events for the same Gemini `session_id` reuse that userId. This keeps the emitter stateless across crashes (worst case: events without a known userId are dropped until the next prompt arrives, which is acceptable for a dashboard).
- **`process.stdout.write`** instead of `console.log` so we never accidentally introduce a buffering boundary in the JSON-line stream.

> **What if Gemini telemetry doesn't emit `tool_call` events in `--acp` mode?** The fallback is the strategy listed but rejected in §7 of the findings doc (wrap-Gemini-with-a-tee-script). We pre-design `events-emitter.js` for the telemetry path and treat the wrap fallback as a contingency. Phase 0.3 confirms whether the contingency is needed.

### Step 7: Northflank service definition

**File:** `.northflank/service.yaml` (or use the dashboard — commit one or the other)

**Changes:**

```yaml
apiVersion: v1
kind: CombinedService
metadata:
  name: openab-line-agent
spec:
  source:
    type: docker
    dockerfile: Dockerfile
  resources:
    # CORRECTION (per `plans/review.md` finding #4): an earlier draft listed
    # `nf-compute-20` as "1 vCPU / 2 GB RAM, ~$13/mo". Northflank's actual
    # pricing (https://northflank.com/pricing, crawled 2026-05-08):
    #   nf-compute-20    = 0.2 shared vCPU / 512 MB / ~$5.40/mo  ← too small
    #   nf-compute-100-2 = 1 dedicated vCPU / 2 GB    / ~$24/mo  ← what we need
    # 512 MB will OOM the moment Chromium launches; pick the dedicated SKU.
    # Re-benchmark Playwright RSS on this exact plan during Testing Step 6
    # before committing to it long-term.
    plan: nf-compute-100-2       # 1 vCPU / 2 GB RAM, ~$24/mo (see Risks)
    replicas: 1
  ports:
    - port: 8080
      protocol: HTTP
      public: true              # openab-gateway: LINE webhook + WebSocket
    - port: 8081
      protocol: HTTP
      public: true              # Node sidecar: /events/stream + /sessions
                                # (Public because the Worker proxies to it. Auth is
                                # the DASHBOARD_INGEST_TOKEN bearer — see Step 6.)
  volumes:
    - mountPath: /var/lib/openab/sessions
      size: 1                   # 1 GB
  environment:
    # --- LINE (consumed by openab-gateway) ---
    LINE_CHANNEL_SECRET:        ${secret:line-channel-secret}
    LINE_CHANNEL_ACCESS_TOKEN:  ${secret:line-channel-access-token}
    GATEWAY_TOKEN:              ${secret:gateway-token}              # OAB↔gateway WS auth
    # --- OpenAB ([agent].env) ---
    GEMINI_API_KEY:             ${secret:gemini-api-key}
    GITHUB_TOKEN:               ${secret:github-token}
    CF_UPLOAD_SECRET:           ${secret:cf-upload-secret}
    CF_IMG_BASE_URL:            ${secret:cf-img-base-url}
    # --- Dashboard sidecar (auth for the edge Worker) ---
    DASHBOARD_INGEST_TOKEN:     ${secret:dashboard-ingest-token}
```

**Rationale:**
- `nf-compute-100-2` (1 dedicated vCPU / 2 GB) is the minimum that comfortably runs Chromium. The smaller shared-vCPU SKUs (`nf-compute-20` at 0.2 vCPU / 512 MB or `nf-compute-50` at 0.5 vCPU / 1 GB) **will OOM** when Playwright launches; documented in PRD Risks.
- Volume size `1 GB` is generous; ACP transcripts compress well. Revisit if it fills.
- All secrets through Northflank secret manager — never in the image.
- **Cost impact:** ~$24/mo (this container) + ~$5/mo (Cloudflare Workers Paid plan for SSE — see `cloudflare-webhook.md` Step 6.6) = **~$29/mo total fixed**, ahead of any Gemini API usage or KV egress (KV is on free tier; expected to stay there). This is the corrected baseline; the original "$10/mo" target is not achievable with Chromium 24/7.

### Step 8: Create `.env.example`

**File:** `agent-runtime/.env.example`

> **Do this as part of this implementation step — not before.** The `agent-runtime/` directory doesn't exist on `main` yet; the example file is created together with the Dockerfile, scripts, and configs so the workspace is internally consistent on the first commit. The matching real `.env` is gitignored (root `.gitignore` already covers `.env`, `.env.local`, `.env.*.local`); only this `.example` is committed.

**Changes:** create the file enumerating every variable the entrypoint validates (Step 5) plus every variable read by `healthz.js`, `events-emitter.js`, `post-screenshot.sh`, and the spawned Gemini CLI / MCP servers. The list MUST exactly match the `: "${VAR:?missing}"` block in `scripts/entrypoint.sh` — if they diverge, the container fails to boot on Northflank.

```
# agent-runtime container env. Copy to `.env` (gitignored) and fill in real values.
# Mirrored by Northflank's secret manager in prod (see .northflank/service.yaml).
# Never commit real secrets. Placeholders use the *_HERE suffix per ShopBack security policy.

# --- LINE Messaging API (consumed by openab-gateway only) ---
LINE_CHANNEL_SECRET=YOUR_LINE_CHANNEL_SECRET_HERE
LINE_CHANNEL_ACCESS_TOKEN=YOUR_LINE_CHANNEL_ACCESS_TOKEN_HERE
# Shared secret between openab core and openab-gateway WebSocket link.
# Use a long random string; both sides must agree.
GATEWAY_TOKEN=YOUR_OAB_GATEWAY_SHARED_TOKEN_HERE

# --- Gemini (passed into [agent].env) ---
# Google AI Studio API key. Free tier is enough for <=5 users.
GEMINI_API_KEY=YOUR_GEMINI_API_KEY_HERE

# --- GitHub (passed into [agent].env) ---
# Fine-grained PAT: read on all repos + pull_requests:write on a curated list.
# No actions / administration / secrets / workflows scopes.
GITHUB_TOKEN=YOUR_GITHUB_FINE_GRAINED_PAT_HERE

# --- Cloudflare Worker integration (outbound: container -> Worker; passed into [agent].env) ---
# Bearer used by post-screenshot.sh when PUTting images to the Worker /img endpoint.
CF_UPLOAD_SECRET=YOUR_CF_UPLOAD_SECRET_HERE
# Public Worker base URL (no trailing slash).
CF_IMG_BASE_URL=https://ai-agent-edge-server.YOUR_ACCOUNT.workers.dev

# --- Dashboard sidecar (bearer the edge Worker sends on /events/stream + /sessions) ---
DASHBOARD_INGEST_TOKEN=YOUR_DASHBOARD_INGEST_TOKEN_HERE
```

> **`NORTHFLANK_FORWARD_TOKEN` removed.** Earlier drafts of this file listed a `NORTHFLANK_FORWARD_TOKEN` that the Worker sent on `POST /openab/*`. With the architecture corrected per `openab-upstream-findings.md` §1, the Worker now forwards to `POST /webhook/line` on the gateway, and the gateway's HMAC signature check (using `LINE_CHANNEL_SECRET`) is the only authentication needed — there's no extra bearer hop. `cloudflare-webhook.md` Step 3 updates the Worker config accordingly.

**Rationale:**
- Every variable is the **exact name** referenced in `scripts/entrypoint.sh`, `scripts/healthz.js`, and the OpenAB TOML `${VAR}` placeholders. A drift between the example and these consumers is the most common "container won't start" failure mode on Northflank.
- Placeholder convention (`YOUR_*_HERE`) matches the existing `frontend/.env.example` / `backend/.env.example` style in this monorepo and ShopBack's "never commit real secrets" rule.
- Whenever a new env var is added to `entrypoint.sh` or any script, append a placeholder line here in the **same commit** — otherwise the next deploy will fail-fast at boot with `${VAR:?missing}`.

### Step 9: Local development with docker-compose

**File:** `docker-compose.yml`

**Changes:**

```yaml
services:
  agent:
    build: .
    ports:
      - "8080:8080"     # openab-gateway
      - "8081:8081"     # Node sidecar (dashboard endpoints)
    env_file: .env
    volumes:
      - ./local-sessions:/var/lib/openab/sessions
      - ./local-logs:/var/log/openab
```

**Rationale:** lets us iterate on `openab.toml`, `settings.json`, and the policy TOML without rebuilding the image. `.env` is gitignored at the repo root; the committed `.env.example` (Step 8) tells contributors which variables to set. Mounting `./local-logs` makes the Gemini telemetry file readable from the host during development.

## Testing Steps

1. **Build smoke:** `docker build -t openab-line-agent .` succeeds locally without warnings about missing files. Expect ~8 min on a cold cache (Rust build is the slowest stage).
2. **Boot smoke:** `docker compose up` and within ~30s `curl localhost:8080/health` returns `ok` (the gateway's healthcheck) AND `curl localhost:8081/healthz` returns `ok` (the sidecar's).
3. **Cold-cache image size:** image should be ≤ 1.4 GB. The breakdown roughly: `node:22-slim` ~150 MB, Chromium runtime deps ~250 MB, `@playwright/mcp` + Chromium ~250 MB, `@google/gemini-cli` + npm ~200 MB, both OpenAB binaries ~50 MB, gh + github-mcp-server ~50 MB.
4. **Process count:** `docker exec ... ps aux | grep -E '(openab|gemini|node)'` should show three foreground processes once running: `openab`, `openab-gateway`, `node /usr/local/bin/healthz.js` (plus `tini`).
5. **Northflank deploy smoke:** push to Northflank, verify it stays "Running" for 5 minutes, no OOMKills in events.
6. **Volume persistence smoke:** write a sentinel file in `/var/lib/openab/sessions`, redeploy, confirm sentinel still exists.
7. **Memory headroom check:** with one Playwright session active (use a curl-driven manual trigger to the gateway), `docker stats` should show < 1.7 GB peak — leaving 300 MB headroom on the 2 GB plan.
8. **Telemetry sanity:** after step 7, `cat /var/log/openab/gemini-events.jsonl | wc -l` is non-zero, and the sidecar's `/events/stream` (when subscribed) emits derived `AgentEvent`s for the tool calls.

## Dependencies

- Must complete before: `cloudflare-webhook.md` (the Worker needs the Northflank URL for the gateway + sidecar), `line-integration.md` (LINE webhook URL points at the gateway via the Worker), `dashboard-ui.md` (calls the Worker, which calls the sidecar's `/events/stream` and `/sessions`).
- Depends on: `openab-config.md` (provides `config/openab.toml`), `gemini-cli-tools.md` (provides `gemini/settings.json`, `gemini/system.md`, `gemini/policies/feat1.toml`).

## Notes

- **Why two HTTP-listening processes in one container?** Single-pod cost is the constraint. The gateway must listen for LINE webhooks publicly; the sidecar must listen for the Worker's dashboard proxy. Splitting them into separate Northflank services costs ~$24/mo more and offers no security benefit (both already auth via different bearer tokens).
- **Why compile OpenAB from source instead of a binary release?** Upstream `openabdev/openab` does not publish pre-built Linux x86_64 binaries (verified during Phase 0.1). The Rust build adds ~8 min to cold-cache builds but is fully cached for subsequent rebuilds.
- **Cleanup of orphaned Playwright processes:** Gemini CLI spawns Playwright via MCP stdio; when the ACP session ends, OpenAB SIGKILLs the Gemini CLI process tree which closes the MCP server which closes Chromium. Verify in test step 4 + 7.
- **Future:** when the v2 Supabase/Hermes-Agent migration lands, the volume mount goes away and this service becomes stateless — much friendlier to scaling and cheaper plans.
- **`.env.example`** is authored in Step 8 above. Anyone adding a new env var to `entrypoint.sh` or any script MUST update Step 8 in the same commit; otherwise the container will fail-fast at boot with `${VAR:?missing}`.
- **`events-emitter.js` risk note (updated).** Earlier drafts called this the highest-risk integration point because OpenAB's structured output is undocumented. That's been superseded — we now tail Gemini CLI's own `$GEMINI_TELEMETRY_OUTFILE` (documented in `bundle/docs/cli/acp-mode.md`). The risk shifts from "is there an event stream?" (resolved: yes) to "do the field names in our `reshape()` function match real telemetry output?" (gated by Phase 0.3).
