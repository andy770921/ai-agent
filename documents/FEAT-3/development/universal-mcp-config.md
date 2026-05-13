# FEAT-3 Implementation: Universal MCP Configuration

This document describes the exact code changes made to decouple MCP server
definitions from any single LLM CLI and fix the `env_clear()` environment
issue that prevented MCP servers from starting.

## Bug Fix: Missing Environment Variables in `[agent].env`

### Root cause

OpenAB calls `env_clear()` before spawning the agent subprocess, then injects
only the variables listed in `[agent].env`. The original config omitted three
critical variables:

| Variable | Why it is needed |
|---|---|
| `HOME` | Gemini CLI resolves `~/.gemini/settings.json` via `$HOME`. Without it, no settings file is found, so no MCP servers are configured. |
| `PATH` | The agent subprocess needs to locate `github-mcp-server`, `npx`, `gemini`, and shell scripts. Without `PATH`, all external commands fail. |
| `PLAYWRIGHT_BROWSERS_PATH` | Playwright MCP looks up Chromium at this path. The Dockerfile installs browsers to `/ms-playwright`; without the env var, Playwright falls back to a download attempt that fails in the read-only container. |

### Symptom

When a user asked the LINE bot to perform a GitHub task, the agent could not
start the GitHub MCP server. Gemini CLI fell back to `web_search`, which the
policy engine denies (`feat1.toml` rule priority 800). The user received:

> :x: Searching the web for: "andy770921 GitHub repositories top 5"
> I am unable to retrieve the GitHub repository names due to a quota issue
> with the web search tool.

The `agent_dispatch_ms` was 192–222 seconds (vs. expected <10s), indicating
prolonged retry/timeout cycles before the fallback.

### Fix

**File:** `agent-runtime/config/openab.toml`

Added `HOME`, `PATH`, and `PLAYWRIGHT_BROWSERS_PATH` to `[agent].env`:

```toml
[agent]
command     = "gemini"
args        = ["--acp"]
working_dir = "/home/node"
env = {
  HOME = "/home/node",
  PATH = "/usr/local/bin:/usr/bin:/bin",
  PLAYWRIGHT_BROWSERS_PATH = "/ms-playwright",
  GEMINI_API_KEY = "${GEMINI_API_KEY}",
  GITHUB_PERSONAL_ACCESS_TOKEN = "${GITHUB_TOKEN}",
  LINE_CHANNEL_ACCESS_TOKEN = "${LINE_CHANNEL_ACCESS_TOKEN}",
  CF_UPLOAD_SECRET = "${CF_UPLOAD_SECRET}",
  CF_IMG_BASE_URL = "${CF_IMG_BASE_URL}",
  GEMINI_TELEMETRY_ENABLED = "true",
  GEMINI_TELEMETRY_TARGET = "local",
  GEMINI_TELEMETRY_OUTFILE = "/var/log/openab/gemini-events.jsonl"
}
```

`render-config.sh` does not need changes — `HOME`, `PATH`, and
`PLAYWRIGHT_BROWSERS_PATH` are literal strings (no `${...}` expansion
needed), and the existing `envsubst` allowlist already covers the
secret-bearing variables.

---

## Feature: Shared MCP Server Definitions

### New file: `agent-runtime/mcp/servers.json`

Single source of truth for all MCP servers. Format matches the dominant
`"mcpServers"` JSON schema used by Gemini CLI, Claude Code, Cursor, and
Claude Desktop:

```json
{
  "playwright": {
    "command": "npx",
    "args": ["--no-install", "@playwright/mcp", "--browser", "chromium", "--headless"],
    "env": {}
  },
  "github": {
    "command": "github-mcp-server",
    "args": ["stdio", "--toolsets=repos,issues,pull_requests"],
    "env": {
      "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}"
    }
  }
}
```

The `${GITHUB_PERSONAL_ACCESS_TOKEN}` token is expanded by Gemini CLI at
startup (it uses `dotenv-expand` internally). For Claude Code and Codex CLI,
the same expansion is expected from their respective runtimes; if a future
CLI does not support it, `render-mcp-config.sh` can be extended to do the
expansion via `envsubst`.

### New file: `agent-runtime/scripts/render-mcp-config.sh`

Boot-time script called from `entrypoint.sh` step 2b. Reads the `AGENT_CLI`
env var (default: `gemini`) and merges `mcp/servers.json` into the
appropriate config location:

| `AGENT_CLI` | Target file | Method |
|---|---|---|
| `gemini` | `/home/node/.gemini/settings.json` | JSON merge: adds `"mcpServers"` key to existing settings |
| `claude` | `/home/node/.mcp.json` | JSON write: wraps servers in `{ "mcpServers": ... }` |
| `codex` | `/home/node/.codex/config.toml` | TOML conversion: generates `[mcp_servers.<name>]` tables |

The script uses inline `node -e` for JSON/TOML manipulation (no new
dependencies — `node` is already in the base image).

### Modified file: `agent-runtime/gemini/settings.json`

Removed the `"mcpServers"` block. The file now contains only Gemini-specific
settings (model, tools, security, output format). At boot,
`render-mcp-config.sh` merges the shared MCP definitions back in.

Before:
```json
{
  "model": { "name": "gemini-2.5-flash" },
  ...
  "mcpServers": {
    "playwright": { ... },
    "github": { ... }
  }
}
```

After:
```json
{
  "model": { "name": "gemini-2.5-flash" },
  ...
}
```

### Modified file: `agent-runtime/scripts/entrypoint.sh`

Added step 2b after the OpenAB TOML render:

```sh
# ===== 2b. Merge shared MCP servers into the active LLM's config ============
AGENT_CLI="${AGENT_CLI:-gemini}" /usr/local/bin/render-mcp-config.sh
```

### Modified file: `agent-runtime/Dockerfile`

Two additions:

1. Copy `mcp/servers.json` to `/etc/openab/mcp-servers.json`:

```dockerfile
COPY mcp/servers.json              /etc/openab/mcp-servers.json
```

2. Copy and make executable the new script:

```dockerfile
COPY scripts/render-mcp-config.sh /usr/local/bin/render-mcp-config.sh
```

```dockerfile
RUN chmod +x /usr/local/bin/entrypoint.sh \
             /usr/local/bin/render-config.sh \
             /usr/local/bin/render-mcp-config.sh \
             /usr/local/bin/post-screenshot.sh \
             /usr/local/bin/send-line-image.sh
```

---

## Bug Fix: Gateway WebSocket Auth (`GATEWAY_TOKEN` vs `GATEWAY_WS_TOKEN`)

### Root cause

The upstream `openab-gateway` binary reads the WebSocket authentication
token from the env var `GATEWAY_WS_TOKEN`. Our `entrypoint.sh` was passing
`GATEWAY_TOKEN` — a name the gateway does not recognize. The container log
showed:

```
WARN openab_gateway: GATEWAY_WS_TOKEN not set — WebSocket connections are NOT authenticated (insecure)
```

This meant the WebSocket link between `openab` core and `openab-gateway` was
running unauthenticated. Any process that could reach `ws://127.0.0.1:8080/ws`
could impersonate the core. Inside a single container with loopback-only
access the blast radius is small, but this is a defense-in-depth gap.

### Fix

**File:** `agent-runtime/scripts/entrypoint.sh`

Changed the env var name passed to the gateway process:

```diff
-GATEWAY_TOKEN="$GATEWAY_TOKEN" \
+GATEWAY_WS_TOKEN="$GATEWAY_TOKEN" \
```

The openab-side config (`token = "${GATEWAY_TOKEN}"` in `openab.toml`) is
unchanged — openab reads the value from the TOML (already expanded by
`render-config.sh`), not from an env var. The HF Space secret name remains
`GATEWAY_TOKEN` — only the export to the gateway process is renamed.

### Verification

After deploy, the container log should **no longer** show the
`GATEWAY_WS_TOKEN not set` warning. Instead the gateway should silently
accept authenticated WebSocket connections.

---

## Cleanup: Removed Telegram Placeholder

### Background

`entrypoint.sh` previously set `TELEGRAM_BOT_TOKEN` to a placeholder string
for LINE-only deployments, based on an assumption that the gateway required
at least one Telegram env var. Upstream code review (May 2026) confirmed
the Telegram adapter is fully optional — the gateway gracefully skips it
when `TELEGRAM_BOT_TOKEN` is unset.

### Change

Removed the placeholder export from `entrypoint.sh`:

```diff
-# openab-gateway requires at least one platform env to be defined even if only
-# LINE is enabled. Set a harmless placeholder for Telegram so it boots; if
-# TELEGRAM_BOT_TOKEN is already set by the operator, keep it.
-export TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-disabled-for-line-only-deploy}"
```

Also removed `TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN"` from the gateway
launch env block (it was never needed).

---

## Upstream Sync Notes (2026-05-13)

Findings from comparing against `openabdev/openab@main`:

### `env_clear()` baseline behavior

OpenAB's `src/acp/connection.rs` always injects `HOME`, `PATH`, and `USER`
after `env_clear()`, before applying `[agent].env`. Our explicit `HOME` and
`PATH` in `[agent].env` override the baseline — this is safe and makes the
values deterministic regardless of upstream changes.

### New upstream features (available but not yet adopted)

| Feature | Config key | Notes |
|---|---|---|
| Per-prompt hard timeout | `pool.prompt_hard_timeout_secs` (default 1800) | Could cap the 192s+ MCP-failure waits |
| Liveness check interval | `pool.liveness_check_secs` (default 30) | Detects stuck agent subprocesses |
| Message processing modes | `gateway.message_processing_mode` | `per-thread` / `per-lane` for group chats |
| Reply-to directive on LINE | `[[reply_to:id]]` | Quote-reply support in gateway platforms |
| Reaction tool display | `reactions.tool_display` | `full` / `compact` / `none` |
| STT echo | `stt.echo_transcript` | Echo voice transcriptions |
| Streaming mode | `gateway.streaming` | Live message editing (LINE does not support) |

### Session TTL

Upstream default is `session_ttl_hours = 4`. We intentionally set `168`
(7 days) for persistent LINE conversations. This is documented and correct.

---

## Verification

After deploying this change to HF Spaces:

1. **Container log** should show:
   ```
   render-mcp-config: merged MCP servers into /home/node/.gemini/settings.json (gemini)
   ```

2. **LINE test** — send "Can you grab andy770921 GitHub repo name for me?
   Only need top 5" via LINE. The agent should respond with a repo list
   (not a web search error) within ~10 seconds.

3. **Health check** — `curl https://andy770921-ai-agent.hf.space/health`
   should return `200 ok`.

## Files Changed Summary

| File | Status | Change |
|---|---|---|
| `agent-runtime/mcp/servers.json` | New | Shared MCP server definitions |
| `agent-runtime/scripts/render-mcp-config.sh` | New | Boot-time LLM config generator |
| `agent-runtime/config/openab.toml` | Modified | Added `HOME`, `PATH`, `PLAYWRIGHT_BROWSERS_PATH` to `[agent].env` |
| `agent-runtime/gemini/settings.json` | Modified | Removed `mcpServers` (now in `mcp/servers.json`) |
| `agent-runtime/scripts/entrypoint.sh` | Modified | Fixed `GATEWAY_WS_TOKEN`, removed Telegram placeholder, added step 2b |
| `agent-runtime/Dockerfile` | Modified | Copies `mcp/servers.json` and `render-mcp-config.sh` |
| `documents/FEAT-3/plans/prd.md` | New | PRD with research and design |
| `documents/FEAT-3/development/universal-mcp-config.md` | New | This file |
