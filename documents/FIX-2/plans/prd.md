# PRD: Playwright MCP Tool Routing — From Gemini CLI to Mastra

> **Status: Superseded by FEAT-4.** FIX-2 was originally scoped as a
> Gemini CLI config tweak.  During implementation, the root causes turned
> out to be deeper than config — they required the FEAT-4 Mastra rewrite
> to resolve.  This document now serves as the full troubleshooting record.

## Problem Statement

The LINE agent cannot use Playwright MCP tools for browser tasks.  When a
user asks for a screenshot, the agent replies "The browser tool is currently
unavailable" instead of navigating and screenshotting.

## Root Cause Analysis

Investigation revealed **two layers** of issues: the original Gemini CLI
layer (addressed by FEAT-4's removal of OpenAB) and a new Mastra MCP
integration layer discovered during the FEAT-4 cutover.

### Layer 1: Gemini CLI + OpenAB (historical — removed by FEAT-4)

Three independent issues combined:

1. **Policy Engine `deny` ineffective in ACP mode.**  Gemini CLI's Policy
   Engine sets `deny` rules for unwanted built-in tools.  In `--acp` mode
   (spawned by OpenAB), deny decisions are forwarded as ACP permission
   prompts.  OpenAB auto-approves every request with `proceed_once`:
   ```
   auto-respond permission title="pip list"
     outcome={"outcome":{"optionId":"proceed_once","outcome":"selected"}}
   ```
   Evidence: `run_shell_command` (pip list, ls -la), `web_fetch`, and
   `google_web_search` all executed despite deny rules.

2. **Tool name mismatch in policy.**  Policy denied `web_search` but the
   actual Gemini CLI tool is `google_web_search`.  Rule never matched.

3. **Model prefers familiar built-in tools.**  The Gemini Flash model sees
   all 30+ tool schemas (built-in + MCP) and defaults to built-in tools it
   was trained on, ignoring MCP tools.

**Resolution:** FEAT-4 removed OpenAB + Gemini CLI entirely.  The Mastra
agent only exposes three parent tools (`task_browser`, `task_github`,
`send_image`), eliminating tool confusion at the architecture level.

### Layer 2: Mastra MCP Integration (discovered during FEAT-4 cutover)

After the Mastra rewrite deployed, Playwright MCP still failed.  Five
sequential issues were diagnosed and fixed:

#### Issue 2a: `MastraMCPClient.getTools()` not a function

**Symptom:** `[mcp] browser not available: TypeError: client.getTools is not
a function`

**Cause:** `MastraMCPClient` requires `connect()` to spawn the stdio
subprocess before `tools()` can be called.  The code called `getTools()`
directly on an unconnected client.

**Fix:** Call `connect()` before `tools()` in `safeListTools()`.
Commit: `70ddb85`.

#### Issue 2b: MCP subprocess missing environment variables

**Symptom:** `browser_install` tool called by LLM and times out.  MCP
connects but Chromium not found.

**Cause:** `MastraMCPClient`'s `env` field **replaces** the subprocess
environment entirely.  The old code only passed `PLAYWRIGHT_BROWSERS_PATH`,
missing `PATH`, `HOME`, and all other vars.  The Playwright MCP server
couldn't locate Chromium at `/ms-playwright`.

**Fix:** Spread `...process.env` as the base environment.
Commit: `e47a3d8`.

#### Issue 2c: @playwright/mcp version mismatch (local vs global)

**Symptom:** LLM calls `browser_install` (which times out) instead of
`browser_navigate`.  `browser_install` tool appears in tool list.

**Cause:** `package.json` had `"@playwright/mcp": "^0.0.30"` which resolved
to v0.0.75 in `node_modules`.  `npx` picked the local (newer) version
instead of the globally installed v0.0.30.  The newer version expects a
different Chromium revision than what was installed, so it exposed
`browser_install` as a recovery tool.

**Fix:** Removed `@playwright/mcp` from `package.json` (it's only used as a
CLI, never imported as a library).  Commit: `a87806e`.

**Local verification:** After fix, `browser_install` disappeared from tool
list:
```
Playwright OK: 23 tools, browser_navigate: true, browser_install: false
```

#### Issue 2d: `npx --no-install` can't find global package as USER node

**Symptom:** `npx canceled due to missing packages and no YES option:
["@playwright/mcp@0.0.75"]`

**Cause:** `npm install -g` runs as root during Docker build.  The app runs
as `USER node`.  `npx --no-install` as the `node` user can't resolve
packages in root's global prefix.

**Fix:** Changed to use the binary symlink at
`/usr/local/bin/mcp-server-playwright`.  Commit: `b34a3da`.

#### Issue 2e: Binary symlink not resolving (suspected)

**Symptom:** No MCP error in logs at all.  Agent replies "browser tool is
currently unavailable" silently.

**Cause:** The symlink at `/usr/local/bin/mcp-server-playwright` may not
resolve correctly when running as `USER node`, or the binary name differs
across npm versions.

**Fix:** Use `node /usr/local/lib/node_modules/@playwright/mcp/cli.js`
directly — bypasses all npx/symlink/global-prefix issues.  Added startup
diagnostics that log whether the MCP binary exists.  Commit: `87a433f`.

#### Issue 2f: MCP tools reconnect every call + errors swallowed

**Symptom:** Intermittent "browser tool unavailable" with no error in HF
logs.

**Cause (errors):** `subagentRunner.ts` catch blocks emitted to the event
bus but never called `console.error`.  Errors were invisible in HF logs.

**Cause (reconnect):** `safeListTools()` called `connect()` + `tools()` on
every tool invocation, spawning a new MCP server process each time.  Slow
and fragile.

**Fix:** (1) Cache tools after first `connect()` — reuse across calls.
(2) Add `console.error` to all catch blocks.  (3) Wire Langfuse SDK for
tracing (replaced `langfuse-vercel` with `langfuse` direct SDK).
Commit: `b114f4b`.

#### Issue 2g: `runtimeContext` never passed to agent.generate()

**Symptom:** `parentTools.ts` receives empty `userId`/`sessionId` because
`runtimeContext?.get('userId')` falls through to `''`.

**Cause:** `runTurn()` called `agent.generate(messages, { maxSteps: 8 })`
without passing `runtimeContext`.  Mastra's `Agent.generate()` accepts a
`runtimeContext` option that tools access via `execute({ runtimeContext })`.

**Fix:** Create `RuntimeContext` with userId/sessionId and pass to
`agent.generate()`.  Also `chmod -R a+rX` on global `@playwright` modules
for `USER node` access.  Commit: `716de71`.

#### Issue 2h: Zod v4 schema validation rejects all Playwright tools

**Symptom:** MCP connects successfully but `tools()` throws `$ZodError` —
all 25 tools rejected with `inputSchema.type expected "object"`.

**Cause:** `@mastra/mcp` depends on `@modelcontextprotocol/sdk` which uses
**Zod v4**.  `@playwright/mcp@0.0.30` returns tool schemas where
`inputSchema` lacks `type: "object"` at the root — valid under Zod v3 but
rejected by Zod v4's strict validation.  This is the exact Zod v3/v4
conflict predicted in FEAT-4 `design-decisions.md`.

**Fix:** Upgrade `@playwright/mcp` from `0.0.30` → `0.0.75` in the
Dockerfile global install.  The newer version returns Zod v4-compatible
schemas.  Chromium is re-downloaded at build time to match the new version's
expected revision.  Commit: `588b600`.

**Local verification:**
```
23 tools
browser_navigate: true
browser_install: false
```

## Solution Overview

FIX-2's original scope (system prompt + policy TOML tweaks) was **superseded
by FEAT-4**, which solved the problem architecturally:

| Approach | What it does | Status |
|----------|-------------|--------|
| FIX-2 original | Strengthen system prompt + fix policy TOML | Superseded — files deleted by FEAT-4 |
| FEAT-4 | Remove OpenAB/Gemini CLI; use Mastra with 3 parent tools | Deployed |
| FEAT-4 MCP fixes | Fix connect, env, version, binary path, cache, runtimeContext, Zod v4 | 8 commits deployed |

## Files Changed (final, cumulative)

| File | Change |
|------|--------|
| `agent-runtime/src/mcp/subagentRunner.ts` | `connect()` before `tools()`; tools cache; `console.error` in catch |
| `agent-runtime/src/mcp/mcpClients.ts` | `...process.env`; `node` + absolute `cli.js` path on Linux |
| `agent-runtime/src/agent/runTurn.ts` | Pass `RuntimeContext` (userId, sessionId) to `agent.generate()`; Langfuse trace |
| `agent-runtime/src/observability/langfuse.ts` | New — Langfuse SDK singleton + flush |
| `agent-runtime/package.json` | Removed `@playwright/mcp` + `@repo/shared`; `langfuse-vercel` → `langfuse` |
| `agent-runtime/src/server.ts` | Startup MCP diagnostics + Langfuse init |
| `agent-runtime/Dockerfile` | Removed Rust/OpenAB; `@playwright/mcp@0.0.75` + Chromium; chmod |
| `agent-runtime/gemini/` | Entire directory deleted (FEAT-4) |
| `agent-runtime/config/openab.toml` | Deleted (FEAT-4) |

## Testing Strategy

### Startup verification (HF logs)

```
agent-runtime listening on :7860
playwright-mcp: OK (/usr/local/lib/node_modules/@playwright/mcp/cli.js)
github-mcp: OK (/usr/local/bin/github-mcp-server)
```

### Positive tests

1. Send LINE message: "Screenshot google.com" → expect image reply.
2. Langfuse trace shows `task_browser` → subagent calls `browser_navigate` +
   `browser_take_screenshot`.

### Negative tests

3. Agent should never call `web_fetch`, `google_web_search`,
   `run_shell_command`, or `browser_install`.

### Local verification (run before deploy)

```bash
env $(grep -v '^#' .env | grep -v '^$' | xargs) npx tsx -e '
import { playwrightMcp } from "./src/mcp/mcpClients.ts";
(async () => {
  await (playwrightMcp as any).connect();
  const tools = await (playwrightMcp as any).tools();
  console.log(Object.keys(tools).length, "tools");
  console.log("browser_navigate:", Object.keys(tools).includes("browser_navigate"));
  await (playwrightMcp as any).disconnect();
  process.exit(0);
})();
'
```

Expected: `23 tools`, `browser_navigate: true`.

## Status

- [x] Planning
- [x] In Development (superseded by FEAT-4)
- [ ] Complete — pending live verification of `588b600` (Zod v4 fix)
