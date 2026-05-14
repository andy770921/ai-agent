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

## Out of Scope (Phase 1)

- Multi-LLM concurrency (only one CLI runs at a time).
- MCP server health monitoring or auto-restart (rely on LLM CLI's built-in
  MCP lifecycle).
- VS Code / Zed config generation (not used in the container).
- Adopting new upstream features (tracked for future work).

---

## Phase 2: MCP Env Fix & Langfuse Observability (2026-05-14)

### Problem 1: MCP Servers Still Not Working After Phase 1 Deployment

Despite the `env_clear()` fix in Phase 1 (adding `HOME`, `PATH`,
`PLAYWRIGHT_BROWSERS_PATH` to `[agent].env`), MCP servers remain
non-functional. End-to-end testing on 2026-05-13 showed the agent falling
back to `web_search` (denied by policy at priority 800) instead of using the
GitHub MCP server.

Screenshot evidence: the LINE bot replied with "I apologize, but I was unable
to retrieve the GitHub repository names for 'andy770921' because the web
search tool encountered a quota error." The `agent_dispatch_ms` was 224 462 ms
(~3.7 min), indicating prolonged retry/timeout cycles before the fallback.

#### Root cause: env var expansion syntax in `mcp/servers.json`

`mcp/servers.json` uses `"${GITHUB_PERSONAL_ACCESS_TOKEN}"` (curly-brace
syntax). Gemini CLI's documented env expansion format is `"$VAR_NAME"`
(without curly braces). The unexpanded token string is passed literally to
`github-mcp-server`, which fails to authenticate against `api.github.com`
and silently disconnects. The agent then has no GitHub tools available and
falls back to `web_search`.

**Fix:** Change env references from `"${VAR}"` to `"$VAR"` in
`mcp/servers.json`.

### Problem 2: No Observability Into Agent Tool Usage

The current telemetry pipeline (`events-emitter.js` → `healthz.js` → SSE)
captures events in an in-memory ring buffer with:
- No persistent storage — events are lost on container restart.
- No search or filtering — debugging requires reading raw JSON.
- No visibility when MCP servers fail to connect — silent failures.
- No trace visualization — cannot see the full conversation flow.

#### Decision: Langfuse (Cloud, JP Region)

After evaluating five observability platforms:

| Option | Fit | Reason |
|---|---|---|
| **Langfuse** ✅ | Best | OTEL-native in v3, JS SDK, free tier 50k obs/mo, self-hostable |
| LangSmith | Poor | LangChain-centric, no native OTEL receiver, needs adapter |
| Jaeger | OK | Standard OTEL but no LLM-specific features (cost, tokens) |
| Helicone | Poor | Proxy model incompatible with Gemini CLI |
| Braintrust | OK | Needs SDK adapter, more evaluation-focused |

**Langfuse instance details:**
- Organization: "AI agent"
- Project: "line-ai-agent"
- Base URL: `https://jp.cloud.langfuse.com`
- Region: JP
- Plan: Hobby (free — 50k observations/month)

#### Integration approach

Leverage the existing telemetry pipeline — no new Gemini CLI env vars, no
OTEL endpoint configuration. The Node sidecar (`healthz.js`) already receives
parsed `AgentEvent` objects from `events-emitter.js`. Add the Langfuse JS SDK
(`langfuse` npm package) to forward events to Langfuse Cloud.

The Langfuse SDK auto-flushes in batches, so there is no performance impact
on the sidecar's SSE streaming. If `LANGFUSE_SECRET_KEY` is not set, the
integration is silently disabled — the sidecar works exactly as before.

#### Data model mapping

| AgentEvent type | Langfuse concept | Details |
|---|---|---|
| `message_in` | `trace` (create) + `generation` (start) | One trace per turn; sessionId = LINE userId |
| `tool_call` | `span` (start) | Tool name as span name, args as input |
| `tool_result` | `span` (end) | Duration, ok/error status, error message |
| `message_out` | `generation` (end) + `trace` (update) | Response text as output |

### New environment variables (required for Langfuse)

| Variable | Who reads | Example |
|---|---|---|
| `LANGFUSE_SECRET_KEY` | healthz.js (sidecar) | `sk-lf-...` |
| `LANGFUSE_PUBLIC_KEY` | healthz.js (sidecar) | `pk-lf-...` |
| `LANGFUSE_BASE_URL` | healthz.js (sidecar) | `https://jp.cloud.langfuse.com` |

These are set as HF Space secrets and passed to the sidecar process in
`entrypoint.sh`. They are NOT passed to the Gemini CLI agent subprocess.

### Out of scope (Phase 2)

- Token usage / cost tracking (Gemini telemetry does not expose token counts).
- OTEL-native Gemini → Langfuse pipeline (would require additional Gemini
  telemetry env vars; rejected per user preference).
- Langfuse prompt management (agent uses `gemini/system.md` directly).
- Langfuse evaluations / scoring (future work).

### Status

- [x] Phase 1: Universal MCP config + env_clear fix
- [x] Phase 2: MCP env fix + Langfuse observability (see `development/fix-mcp-env-and-langfuse-pipeline.md`)
