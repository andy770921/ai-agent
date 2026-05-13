# FEAT-3: Universal MCP Server Configuration

## Problem Statement

The FEAT-1 agent-runtime hard-wires MCP server definitions inside
`gemini/settings.json`, coupling the MCP inventory to a single LLM CLI.
When the operator switches from Gemini CLI to Claude Code or OpenAI Codex CLI,
every MCP server must be manually re-declared in the new CLI's proprietary
config format. Adding a new MCP server likewise requires editing the
LLM-specific file, which is easy to forget when the active CLI changes.

A secondary issue surfaced during end-to-end testing: OpenAB's `env_clear()`
strips the subprocess environment before injecting only the keys listed in
`[agent].env`. The original `[agent].env` omitted `HOME`, `PATH`, and
`PLAYWRIGHT_BROWSERS_PATH`, so the Gemini CLI subprocess could not locate
`~/.gemini/settings.json`, could not find `github-mcp-server` or `npx` on
`PATH`, and could not find the Chromium binary. The result was that MCP
servers silently failed to start, causing the agent to fall back to
`web_search` (which the policy engine denies), producing user-visible errors.

## Research: MCP Configuration Across LLM CLIs

### Configuration formats by client

| Client | Config file(s) | Root key | Format |
|---|---|---|---|
| Gemini CLI | `~/.gemini/settings.json` | `"mcpServers"` | JSON |
| Claude Code | `.mcp.json` (project) / `~/.claude.json` (user) | `"mcpServers"` | JSON |
| Claude Desktop | `~/Library/Application Support/Claude/claude_desktop_config.json` | `"mcpServers"` | JSON |
| Cursor | `.cursor/mcp.json` / `~/.cursor/mcp.json` | `"mcpServers"` | JSON |
| VS Code Copilot | `.vscode/mcp.json` | `"servers"` | JSON |
| OpenAI Codex CLI | `~/.codex/config.toml` | `[mcp_servers.<name>]` | TOML |
| Zed | `~/.config/zed/settings.json` | `"context_servers"` | JSON |

Key observation: ~80% of clients use the same `"mcpServers"` JSON schema.
Only Codex (TOML) and VS Code/Zed (different key names) diverge.

### Evaluated approaches

#### A. MCP proxy/hub (mcpproxy-go, MetaMCP, supergateway)

Multiple open-source projects aggregate MCP servers behind a single HTTP
endpoint so every client connects to one URL:

- **mcpproxy-go** — local desktop proxy, central config at
  `~/.mcpproxy/mcp_config.json`, exposes `localhost:8080/mcp/`.
- **MetaMCP** — team-oriented aggregator with namespaces, middleware, OAuth.
- **supergateway** — transport bridge (stdio to SSE/WebSocket).
- **Docker MCP Gateway / Microsoft MCP Gateway** — enterprise/K8s solutions.

**Rejected for FEAT-3** because they add another long-running process inside
the container (more failure surface, more memory on a resource-constrained
HF Space), and the container only ever runs one LLM CLI at a time — there is
no multi-client fan-out to justify a proxy.

#### B. Single source of truth + boot-time config generation (chosen)

Maintain one canonical `mcp/servers.json` that is LLM-agnostic. A lightweight
shell script at container boot reads an `AGENT_CLI` env var and merges the
MCP definitions into whichever CLI's config format is active.

**Advantages:**
- Zero extra processes.
- Adding a new MCP server = editing one file; every LLM picks it up.
- Switching LLMs = changing `AGENT_CLI` and `[agent].command`; MCP config
  follows automatically.
- The merge script is ~60 lines of shell + inline Node (no new deps; the
  `node` binary is already in the image).

## Design

### New files

| File | Purpose |
|---|---|
| `agent-runtime/mcp/servers.json` | Canonical MCP server definitions (LLM-agnostic) |
| `agent-runtime/scripts/render-mcp-config.sh` | Boot-time script that merges `servers.json` into the active LLM's config |

### Modified files

| File | Change |
|---|---|
| `agent-runtime/gemini/settings.json` | Removed `"mcpServers"` block (now sourced from `mcp/servers.json`) |
| `agent-runtime/config/openab.toml` | Added `HOME`, `PATH`, `PLAYWRIGHT_BROWSERS_PATH` to `[agent].env` |
| `agent-runtime/scripts/entrypoint.sh` | Calls `render-mcp-config.sh` at step 2b |
| `agent-runtime/Dockerfile` | Copies `mcp/servers.json` and `render-mcp-config.sh` into the image |

### Boot flow

```
entrypoint.sh
  ├─ 1. Validate required env vars
  ├─ 2. render-config.sh   → expands ${VAR} in openab.toml
  ├─ 2b. render-mcp-config.sh  → merges mcp/servers.json into LLM config
  │       ├─ AGENT_CLI=gemini  → merge into ~/.gemini/settings.json
  │       ├─ AGENT_CLI=claude  → write ~/.mcp.json
  │       └─ AGENT_CLI=codex   → convert to TOML, write ~/.codex/config.toml
  ├─ 3. Start openab-gateway (background)
  ├─ 4. Start Node sidecar (background)
  ├─ 4b. Start hf-proxy if HF_SPACE=1
  └─ 5. Start openab core
```

### Switching LLMs (future)

1. Set HF Space variable `AGENT_CLI=claude` (or `codex`).
2. Change `[agent].command` in `openab.toml` (e.g., `claude` or `codex`).
3. Adjust `[agent].args` as needed.
4. `mcp/servers.json` requires **no changes** — the boot script handles
   format conversion.

### Adding a new MCP server

1. Edit `mcp/servers.json` — add the new server entry.
2. If the server binary needs installing, add the install step to `Dockerfile`.
3. If the server needs env vars, add them to `[agent].env` in `openab.toml`
   and to the HF Space secrets.
4. Optionally update `gemini/policies/feat1.toml` to allowlist the new
   `mcpName`.
5. Push — GitHub Actions syncs to HF Space, container rebuilds, done.

## Bugs Found During Implementation

### Gateway WebSocket auth (critical)

The upstream `openab-gateway` binary reads `GATEWAY_WS_TOKEN` from env for
WebSocket authentication. Our `entrypoint.sh` was exporting `GATEWAY_TOKEN`
— a name the gateway ignores. The WebSocket link between openab core and
the gateway was running unauthenticated. Fixed by renaming the export.

### Telegram placeholder (cleanup)

The entrypoint set a placeholder `TELEGRAM_BOT_TOKEN` based on an outdated
assumption. Upstream code confirmed the Telegram adapter is fully optional.
Removed the placeholder.

## Upstream Sync (2026-05-13)

Comparison against `openabdev/openab@main` revealed:

- `env_clear()` auto-injects `HOME`, `PATH`, `USER` as baseline before
  `[agent].env`. Our explicit overrides are safe and deterministic.
- New features available: `prompt_hard_timeout_secs`, `liveness_check_secs`,
  `message_processing_mode`, `[[reply_to]]` on LINE, `tool_display` in
  reactions. None adopted yet — documented for future use.
- New adapters: WeCom, Feishu voice STT, Google Chat, Teams (not needed).
- Session TTL default is 4h upstream; we intentionally use 168h.

## Out of Scope

- Multi-LLM concurrency (only one CLI runs at a time).
- MCP server health monitoring or auto-restart (rely on LLM CLI's built-in
  MCP lifecycle).
- VS Code / Zed config generation (not used in the container).
- Adopting new upstream features (tracked for future work).
