# Implementation Log: Playwright MCP Tool Routing Fix

> This document evolved from a planned Gemini CLI config fix into a full
> troubleshooting log.  The original FIX-2 scope (system prompt + policy
> TOML) was superseded by FEAT-4 (Mastra rewrite).  During the FEAT-4
> cutover, five additional MCP integration issues were discovered and fixed
> sequentially.

## Timeline

| Date | Commit | Issue | Fix |
|------|--------|-------|-----|
| 2026-05-19 | `3689817` | FIX-2 original: system.md + policy TOML | Strengthen system prompt, fix tool names |
| 2026-05-19 | `1a05d92` | FEAT-4: remove OpenAB + Gemini CLI | Full Mastra rewrite cutover |
| 2026-05-20 | `3092a52` | `@repo/shared` not found in HF build | Inline AgentEvent types, remove workspace dep |
| 2026-05-20 | `b22dda5` | `postinstall` script not found in Docker | `--ignore-scripts` on both npm install stages |
| 2026-05-20 | `849e7ad` | HF Space root URL returns 404 | Add `GET /` route |
| 2026-05-20 | `70ddb85` | `getTools is not a function` | Call `connect()` before `tools()` |
| 2026-05-20 | `e47a3d8` | MCP subprocess can't find Chromium | Spread `...process.env` to subprocess |
| 2026-05-20 | `a87806e` | `browser_install` tool exposed (version mismatch) | Remove `@playwright/mcp` from package.json |
| 2026-05-20 | `b34a3da` | `npx --no-install` can't find global package | Use absolute binary path |
| 2026-05-20 | `87a433f` | Binary symlink not resolving as USER node | Use `node cli.js` directly + startup diagnostics |

## Issue Details

### 1. FIX-2 Original: Gemini CLI Config (superseded)

**Files changed:** `agent-runtime/gemini/system.md`,
`agent-runtime/gemini/policies/tool-allowlist.toml`

**What was done:**
- Rewrote `# Tools` section with explicit Playwright tool names and
  screenshot workflow
- Added "Prohibited tools" section with numbered rules
- Fixed `web_search` → `google_web_search` name mismatch in policy
- Added `list_directory` deny rule

**Why superseded:** FEAT-4 deleted the entire `gemini/` directory and
replaced the Gemini CLI + OpenAB stack with Mastra.  The system prompt moved
to Supabase `agent_config` table, and tool routing is now handled by Mastra's
subagent dispatch (only 3 parent tools visible to the LLM).

### 2. `@repo/shared` Not Found in HF Build

**Error:** `npm error 404 '@repo/shared@*' is not in this registry`

**Root cause:** `agent-runtime` is deployed standalone to HF Spaces (only
`agent-runtime/` contents are synced).  The `@repo/shared` workspace package
doesn't exist in that context.

**Fix:** Inlined the `AgentEvent` types (10 lines) directly in
`src/observability/sse.ts`.  Removed `@repo/shared` from `package.json`.

### 3. `postinstall` Script Not Found in Docker Build

**Error:** `Cannot find module '/app/scripts/install-mcp-deps.cjs'`

**Root cause:** `npm install` triggers `postinstall` which runs
`scripts/install-mcp-deps.cjs`.  But the Dockerfile only copies
`package.json` before `npm install` — scripts aren't copied yet.

**Fix:** Added `--ignore-scripts` to both `npm install` calls in the
Dockerfile.  Chromium is installed globally via
`npx playwright install chromium` earlier in the Dockerfile, so the
postinstall hook (which downloads Chromium for local dev) is unnecessary.

### 4. HF Space Root URL Returns 404

**Error:** HF Space UI shows "404 Not Found" when visiting the Space page.

**Root cause:** The old `hf-proxy.js` returned a status page at `/`.  The
new `src/server.ts` had no route for `/`.

**Fix:** Added `app.get('/', (c) => c.text('agent-runtime ok'))`.

### 5. `MastraMCPClient.getTools()` Not a Function

**Error:** `[mcp] browser not available: TypeError: client.getTools is not a
function`

**Root cause:** `MastraMCPClient` requires `connect()` to spawn the stdio
subprocess before tool listing works.  The code called `getTools()` on an
unconnected client.

**Fix in `subagentRunner.ts`:**
```typescript
// Before (broken):
return await (client as any).getTools();

// After (working):
await (client as any).connect();
return await (client as any).tools();
```

### 6. MCP Subprocess Can't Find Chromium

**Error:** LLM calls `browser_install` tool which times out after 60s.

**Root cause:** `MastraMCPClient`'s `env` field replaces the subprocess
environment entirely.  The old code only passed `PLAYWRIGHT_BROWSERS_PATH`:

```typescript
env: {
  ...(process.env.PLAYWRIGHT_BROWSERS_PATH
    ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH }
    : {}),
}
```

The subprocess lost `PATH`, `HOME`, and couldn't find Chromium.

**Fix:** Spread the full parent environment:
```typescript
env: { ...process.env } as Record<string, string>
```

### 7. @playwright/mcp Version Mismatch

**Error:** Same `browser_install` timeout, but now with full env.

**Root cause:** `package.json` had `"@playwright/mcp": "^0.0.30"` which
resolved to v0.0.75 in `node_modules`.  `npx` picked the local version.
v0.0.75 expects a different Chromium revision than the globally installed
v0.0.30, so it exposed `browser_install` as a recovery mechanism.

**Verification:**
```
# With local v0.0.75 (broken):
23 tools, browser_install: true, browser_navigate: true

# With global v0.0.30 (working):
23 tools, browser_install: false, browser_navigate: true
```

**Fix:** Removed `@playwright/mcp` from `package.json`.  It's only used as a
CLI tool (spawned by MastraMCPClient), never imported as a library.

### 8. `npx --no-install` Fails as USER node

**Error:** `npx canceled due to missing packages and no YES option`

**Root cause:** `npm install -g @playwright/mcp@0.0.30` runs as root during
Docker build.  The app runs as `USER node`.  `npx --no-install` can't
resolve packages in root's global npm prefix when running as another user.

**Fix:** Changed to absolute binary path:
`/usr/local/bin/mcp-server-playwright`.

### 9. Binary Symlink Not Resolving (suspected)

**Error:** No MCP error in logs at all.  Agent silently replies "browser
tool is currently unavailable".

**Root cause (suspected):** The npm-created symlink at
`/usr/local/bin/mcp-server-playwright` may not resolve correctly, or the
`console.warn` was lost in HF log buffering.

**Fix:** Use `node` with the absolute module path, bypassing all
npx/symlink/binary resolution:

```typescript
// mcpClients.ts
command: isDocker ? 'node' : 'npx',
args: isDocker
  ? ['/usr/local/lib/node_modules/@playwright/mcp/cli.js',
     '--browser', 'chromium', '--headless']
  : ['@playwright/mcp', '--browser', 'chromium', '--headless'],
```

Added startup diagnostics in `server.ts`:
```typescript
import { existsSync } from 'node:fs';
console.log(`playwright-mcp: ${existsSync(mcpBin) ? 'OK' : 'MISSING'}`);
```

## Key Learnings

1. **`MastraMCPClient` env replaces, not merges.**  Always spread
   `process.env` as the base.

2. **`npx` global resolution is user-scoped.**  Packages installed as root
   via `npm install -g` are invisible to `npx --no-install` when running as
   a different user.  Use absolute paths in Docker.

3. **Playwright MCP versions pin Chromium revisions.**  A `^0.0.30` semver
   range can resolve to a version expecting a completely different Chromium
   binary.  Pin the exact version or don't include it in `package.json`.

4. **Always verify MCP locally before deploying.**  The local verification
   script catches issues in seconds vs. a 5-minute Docker rebuild cycle:
   ```bash
   env $(grep -v '^#' .env | grep -v '^$' | xargs) npx tsx -e '
   import { playwrightMcp } from "./src/mcp/mcpClients.ts";
   (async () => {
     await (playwrightMcp as any).connect();
     const tools = await (playwrightMcp as any).tools();
     console.log(Object.keys(tools).length, "tools");
     process.exit(0);
   })();
   '
   ```

5. **Add startup diagnostics for critical binaries.**  A single
   `existsSync()` check at startup saves hours of log-chasing.

## Current State

All fixes committed and pushed.  Pending live verification on HF Spaces that
the startup log shows:
```
playwright-mcp: OK (/usr/local/lib/node_modules/@playwright/mcp/cli.js)
github-mcp: OK (/usr/local/bin/github-mcp-server)
```

And that a "screenshot google.com" LINE message produces an actual image.
