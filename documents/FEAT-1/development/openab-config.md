# Implementation Plan: OpenAB Config

## Overview

Author the OpenAB TOML config that wires the Custom Gateway to the Gemini CLI agent. OpenAB exposes its behavior through a single TOML file; we only need to (a) point it at the gateway, (b) describe the Gemini CLI agent command, (c) set session limits.

> **Schema reconciled (per `openab-upstream-findings.md` §2).** OpenAB uses **singular** `[gateway]` and `[agent]` blocks, not `[gateways.line]` / `[agents.gemini]`. Webhook URLs, channel secrets, and access tokens belong to the **separate `openab-gateway` process's env** — they are NOT keys in `openab.toml`. The TOML schema below has been rewritten to match the upstream `config.toml.example` read on 2026-05-11.

## Files to Create / Modify

> Lives inside this monorepo at `agent-runtime/` (top-level folder, not an npm workspace).

```
agent-runtime/
├── config/
│   └── openab.toml               # NEW — singular [gateway] + [agent]
└── scripts/
    └── render-config.sh          # NEW (optional) — env → TOML interpolation
```

## Step-by-Step Implementation

### Step 1: ~~Verify upstream config schema~~ — DONE in Phase 0.1

> **Resolved in `openab-upstream-findings.md`** (cloned `openabdev/openab` on 2026-05-11). The relevant outputs that drove the TOML below:
>
> - **Config schema** — singular `[gateway]` and `[agent]`; `allowed_users` lives under `[gateway]`; `${VAR}` interpolation is native (not `${env:VAR}`), so `render-config.sh` is optional — but we keep it because environment-variable interpolation is most reliable when scripted at boot.
> - **LINE gateway capabilities** — Hybrid replyToken / Push API dispatch is implemented inside the gateway with a 50s TTL (see ADR `line-adapter.md`). HMAC verification uses `axum`-managed raw bytes. Image relay is **not** supported: agents must call LINE Push API directly.
> - **Agent spawning** — ACP JSON-RPC over stdio via `--acp` flag. `gemini --acp` is supported natively (per `Dockerfile.gemini` upstream).
> - **Structured output** — OpenAB uses `tracing` (text); Gemini CLI's own `GEMINI_TELEMETRY_OUTFILE` is the canonical JSON-event source for the dashboard (see `northflank-container.md` Step 6).
>
> If any of these change in a future OpenAB release, update `openab-upstream-findings.md` first, then this doc.

### Step 2: Author `config/openab.toml`

**File:** `agent-runtime/config/openab.toml`

**Changes:**

```toml
# === Custom Gateway (separate process; see northflank-container.md) ===
# OpenAB is outbound-only; it dials the openab-gateway over WebSocket and the
# gateway handles all inbound LINE webhooks + replyToken/pushMessage hybrid.
# The gateway lives on loopback in the single-container setup chosen in
# openab-upstream-findings.md §1.
[gateway]
url       = "ws://127.0.0.1:8080/ws"
platform  = "line"
# Optional shared secret for the OAB↔gateway WS link. If both sides set it,
# the link rejects unauthenticated connections. Use a long random string.
token     = "${GATEWAY_TOKEN}"
# No allowed_users — agent-runtime accepts all users forwarded by the edge
# server. User-level filtering is handled at the Cloudflare Worker layer
# (LINE_ALLOWED_USER_IDS in edge/.dev.vars).
# allowed_channels = ["C..."]   # uncomment for group-chat allowlist

# === Agent: Gemini CLI ===
# Spawned per session via ACP JSON-RPC over stdio (gemini --acp). OpenAB
# calls env_clear() before spawn, so only the variables explicitly listed
# below reach the agent process. See gemini-cli-tools.md Step 6 for the
# per-variable table of who reads what.
[agent]
command     = "gemini"
args        = ["--acp"]
working_dir = "/home/node"
env = {
  GEMINI_API_KEY               = "${GEMINI_API_KEY}",
  GITHUB_PERSONAL_ACCESS_TOKEN = "${GITHUB_TOKEN}",
  LINE_CHANNEL_ACCESS_TOKEN    = "${LINE_CHANNEL_ACCESS_TOKEN}",
  CF_UPLOAD_SECRET             = "${CF_UPLOAD_SECRET}",
  CF_IMG_BASE_URL              = "${CF_IMG_BASE_URL}",
  # Gemini CLI telemetry — captured by events-emitter.js for the dashboard.
  GEMINI_TELEMETRY_ENABLED     = "true",
  GEMINI_TELEMETRY_TARGET      = "local",
  GEMINI_TELEMETRY_OUTFILE     = "/var/log/openab/gemini-events.jsonl",
}

# === Session pool ===
[pool]
max_sessions      = 5      # ≤5 invited users; each session ≈ 250 MB RSS + Chromium
session_ttl_hours = 168    # 7 days; ACP transcripts kept this long

# === Markdown / reactions ===
[markdown]
tables = "code"            # LINE has no markdown rendering; code blocks survive best

[reactions]
enabled = false            # LINE does not support message reactions
```

**Rationale:**
- **`[gateway]` is singular.** OpenAB only supports one gateway link per process; multi-platform deploys run separate OpenAB pods, not multiple `[gateway]` blocks. For LINE-only FEAT-1 this is fine.
- **`platform = "line"`** is the session-key namespace prefix (`line:{userId}`) — see ADR `line-adapter.md`.
- **`allowed_users` removed.** User-level filtering is handled exclusively at the Cloudflare Worker (edge) layer. The agent-runtime accepts all requests forwarded by the edge server, simplifying the config and removing a duplicated concern.
- **`max_sessions = 5`** caps RAM/process count. With a 2 GB plan, each Gemini CLI process ~250 MB + Chromium peak; five is the safe ceiling before swap.
- **`session_ttl_hours = 168`**: a week is long enough that "remind me what you did Monday" works, short enough that abandoned threads get reaped.
- **No `--trust-all-tools` flag.** Gemini CLI's Policy Engine (see `gemini-cli-tools.md` Step 3b) is the inner trust layer; the Northflank container is the outer trust boundary. Adding `--trust-all-tools` (or its v0.41.x equivalent `--yolo`) would collapse both, which is exactly what `plans/review.md` finding #1 warned against.
- **`GEMINI_TELEMETRY_OUTFILE`** is the source of every `AgentEvent` on the dashboard. Once `events-emitter.js` is wired to tail it, the dashboard's live feed comes "for free" — no upstream patches, no stdout wrapping.
- **Webhook URL, channel secret, channel access token are absent.** Those move to the **gateway process's env** (`openab-gateway`), not OpenAB. See `line-integration.md` Step 4 for where they go.

### Step 3: Env interpolation at boot

**File:** `agent-runtime/scripts/render-config.sh`

> **Schema corrected (per `openab-upstream-findings.md` §2).** OpenAB natively expands `${VAR}` in TOML — no `${env:VAR}` form needed. The script pipes through `envsubst` as a belt-and-braces defence against the file being read by something other than OpenAB.

**Changes:**

```sh
#!/bin/sh
# Renders /etc/openab/openab.toml -> /tmp/openab.toml at boot.
set -eu
template="${1:?usage: render-config.sh <template> <out>}"
out="${2:?usage: render-config.sh <template> <out>}"

# Pass an explicit allowlist to envsubst so unrelated $VAR-looking strings in
# the template (e.g. inside future comments) are left alone.
envsubst '${GATEWAY_TOKEN} ${GEMINI_API_KEY} ${GITHUB_TOKEN} ${LINE_CHANNEL_ACCESS_TOKEN} ${CF_UPLOAD_SECRET} ${CF_IMG_BASE_URL}' \
  < "$template" > "$out"
```

Then in `entrypoint.sh`, before `exec openab`:

```sh
/usr/local/bin/render-config.sh /etc/openab/openab.toml /tmp/openab.toml
exec openab run -c /tmp/openab.toml
```

**Rationale:** With `allowed_users` removed from the TOML (filtering now handled at the edge layer), the script is a straightforward `envsubst` — no array conversion needed.

### Step 4: ~~Reverse-proxy decision~~ — N/A in the new architecture

> **Removed (per `openab-upstream-findings.md` §1).** The previous text assumed OpenAB exposed an HTTP endpoint on `:8081` that needed to be reverse-proxied. **OpenAB has no inbound HTTP port** — it is outbound-only and dials the gateway over WebSocket. The container's only inbound port belongs to `openab-gateway` on `:8080` (which already serves `/health` natively).
>
> The healthz Node sidecar still exists, but its role is now: own `/events/stream`, `/sessions`, `/sessions/:userId/history`. It does **not** proxy anything to OpenAB. See `northflank-container.md` Step 6 for the updated sidecar.

### Step 5: Document the config

**File:** `agent-runtime/README.md` (excerpt)

**Changes:** add a "Configuration" section enumerating every env var the TOML interpolates. Cross-reference `.env.example`.

**Rationale:** the next person (or me, in 6 months) shouldn't have to grep TOML to find what the container needs.

## Testing Steps

1. **Schema parse:** `openab run -c /tmp/openab.toml` (after render-config.sh has produced it). Expect the process to start and log a successful connection to `ws://127.0.0.1:8080/ws`. Kill it after a few seconds; any "missing field"/"unknown key" error surfaces in the first second.
2. **Open-access test:** POST a fake LINE event from any userId through the gateway. The container should accept it and spawn a Gemini session (no allowlist filtering at agent-runtime level; filtering is at the edge layer).
3. **Session keying test:** send two messages from the same LINE userId in succession (via the LINE bot or an HMAC-signed curl). Verify there's exactly one Gemini process via `pgrep -a gemini` — the second message should reuse the existing session.
4. **TTL test:** set `session_ttl_hours = 0.01` (~36s) for a test build, send a message, wait, send another → expect a *new* session to spawn after the TTL elapses (`pgrep -a gemini` shows a new PID).
5. **Env-clear test:** add a sentinel like `SHOULD_BE_HIDDEN=secret` to the container env but **not** to `[agent].env`. Have the agent run `env` (it can't — the Policy Engine denies; test by adding a temporary `commandPrefix = "env"` rule). Verify `SHOULD_BE_HIDDEN` is absent. Remove the test rule before deploy.

## Dependencies

- Must complete before: `northflank-container.md` (the Dockerfile copies this file).
- Depends on: `gemini-cli-tools.md` (defines the `gemini` CLI behavior referenced from `[agent]`).

## Notes

- **Single-layer filtering:** the LINE userId allowlist is checked at the **Cloudflare Worker** (edge) layer only. The agent-runtime accepts all forwarded requests, keeping the config simple. The edge server is the trust boundary for user filtering.
- **No multi-agent setup:** OpenAB only supports one `[agent]` block per process. Adding Claude Code or Codex later means a second OpenAB pod, not a second `[agents.X]` block. Out of scope for v1.
- **Group chat opt-out:** OpenAB keys LINE 1:1 sessions as `line:{userId}` and group sessions as `line:{groupId}`. Per ADR `line-adapter.md`, group sessions are shared across all members; we deliberately do not configure `allowed_channels` because the FEAT-1 use case is 1:1 only.
- **Hot reload:** OpenAB may support config hot-reload on SIGHUP. Don't rely on it for v1; redeploy on config change.
- **`render-config.sh`** is now a thin `envsubst` wrapper — no array conversion needed since `allowed_users` was removed. Keep the script idempotent — running it twice with the same env must produce the same TOML byte-for-byte.
