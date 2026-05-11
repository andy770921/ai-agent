# OpenAB + Gemini CLI Upstream Verification Findings

Created during Phase 0.1 of FEAT-1. These are the facts read from the **actual OpenAB source** (`openabdev/openab`, cloned 2026-05-11 from `main`) and the **actual Gemini CLI image** that OpenAB itself ships. They **override** the assumptions in `plans/prd.md` and the `development/*.md` plans wherever they disagree.

Source: `/tmp/openab/` — files referenced are paths inside that clone.

---

## TL;DR — The PRD has five wrong assumptions

1. **OpenAB is NOT a single container.** It is **two services**: `openab` (Rust binary, outbound-only) + `openab-gateway` (separate Rust binary, holds webhook + platform credentials). The two communicate via WebSocket. The gateway image is published as `ghcr.io/openabdev/openab-gateway:0.3.0`.
2. **There is no `[gateways.line]` or `[agents.gemini]`.** The TOML uses **singular** `[gateway]` and `[agent]` blocks. Adapter-specific keys (`channel_secret`, `webhook_path`, etc.) live in the **gateway** service's env, not in OpenAB's TOML.
3. **The LINE `replyToken`/`pushMessage` hybrid is already implemented inside the gateway** (50s `event_id → replyToken` cache). We do **not** need to write `line-helper.js` or implement the deadline switch.
4. **OpenAB does not relay images.** All image sends are out-of-band, agent → platform API. Our `IMG <url>` gateway-side parser **does not exist upstream** — we either patch the gateway or have the agent call LINE Push API directly using `sender_context.channel_id`.
5. **OpenAB has no structured event stream.** It uses the `tracing` crate (text logs at `info!`/`debug!` levels), not JSON lines. The dashboard's events emitter has to derive events some other way (tee Gemini stdio, patch OpenAB, or poll session files).

These are not stoppers, but they materially change Phase B (the container plan).

---

## 1. Architecture (DESIGN.md, gateway/README.md)

```
                   External (HTTPS)                  Internal (cluster)
                   ────────────────                  ──────────────────

LINE   ──POST──▶ ┌─────────────────────┐
Telegram──POST──▶│ openab-gateway      │◀──WebSocket── openab (Rust)  ──ACP/stdio──▶ gemini --acp
                 │ (separate binary)   │              │                              │
                 │ holds all webhook   │              │ no inbound port              │
                 │ + platform secrets  │              │ no TLS                       │
                 └─────────────────────┘              └──────────────────────────────┘

Discord, Slack: native to `openab`, also outbound only.
```

**Implications for our deploy:**
- We need both binaries running for LINE support. Three deployment shapes are viable on Northflank:
  - **B1 (chosen, see below):** single container, both processes via `entrypoint.sh` running `openab-gateway &` + `exec openab run ...`. Fits the $24/mo `nf-compute-100-2` budget.
  - **B2:** two Northflank services. Doubles cost (~$48/mo).
  - **B3:** Northflank "combined service" with two containers in one pod. May or may not be supported on Northflank's plans.

> **Decision (Phase B):** B1. The two processes inside one container is what `docker-compose.yml` in `agent-runtime/` will model, and what `entrypoint.sh` orchestrates. The DESIGN.md explicitly allows running `openab-gateway` and `openab` as separate processes; nothing requires Kubernetes / multi-pod isolation. Document this as an intentional v1 deviation from upstream's "separate pods" recommendation; revisit if we ever scale beyond ≤5 users.

---

## 2. TOML schema (config.toml.example, docs/config-reference.md)

**Correct shape for our use case:**

```toml
[gateway]
url = "ws://127.0.0.1:8080/ws"      # WebSocket URL of the gateway process (loopback in single-container)
platform = "line"
token = "${GATEWAY_TOKEN}"            # optional shared secret for the openab↔gateway WS link
# LINE allowlist lives here (NOT in the gateway's env)
allowed_users = ["U..."]              # comma list of LINE userIds; omit / leave empty = allow all
# allowed_channels = ["C..."]         # LINE groupIds; usually omit for 1:1 DM bots

[agent]
command = "gemini"
args    = ["--acp"]
working_dir = "/home/node"
# IMPORTANT: env_clear() is the default. Only HOME/PATH/USER are inherited.
# To pass anything else, list it in env or inherit_env. SECURITY WARNING in
# upstream docs: anything in [agent].env is reachable by the agent process,
# so a prompt-inject can exfiltrate it.
env = {
  GEMINI_API_KEY            = "${GEMINI_API_KEY}",
  GITHUB_PERSONAL_ACCESS_TOKEN = "${GITHUB_TOKEN}",
  # To send images, the agent must call LINE Push API directly; that needs the
  # channel access token in the agent's env. This is the OpenAB-recommended
  # pattern (see sendimages.md) but explicitly a trust tradeoff. We accept it
  # for v1 because the agent runs in the sandboxed container and the token is
  # scoped to a single LINE channel.
  LINE_CHANNEL_ACCESS_TOKEN = "${LINE_CHANNEL_ACCESS_TOKEN}",
  # For post-screenshot.sh:
  CF_UPLOAD_SECRET          = "${CF_UPLOAD_SECRET}",
  CF_IMG_BASE_URL           = "${CF_IMG_BASE_URL}",
}

[pool]
max_sessions      = 5         # PRD says ≤5 invited users
session_ttl_hours = 168       # 7d, matches the original plan
# prompt_hard_timeout_secs = 1800  (default)
# liveness_check_secs      = 30    (default)

[markdown]
tables = "code"               # bullets/off are the alternatives; default code is fine

[reactions]
enabled = false                # LINE doesn't support reactions anyway
```

**Gateway's env (NOT openab.toml — set on the gateway process):**

| env var | required | source |
|---|---|---|
| `LINE_CHANNEL_SECRET` | yes | LINE Developers Console → Basic settings |
| `LINE_CHANNEL_ACCESS_TOKEN` | yes | LINE Developers Console → Messaging API |
| `GATEWAY_LISTEN` | default `0.0.0.0:8080` | bind addr |
| `TELEGRAM_BOT_TOKEN` | yes (gateway code requires at least one platform env)* | leave at any non-empty placeholder if LINE-only |

\* Confirmed by `gateway/README.md`: "Required" for Telegram is "(required)". Tested by the upstream Quick Start which only exports `TELEGRAM_BOT_TOKEN`. **TODO during deploy:** verify whether a LINE-only deploy needs a Telegram placeholder, or whether the gateway tolerates only `LINE_*` being set. If forced, set `TELEGRAM_BOT_TOKEN=placeholder` and disable Telegram webhook on LINE Console.

**Gateway endpoints (gateway/README.md):**
- `POST /webhook/line` — LINE webhook lands here (gateway verifies HMAC internally)
- `POST /webhook/telegram` etc.
- `GET /ws` — OpenAB connects to this for the WebSocket link
- `GET /health` — gateway healthcheck

---

## 3. LINE webhook + reply path (docs/adr/line-adapter.md)

**What the gateway does for us automatically (no FEAT-1 code needed):**

1. **HMAC-SHA256 verification** of `X-Line-Signature` using `LINE_CHANNEL_SECRET`. Per the ADR "Compliance" section, the gateway uses `axum` and verifies against raw request bytes — covers the two silent-failure modes (partial read, lossy UTF-8) the PRD was worried about.
2. **`webhookEventId` ingestion** — events ride into OpenAB on the WebSocket link with an internal `event_id` (UUID generated by the gateway, NOT the raw LINE `webhookEventId`).
3. **Hybrid Reply/Push dispatch** — the gateway caches `event_id → replyToken` with a 50 s TTL, uses Reply API while fresh, falls back to Push API otherwise. Background sweeper reaps expired entries. **This obsoletes `line-integration.md` Step 5's fallback `line-helper.js`** — that file should NOT be authored in Phase B.
4. **Session keying** — `line:{userId}` for 1:1, `line:{groupId}` for group. PRD's "session_key = userId" assumption is correct but the key is set by the gateway/OpenAB combination, not by our TOML.

**What it does NOT do:**
- LINE `X-Line-Retry-Key` on outbound push — not documented in the ADR; **TODO during deploy:** grep `gateway/src/adapters/line.rs` for `X-Line-Retry-Key`, and if absent, file an upstream issue. For v1 the dedup in our Cloudflare Worker KV already covers ingress retries; pushMessage retries are the gateway's problem.
- LINE `deliveryContext.isRedelivery` is passed through the webhook body. The gateway forwards the event but does not natively dedupe; the Worker's KV-based dedup in `cloudflare-webhook.md` Step 3 remains useful.

---

## 4. Image sending (docs/sendimages.md)

> "OpenAB does **not** relay images from the agent to Discord — it only streams text. To send an image back to the user, the agent must call the Discord API directly."

The same applies to LINE. Two paths for FEAT-1:

**Path A (chosen for v1):** Agent calls LINE Push API directly.
- Add `LINE_CHANNEL_ACCESS_TOKEN` to `[agent].env` (security tradeoff acknowledged).
- `post-screenshot.sh` keeps its existing shape (uploads to R2, prints URL).
- A second shell helper, `agent-runtime/scripts/send-line-image.sh`, takes `<userId> <url>` and POSTs:
  ```
  POST https://api.line.me/v2/bot/message/push
  Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN
  Content-Type: application/json
  {
    "to": "<userId>",
    "messages": [{
      "type": "image",
      "originalContentUrl": "<url>",
      "previewImageUrl":   "<url>"
    }]
  }
  ```
- The system prompt instructs the agent to read `sender_context.sender_id`, call `post-screenshot.sh` → URL, then call `send-line-image.sh <sender_id> <url>`.
- After the image is sent, the agent **also** returns a short text confirmation (e.g. "Screenshot above ⤴") so the OpenAB Reply path closes its turn.

**Path B (deferred):** Patch `openab-gateway` to parse `IMG <url>` and convert. Would be a v2 upstream contribution.

**Update propagated to plans:**
- `gemini-cli-tools.md` Step 4: change the IMG-prefix convention to "call `send-line-image.sh`".
- `gemini-cli-tools.md` `tools.allowed` adds `ShellTool(/usr/local/bin/send-line-image.sh)`.
- `line-integration.md` Step 6: remove the IMG-prefix parser; replace with "image path is `agent → LINE Push API directly`".
- `openab-config.md` Step 2: `[agent].env` includes `LINE_CHANNEL_ACCESS_TOKEN`.

These doc edits are **not part of Phase 0.1 output** — they happen in Phase B alongside the code that implements them, so the diff stays cohesive.

---

## 5. Gemini CLI ACP (Dockerfile.gemini, docs/gemini.md)

Upstream's reference Dockerfile pins:
- Base image: `node:22-bookworm-slim`
- `@google/gemini-cli@0.40.1` (npm install -g)
- `gh` CLI (deb), `procps`, `ripgrep`, `tini` baked in
- HEALTHCHECK uses `pgrep -x openab`
- ENTRYPOINT is `tini --`, CMD is `openab run -c /etc/openab/config.toml`

**`gemini --acp` is native** (confirmed in `docs/gemini.md`). No adapter or wrapper needed. The same image can be used for both Helm and bare-Docker runs.

**Tool policy:** OpenAB handles **tool call permission auto-reply** transparently (`src/acp/connection.rs:196`: `info!(title, %outcome, "auto-respond permission")`). Combined with running inside a container, this means we deliberately do not need Gemini CLI's interactive confirmation flow. The PRD's concern about `--trust-all-tools` collapsing the trust boundary still applies — keep the documented `tools.core`/`tools.exclude`/`tools.allowed`/`tools.sandbox` policy from `gemini-cli-tools.md` Step 3, and **do not** add `--trust-all-tools` to `args`.

> **What still needs verifying after install (Phase 0.2, when we have a working install):** the exact key names `tools.core`/`tools.exclude`/`tools.allowed` against `gemini --help` and the upstream Gemini CLI configuration reference. The PRD already flags this. The key names appearing in `gemini-cli-tools.md` Step 3 are **best effort**; treat them as TODO until Phase 0.2 confirms.

---

## 6. Sender context (docs/sendimages.md)

Every inbound message carries a `<sender_context>` JSON block forwarded to the agent:

```json
{
  "schema": "openab.sender.v1",
  "sender_id": "<LINE userId>",
  "sender_name": "...",
  "display_name": "...",
  "channel": "line",
  "channel_id": "<LINE chatId>",
  "thread_id": null,
  "is_bot": false
}
```

The agent reads this block (it appears in the prompt OpenAB sends over ACP). This is **how the agent learns who to push an image to**. The system prompt in `gemini/system-prompt.md` should instruct the agent to extract `sender_id` from this block before calling `send-line-image.sh`.

---

## 7. Structured event stream for dashboard (src/dispatch.rs, src/acp/connection.rs)

OpenAB logs via the `tracing` crate. Examples:

```
info!(cmd = command, ?args, cwd = working_dir, "spawning agent");
info!(title, %outcome, "auto-respond permission");
info!(session_id = %session_id, "session created");
debug!(line = line.trim(), "acp_recv");
debug!(data = data.trim(), "acp_send");
```

There is **no `--log-format=json` flag** documented. The `acp_recv` / `acp_send` debug events are the only place the raw ACP JSON-RPC flow is observable, but only at `debug` level (verbose).

**Strategies for `events-emitter.js` (no clear winner — pick during Phase B):**

| Strategy | Mechanism | Risk |
|---|---|---|
| **A. Tail `tracing` output** with `RUST_LOG=openab=info`, parse `key=value` pairs into `AgentEvent` | low integration, but tracing format is fragile to upstream changes | format may break on minor releases |
| **B. Wrap `gemini`** — replace `[agent].command = "gemini"` with a tee script that writes ACP JSON-RPC traffic to a named pipe; emitter reads pipe | most accurate (the actual ACP traffic), no upstream dependency | adds complexity; need to handle stdin/stdout/stderr passthrough correctly |
| **C. Poll session files** at `~/.openab/sessions/` or wherever the ACP transcripts live | upstream-stable | latency, no real-time |
| **D. Upstream patch** — add `OPENAB_EVENTS_FILE` env, write JSON lines | best for everyone | requires merging a PR + waiting for a release |

**Decision (Phase B):** Strategy **B (wrap Gemini)**. The wrap script is ~30 lines, it captures the exact ACP traffic, and it's the only strategy that gives us tool-call lifecycle (call → result) without parsing tracing formats. Document the alternatives in `events-emitter.js` comments so a future replacement is easy.

**Sketch of the wrapper:**
```sh
#!/bin/sh
# /usr/local/bin/gemini-acp-wrap.sh — invoked by openab in place of `gemini`.
exec node /usr/local/bin/gemini-acp-tee.js "$@"
```

`gemini-acp-tee.js` spawns the real `gemini` with the same args, pipes stdin↔gemini-stdin and gemini-stdout↔stdout (so OpenAB sees a faithful ACP stream), and parses each JSON-RPC frame on stdout, appending a transformed `AgentEvent` to a file watched by `events-emitter.js`.

---

## 8. Output directives (docs/output-directives.md)

OpenAB supports `[[key:value]]` prefix directives:
- `[[reply_to:msg_id]]` — Discord-only currently; LINE adapter ignores.
- Other keys are reserved (no `[[image:url]]` yet).

Not directly useful for FEAT-1 v1, but informs the v2 path: if we want to migrate the image-send to a gateway-side parser, the cleanest upstream path is to add `[[image:<url>]]` here and have the gateway adapter handle it.

---

## 9. What this changes in Phase B implementation

| Doc | Change |
|---|---|
| `northflank-container.md` Step 1 | Base image becomes `node:22-bookworm-slim` (matching `Dockerfile.gemini`), not `mcr.microsoft.com/playwright`. Install Chromium ourselves — Playwright's apt deps are documented; ~150 MB. **Or** keep the Playwright base AND add the OpenAB+gateway binaries. The latter is faster to ship; revisit size after the first build. |
| `northflank-container.md` Step 2 | `gh` CLI is **already** in OpenAB's Gemini image — we can skip our explicit install if we use that base. |
| `northflank-container.md` Step 3 | `gemini/settings.json` lives at `/home/node/.gemini/settings.json` (per `Dockerfile.gemini`'s `mkdir /home/node/.gemini`), not `/root/.gemini/`. The agent runs as the `node` user. |
| `northflank-container.md` Step 5 | `entrypoint.sh` runs **three** things, not two: `openab-gateway &` + `node /usr/local/bin/healthz.js &` + `exec openab run -c /tmp/openab.toml`. |
| `northflank-container.md` Step 6 | Healthz Node sidecar's `/openab/*` proxy is **deleted** — there's no openab HTTP port to proxy to. Instead it proxies `/health` to the gateway (`127.0.0.1:8080/health`) for Northflank's probe and serves `/events/stream` + `/sessions` from the events-emitter (Strategy B). |
| `openab-config.md` Step 2 | Replace the entire `[gateways.line]` block with the singular `[gateway]` block above. Replace `[agents.gemini]` with `[agent]`. Drop `webhook_path`/`channel_secret`/`channel_access_token` — those move to the gateway env. |
| `line-integration.md` Step 4 | Webhook URL in LINE Console points to the **gateway** path `/webhook/line` (e.g. `https://<container>.northflank.app/webhook/line`). The Cloudflare Worker, if used, proxies that path. |
| `line-integration.md` Step 5 | Delete fallback `line-helper.js` — gateway handles it. |
| `line-integration.md` Step 6 | Replace IMG-prefix parser docs with the "agent calls LINE Push API via `send-line-image.sh`" pattern. |
| `gemini-cli-tools.md` Step 4 | System prompt: read `sender_context.sender_id`, then run `post-screenshot.sh` → `send-line-image.sh <userId> <url>`. Drop the IMG-prefix instruction. |
| `cloudflare-webhook.md` Step 3 | The Worker's value-add narrows to: KV dedup on `webhookEventId` (still useful — it's at the edge, before the gateway), Worker-level allowlist (cheaper than waking the container), and pass-through forwarding to `/webhook/line`. The gateway re-verifies HMAC anyway. |
| `dashboard-ui.md` | No structural change. |
| `prd.md` | Update the topology box: gateway + openab as separate processes in one container. Cost stays at ~$29/mo. |

These doc edits will land **alongside the Phase B code** so the commit shows code + doc together.

---

## 10. Gemini CLI verified (Phase 0.2, offline)

Installed `@google/gemini-cli@0.41.2` locally (node 22) and read the bundled docs at `node_modules/@google/gemini-cli/bundle/docs/`. **The `gemini-cli-tools.md` Step 3 `settings.json` schema in the FEAT-1 plan is out of date.** Below is the correct current schema.

### 10.1 `gemini --help` flags relevant to us

- `--acp` — start in ACP (JSON-RPC over stdio) mode. ✅ Native.
- `--experimental-acp` — alias, deprecated.
- `-s, --sandbox` — boolean flag to run in sandbox.
- `--yolo` — auto-approve all tool calls. **Do NOT pass to the spawned Gemini.** Equivalent to the PRD's "do not pass `--trust-all-tools`".
- `--approval-mode` — `default | auto_edit | plan | yolo`.
- `-o, --output-format` — `text | json | stream-json`. NOT applicable in `--acp` mode (ACP defines its own framing), but useful for one-shot tests.
- `--policy` / `--admin-policy` — supplemental policy file paths (TOML).
- `--allowed-tools` — **deprecated**, the docs say "Use Policy Engine instead".
- `--allowed-mcp-server-names` — array, allowlist for MCP servers.

### 10.2 Tool restrictions: TOML Policy Engine (not `settings.json`)

The PRD's `tools.core` / `tools.exclude` / `tools.allowed` keys do not exist in Gemini CLI v0.41.2. Tool policy now lives in **TOML files** at:

| Tier | Path | Notes |
|---|---|---|
| **User** | `~/.gemini/policies/*.toml` | what we'll use in the container |
| **Admin** | `/etc/gemini-cli/policies/*.toml` (Linux) | requires root-owned dir, chmod 755 |
| Workspace | `./.gemini/policies/*.toml` | currently disabled per upstream bug #18186 |

**Rule schema (from `bundle/docs/reference/policy-engine.md`):**

```toml
# Allow only one shell command, post-screenshot.sh
[[rule]]
toolName     = "run_shell_command"
commandPrefix = "/usr/local/bin/post-screenshot.sh"
decision     = "allow"
priority     = 800

# Allow only send-line-image.sh (the new image-send path from finding #4)
[[rule]]
toolName     = "run_shell_command"
commandPrefix = "/usr/local/bin/send-line-image.sh"
decision     = "allow"
priority     = 800

# Catch-all: deny every other shell command. `deny` rules also remove the
# tool from the model's context — saves tokens and is more secure.
[[rule]]
toolName = "run_shell_command"
decision = "deny"
priority = 100
denyMessage = "Only post-screenshot.sh and send-line-image.sh are permitted."

# Deny built-in WebFetch / WebSearch / save_memory entirely (the FEAT-1
# threat model does not need outbound HTTP nor persistent memory).
[[rule]]
toolName = "web_fetch"
decision = "deny"
priority = 800

[[rule]]
toolName = "web_search"
decision = "deny"
priority = 800

[[rule]]
toolName = "save_memory"
decision = "deny"
priority = 800

# Allow all Playwright MCP tools (mcpName matches by server name).
[[rule]]
mcpName  = "playwright"
decision = "allow"
priority = 700

# Allow all GitHub MCP tools.
[[rule]]
mcpName  = "github"
decision = "allow"
priority = 700

# Catch-all for any other MCP server we didn't whitelist.
[[rule]]
mcpName  = "*"
decision = "deny"
priority = 100
```

**File goes at `agent-runtime/gemini/policies/feat1.toml`**, mounted into `~/.gemini/policies/` in the container.

### 10.3 `settings.json`: still used, but for different things

Valid top-level groups in v0.41.2 (`bundle/docs/cli/settings.md`):

- `mcpServers` — MCP server registry (still the canonical place; not deprecated). Schema unchanged from older docs:
  ```json
  {
    "mcpServers": {
      "playwright": {
        "command": "npx",
        "args": ["-y", "@playwright/mcp@latest", "--browser", "chromium", "--headless"]
      },
      "github": {
        "command": "github-mcp-server",
        "args": ["stdio", "--toolsets=repos,issues,pull_requests"],
        "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}" }
      }
    }
  }
  ```
  (Note the upstream MCP tutorial recommends `docker run --rm ghcr.io/github/github-mcp-server:latest` as the GitHub MCP server — we'll do this in the agent-runtime Dockerfile.)
- `model.name` — `"gemini-2.5-flash"` etc. Top-level `model` is **deprecated** in favor of `model.name`.
- `tools.sandboxAllowedPaths`, `tools.sandboxNetworkAccess`, `tools.useRipgrep`, `tools.truncateToolOutputThreshold`.
- `security.toolSandboxing`, `security.disableYoloMode = true`.
- `general.defaultApprovalMode` — set to `"default"` so the policy engine actually evaluates; `"plan"` is read-only.

**The `tools.core` / `tools.exclude` / `tools.allowed` / `tools.sandbox` keys from `gemini-cli-tools.md` Step 3 do NOT exist** — they were inherited from an older Gemini CLI 0.3.x doc and never updated. The new schema is: **tool gating lives in TOML policies, everything else in `settings.json`.**

### 10.4 System prompt: `~/.gemini/system.md` + `GEMINI.md`

The `systemInstructionFile` JSON key in the PRD is wrong. The actual path:

| File | Where | Purpose |
|---|---|---|
| **`~/.gemini/system.md`** | User-level | full **override** of the built-in system prompt. Use this for the "you are a LINE assistant" persona. |
| **`~/.gemini/GEMINI.md`** | User-level | **augments** the system prompt with high-level guidance (project conventions, style). |
| **`<cwd>/GEMINI.md`** | Project-level | further augments per-project. |

Use **`system.md`** for the FEAT-1 LINE persona — it fully replaces the default Gemini coding-assistant prompt, which is what we want.

### 10.5 Structured events for the dashboard: `GEMINI_TELEMETRY_OUTFILE`

From `bundle/docs/cli/acp-mode.md`:

> For more detailed telemetry, you can use the following environment variables to capture telemetry data to a file:
> - `GEMINI_TELEMETRY_ENABLED=true`
> - `GEMINI_TELEMETRY_TARGET=local`
> - `GEMINI_TELEMETRY_OUTFILE=/path/to/your/log.json`
> This will write a JSON log file containing detailed information about all the events happening within the agent, including ACP requests and responses.

**This is the events emitter source of truth.** The events-emitter sidecar tails `GEMINI_TELEMETRY_OUTFILE` and reshapes each JSON line into the `AgentEvent` contract. **No need for Strategy B (wrap script) from section 7 of this doc — Strategy D (Gemini-native telemetry) supersedes it.** Update the events-emitter Phase B design accordingly.

### 10.6 Updated implications for Phase B

Add to section 9's table:

| Doc | Additional change |
|---|---|
| `gemini-cli-tools.md` Step 3 | **Replace entire `settings.json` block.** New `settings.json` only contains `mcpServers`, `model.name`, `tools.sandbox*`, `security.toolSandboxing`. Tool gating moves to a new file `gemini/policies/feat1.toml` (User-tier policy). System prompt moves to a new file `gemini/system.md` (NOT `system-prompt.md`). |
| `gemini-cli-tools.md` Step 4 | System prompt file renamed `system.md`; its `IMG <url>` instruction is replaced with the `sender_context.sender_id` + `send-line-image.sh` pattern from finding #4. |
| `gemini-cli-tools.md` Step 5 | A second helper `send-line-image.sh` is added next to `post-screenshot.sh`. |
| `northflank-container.md` Step 3 | COPY targets become `/home/node/.gemini/settings.json`, `/home/node/.gemini/system.md`, `/home/node/.gemini/policies/feat1.toml`. (User-level policy avoids the strict `chmod 755 + UID 0` admin-tier requirements.) |
| `northflank-container.md` Step 5 | Entrypoint exports `GEMINI_TELEMETRY_ENABLED=true GEMINI_TELEMETRY_TARGET=local GEMINI_TELEMETRY_OUTFILE=/var/log/openab/gemini-events.jsonl` (one file shared across all agent invocations; rotated by logrotate or simple size-cap in the sidecar). |
| `northflank-container.md` Step 6 | `events-emitter.js` becomes a 30-line tail of `GEMINI_TELEMETRY_OUTFILE` with a `reshapeToAgentEvent` function. Drop the three-strategy speculation. |

---

## 11. Known unknowns (still need Phase 0.3 live spike)

1. Whether the gateway tolerates `TELEGRAM_BOT_TOKEN` being unset for LINE-only deploys. (offline-unverifiable)
2. ~~Whether `gemini --help` actually lists the tool-policy keys~~ — **resolved in section 10**: it doesn't; we use TOML Policy Engine instead.
3. Whether `GEMINI_TELEMETRY_OUTFILE` actually emits events when Gemini runs in `--acp` mode (the docs imply yes; the integration test `integration-tests/acp-telemetry.test.ts` is the upstream proof). **Verify during Phase 0.3** by running `gemini --acp` with a one-shot prompt and inspecting the outfile.
4. Whether Northflank's `nf-compute-100-2` actually supports a single container with three processes (gateway :8080, healthz :8081, openab); needs the deploy spike.
5. Whether `openab-gateway` honours `LINE_BOT_USER_ID` for self-message filtering (LINE platform echoes the bot's own messages back on the webhook in some configurations); look for it during the e2e spike.
6. Whether `gemini --policy /home/node/.gemini/policies/feat1.toml --acp` is the correct invocation, or whether the policies are picked up automatically from `~/.gemini/policies/`. The docs say the latter for User-tier; **default behavior preferred** — no extra flag in `openab.toml` `[agent].args`.

These get answered in Phase 0.3 (live, on Northflank). Phase B can start now with the corrections in sections 9 and 10.
