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
| 2026-05-21 | `b114f4b` | MCP errors swallowed + reconnect every call | Tools cache + `console.error` + Langfuse SDK |
| 2026-05-21 | `716de71` | `runtimeContext` never passed to agent | Pass `RuntimeContext` to `agent.generate()` + chmod |
| 2026-05-21 | `588b600` | Zod v4 rejects all 25 Playwright tool schemas | Upgrade `@playwright/mcp` 0.0.30 → 0.0.75 |
| 2026-05-21 | `d2552f3` | Quota errors produce vague user messages | Detect 429/quota at subagent + webhook levels |
| 2026-05-27 | `417ef40` | Subagent tool errors hidden by LLM paraphrase | Log `result.steps` toolCalls/Results to stdout |
| 2026-05-27 | `c9c7ad2` | EACCES on `/ms-playwright/mcp-chrome-for-testing-*` | `chmod a+rwX /ms-playwright` in Dockerfile |
| 2026-05-27 | `0d366fd` | `Browser "chrome-for-testing" is not installed` | Install via MCP's bundled `playwright-core` |
| 2026-05-27 | _this commit_ | Three review-driven hardenings on top of `0d366fd` | Direct `node cli.js` invocation + `WORKDIR /home/node` + dev script parity |

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

6. **Cache MCP tools after first connect.**  Reconnecting per tool call is
   slow and fragile.  Connect once, cache the tool map, reuse.

7. **Always pass `runtimeContext` to `agent.generate()`.**  Without it,
   `createTool` execute functions get `undefined` for `runtimeContext` and
   all `runtimeContext.get()` calls fall through to empty defaults.

8. **Watch for Zod v3/v4 conflicts in the MCP stack.**  `@mastra/mcp` →
   `@modelcontextprotocol/sdk` → Zod v4.  Any MCP server returning schemas
   without `type: "object"` at the `inputSchema` root will be rejected.
   Upgrade the MCP server, not downgrade Zod.

## Issue Details (continued)

### 10. MCP errors swallowed + reconnect every call

**Error:** Intermittent "browser tool unavailable" with no error in HF logs.

**Root cause (errors):** `subagentRunner.ts` catch blocks emitted to the
event bus but never called `console.error`.  Errors were invisible in logs.

**Root cause (reconnect):** `safeListTools()` called `connect()` + `tools()`
on every tool invocation, spawning a new MCP server process each time.

**Fix:**
- Cache tools after first `connect()` in a `Map<string, Record<string, unknown>>`
- Add `console.error` to all catch blocks
- Wire Langfuse SDK (`langfuse` direct, replacing `langfuse-vercel`)
- Trace per LINE message with generation span

Commit: `b114f4b`.

### 11. `runtimeContext` never passed to agent.generate()

**Error:** `parentTools.ts` receives empty `userId`/`sessionId`.

**Root cause:** `runTurn()` called `agent.generate(messages, { maxSteps: 8 })`
without a `runtimeContext` option.  Mastra's `Agent.generate()` creates a
default empty `RuntimeContext` if none is provided.  Tools that call
`runtimeContext.get('userId')` get `undefined`, falling through to `''`.

**Fix:**
```typescript
const runtimeContext = new RuntimeContext();
runtimeContext.set('userId', userId);
runtimeContext.set('sessionId', sessionId);
const result = await agent.generate(messages, { maxSteps: 8, runtimeContext });
```

Also `chmod -R a+rX /usr/local/lib/node_modules/@playwright` in Dockerfile
so `USER node` can access the globally installed MCP modules.

Commit: `716de71`.

### 12. Zod v4 schema validation rejects all Playwright tools

**Error:**
```
$ZodError: tools[*].inputSchema.type expected "object"
  at zod/v4/core/parse.js
  at @modelcontextprotocol/sdk/src/server/zod-compat.ts
```

All 25 Playwright tools rejected.  MCP connects but `tools()` throws.

**Root cause:** `@mastra/mcp` → `@modelcontextprotocol/sdk` uses **Zod v4**.
`@playwright/mcp@0.0.30` returns tool schemas where `inputSchema` lacks
`type: "object"` at the root.  Valid under Zod v3, rejected by Zod v4.

This is the exact Zod v3/v4 conflict predicted in FEAT-4
`design-decisions.md` (open question #3).

**Fix:** Upgrade `@playwright/mcp` from `0.0.30` → `0.0.75` in the
Dockerfile.  The newer version returns Zod v4-compatible schemas.  Chromium
is re-downloaded at build time to match 0.0.75's expected revision.

Commit: `588b600`.

**Verification:**
```
23 tools
browser_navigate: true
browser_install: false
```

### 13. Quota errors produce vague user messages

**Error:** User sees "The browser tool is currently unavailable" or "Sorry,
something went wrong" when Gemini free-tier quota (20 req/day) is exhausted.

**Root cause:** Two error paths lacked quota detection:
- `subagentRunner.ts`: retried the subagent on quota error (wasting more
  quota), then returned raw JSON that the parent LLM interpreted vaguely.
- `webhookHandler.ts`: returned generic "something went wrong" for all
  errors including 429/RESOURCE_EXHAUSTED.

**Fix:** Detect quota errors via regex
(`/quota|rate.?limit|RESOURCE_EXHAUSTED|429/i`) at both levels:
- **Subagent:** skip retry entirely, return `userMessage: "LLM calling limit
  exceeded for today."` — the parent LLM relays this to the user.
- **Webhook handler:** if `runTurn()` itself throws a quota error, reply
  "LLM calling limit exceeded for today. Please try again tomorrow."

Commit: `d2552f3`.

### 14. EACCES on `PLAYWRIGHT_BROWSERS_PATH` after upgrading to MCP 0.0.75

**Error (as reported to the user):** "I am sorry, I was unable to screenshot
the Google homepage. The browser environment encountered a permission error,
preventing it from creating necessary directories."

**Real error (visible only after adding subagent step logging):**
```
[subagent:browser] step 0 call browser_navigate {"url":"https://www.google.com"}
[subagent:browser] step 0 result browser_navigate {"content":[{"type":"text",
  "text":"### Error\nError: EACCES: permission denied,
  mkdir '/ms-playwright/mcp-chrome-for-testing-f53b52a'"}],"isError":true}
```

**Diagnostic gap — why this took two commits to fix:**
`runSubagent()` catches exceptions from `subagent.generate()` and logs them
via `console.error`, but Mastra's `Agent.generate()` does **not** throw when
a sub-tool returns `isError: true`.  Playwright MCP returns the EACCES as a
tool result payload, the subagent's LLM reads it and paraphrases ("permission
error... creating necessary directories") into `result.text`, and the parent
agent forwards that paraphrase to the user.  Outwardly: `ok: true`,
`toolCallCount: 1`, no stderr, no Langfuse error.  The raw EACCES is hidden.

The first commit (`417ef40`) added `logSubagentSteps()` in
`subagentRunner.ts` to dump `result.steps[*].toolCalls` and
`result.steps[*].toolResults` to stdout after every successful subagent run.
This made the EACCES visible on the next request.

**Root cause:** Playwright MCP 0.0.75 — introduced in commit `588b600`
(issue 12) — creates per-session cache directories under
`PLAYWRIGHT_BROWSERS_PATH` (e.g. `/ms-playwright/mcp-chrome-for-testing-<hash>`)
at navigation time, not at install time.  The Dockerfile set
`chmod -R a+rX /ms-playwright` (read + traverse), which is sufficient to
*launch* the pre-installed Chromium but not to *create new subdirectories*.
Since the container runs as `USER node` and `/ms-playwright` is root-owned,
`mkdir` of the per-session cache fails with EACCES.

This is a latent regression from the 0.0.30 → 0.0.75 upgrade: 0.0.30 did
not create per-session dirs in `PLAYWRIGHT_BROWSERS_PATH`, so `a+rX` was
sufficient.

**Fix:** One-character change in the Dockerfile:
```dockerfile
- && chmod -R a+rX /ms-playwright \
+ && chmod -R a+rwX /ms-playwright \
```
`a+rwX` grants read+write to all and execute only on directories /
already-executable files — so the directory becomes writable but harmless
data files don't gain a spurious execute bit.

Single-tenant container; world-write on the browser cache is acceptable.
Alternative `chown -R node:node /ms-playwright` works too but adds a line.

**Verification:** After the fix, the same `[subagent:browser]` log line
should show `browser_navigate` succeeding (no `isError: true`).

### 15. `Browser "chrome-for-testing" is not installed` after the chmod fix

**Error (visible only with the subagent logging from `417ef40`):**
```
[subagent:browser] step 0 result browser_navigate {"content":[{"type":"text",
  "text":"### Error\nError: Browser \"chrome-for-testing\" is not installed.
  Run `npx @playwright/mcp install-browser chrome-for-testing` to install"}],
  "isError":true}
```

The EACCES from issue 14 was gone — the chmod worked — but the next
launch attempt failed because no chrome-for-testing binary was present
at the path MCP looked for.

**Initial misdiagnosis (worth recording):** The error message suggests
running `npx @playwright/mcp install-browser chrome-for-testing`. We
applied that command verbatim to the Dockerfile without verifying it
existed.  No `install-browser` subcommand is documented in the
`@playwright/mcp` README, and Microsoft's own
[v0.0.75 Dockerfile](https://github.com/microsoft/playwright-mcp/blob/v0.0.75/Dockerfile)
uses `npx -y playwright-core install --no-shell chromium` — a different
command entirely.  The MCP error string is misleading; verifying against
upstream's reference Dockerfile is the safer path. (Compare issue 12 in
upstream Playwright #40862, which documents MCP misattributing
unrelated failures to "browser not installed".)

**Root cause:** Two compounding issues:

1. **Playwright 1.57 renamed the chromium build to Chrome-for-Testing.**
   Per the
   [v1.57 release notes](https://playwright.dev/docs/release-notes#version-157),
   "Playwright now runs on Chrome for Testing rather than Chromium.
   Headed mode uses `chrome`; headless mode uses `chrome-headless-shell`."
   The user-facing browser name `chromium` is preserved, but the binary
   downloaded into `PLAYWRIGHT_BROWSERS_PATH` is now a Chrome-for-Testing
   distribution, and the channel-name strings that surface in errors
   refer to "chrome-for-testing".

2. **Our Dockerfile installed browsers with the wrong Playwright
   version.**  The original line was
   `RUN npx --yes playwright install chromium`, which makes `npx --yes`
   download the *latest* `playwright` from npm — *not* the
   `playwright-core@1.61.0-alpha-1778188671000` pinned by
   `@playwright/mcp@0.0.75`.  The browser revision shipped by the latest
   Playwright differs from what MCP's bundled playwright-core expects.
   Result: a chrome-for-testing binary exists under `/ms-playwright/`,
   but at the wrong revision path, so MCP's launch lookup misses it.

This was previously latent (the older version probably installed the
same revision as MCP's bundled core by coincidence) and only surfaced
after the chmod let us reach the launch step.

**Fix (initial in `0d366fd`):** Install browsers using the playwright-core
that ships *with* `@playwright/mcp` so the version matches by
construction:

```dockerfile
RUN cd /usr/local/lib/node_modules/@playwright/mcp \
 && npx --yes playwright-core install --no-shell chromium
```

`cd` puts npx's cwd inside MCP's package directory, so it resolves
`playwright-core` from `./node_modules/.bin/` (MCP's pinned version)
instead of downloading the latest from npm.  This is the verified
pattern used by [microsoft/playwright-mcp's v0.0.75 Dockerfile](https://github.com/microsoft/playwright-mcp/blob/v0.0.75/Dockerfile).

`--no-shell` skips the chrome-headless-shell binary (the legacy headless
variant);  MCP's `--headless` mode uses the full chrome-for-testing
build, so the shell is redundant disk usage.

**Fix (hardened in follow-up):** Three parallel subagent reviews of
`0d366fd` flagged additional concerns:

1. `npx --yes` silently falls back to the npm registry if the nested
   `./node_modules/.bin/playwright-core` symlink ever disappears (npm
   layout change, hoist behavior, etc.). The version-skew bug would
   recur silently instead of failing the build loudly.
2. `WORKDIR /app` at runtime is root-owned and only writable because of
   the global chmod. The same latency pattern as issue 14 (`a+rX`
   working until MCP needed to `mkdir`) is dormant here: if MCP ever
   writes to cwd by default, EACCES returns.
3. The dev-only `agent-runtime/scripts/install-mcp-deps.cjs` postinstall
   hook still ran `npx playwright install chromium`, drifting from the
   Docker pattern and exposing local devs to the same version skew.

Applied in the follow-up commit:

```dockerfile
RUN node /usr/local/lib/node_modules/@playwright/mcp/node_modules/playwright-core/cli.js \
      install --no-shell chromium
…
USER node
WORKDIR /home/node          # was /app
```

```shell
# agent-runtime/scripts/entrypoint.sh
exec node --enable-source-maps /app/dist/server.js   # was dist/server.js
```

```js
// agent-runtime/scripts/install-mcp-deps.cjs
run('npx --yes playwright-core install --no-shell chromium', ...);
```

Direct `node cli.js` removes npx from the chain — if the nested module
path is ever wrong, the build fails immediately with a clear "Cannot
find module" instead of a silent registry download. `WORKDIR /home/node`
pre-empts the latent cwd-writability trap. `entrypoint.sh` uses an
absolute path for `dist/server.js` so the cwd change is decoupled from
where the app code lives. The dev script switches to `playwright-core`
to match the Docker verb; full version-pinning locally is documented
as a known limitation (devs without Docker hit the same skew, but the
postinstall has a graceful fallback and a `PLAYWRIGHT_SKIP_BROWSER_INSTALL`
escape hatch).

**Still deferred (worth tracking):**
- `--no-sandbox` flag on the MCP CLI in `agent-runtime/src/mcp/mcpClients.ts`
  (Microsoft's reference passes it). Currently no surfaced symptom in our
  HF Spaces single-tenant container, but documented expected failure:
  Chromium exits immediately with no useful stderr if the kernel sandbox
  isn't available.
- Long-term: migrate to `FROM mcr.microsoft.com/playwright/mcp:v0.0.75`
  as the runtime base. Eliminates the entire class of bugs in issues
  12–15 by inheriting upstream's verified browser install. Trades our
  `node:22-bookworm-slim` standardization for a registry dependency;
  worth its own design discussion separately.

**Latent issues observed but not yet addressed:**

Microsoft's reference Dockerfile differs from ours in two more ways
that are unrelated to issue 15 but should be evaluated independently:

- `WORKDIR /home/node` in their runtime stage — MCP may need a writable
  cwd to create default output directories.  Our `WORKDIR /app` is
  owned by root and writable only because of the global chmod.  If MCP
  ever writes to cwd by default, this could regress.
- `--no-sandbox` flag on the MCP CLI — required when running Chromium
  as non-root without a kernel sandbox set up.  Our setup currently
  works without it (we have no surfaced symptom), so deferring.

## Key Learnings (continued)

9. **Detect quota errors early and skip retry.**  Retrying a 429 wastes the
   remaining quota budget.  Return a clear user-facing message immediately.

10. **Subagent tool errors are invisible by default.**  Mastra's
    `Agent.generate()` only throws on infrastructure failures — a tool that
    returns `isError: true` is treated as a successful step, and the LLM is
    free to paraphrase the error into a soft natural-language reply.  Always
    instrument `result.steps[*].toolCalls` / `toolResults` to stdout (or
    Langfuse child spans) so raw MCP/tool payloads survive the LLM's
    summarisation.  Without this, even `console.error` and Langfuse traces
    will be silent.

11. **MCP version bumps can change runtime filesystem layout.**  Playwright
    MCP 0.0.75 moved per-session cache from a transient location into
    `PLAYWRIGHT_BROWSERS_PATH`.  Whenever upgrading an MCP server, re-check
    that every directory it writes to at runtime is writable by the non-root
    container user — not just readable.

12. **Trust upstream's reference Dockerfile over error-message hints.**
    MCP error strings frequently suggest commands that do not actually
    exist (issue 15: a suggested `install-browser` subcommand has no
    matching code path).  When a runtime error proposes a fix, cross-check
    against the project's own Dockerfile / CI config tagged to the exact
    version you are running, *before* applying it to production.

13. **`npx --yes <pkg>` ignores nested node_modules.**  `npx --yes
    playwright install` downloads the latest `playwright` from npm rather
    than resolving the version already on disk under
    `node_modules/<somewhere>`.  When a tool re-uses a pinned helper
    (e.g. `playwright-core` bundled inside `@playwright/mcp`), the
    pinned helper must be invoked from a cwd where npx finds it locally
    — and even then, prefer the bin's absolute path: `node …/cli.js …`
    fails loudly when the path is wrong, whereas `npx --yes` silently
    re-downloads from the registry, masking the regression.

14. **Run multi-agent review on infra changes before pushing.**  Three
    parallel subagent reviews (build correctness, strategy, collateral
    scan) caught two material issues that the implementer missed:
    the silent-fallback hole in `npx --yes`, and the latent cwd-writability
    trap that would have recurred as issue 16.  Cost: ~one minute of
    elapsed time. Benefit: one fewer deploy cycle.

## Current State

All 15 issues fixed across 17 commits (16 main + 1 review-driven hardening).

**Verified working (HF log 2026-05-21):**
```
playwright-mcp: OK (/usr/local/lib/node_modules/@playwright/mcp/cli.js)
github-mcp: OK (/usr/local/bin/github-mcp-server)
[langfuse] enabled
[mcp] browser connected: 23 tools       ← MCP fully working
[subagent] task_browser attempt 1...     ← subagent invoked correctly
  Quota exceeded... limit: 20           ← Gemini free-tier limit (not a code bug)
```

**Surfaced after subagent step logging (HF log 2026-05-27, before issue 14 fix):**
```
[subagent:browser] step 0 call browser_navigate {"url":"https://www.google.com"}
[subagent:browser] step 0 result browser_navigate {... EACCES /ms-playwright/...}
```
Diagnosed as issue 14, fixed by chmod (`c9c7ad2`).

**Surfaced after issue 14 fix (HF log 2026-05-27, before this commit):**
```
[subagent:browser] step 0 result browser_navigate {...
  Error: Browser "chrome-for-testing" is not installed. ...}
```
Diagnosed as issue 15 (Playwright 1.57 chromium → chrome-for-testing
rename + `npx --yes playwright` version drift), fixed by switching to
MCP's bundled `playwright-core` in this commit.

**Pending:** Live re-test after HF Space rebuild to confirm
`browser_navigate` succeeds and end-to-end screenshot delivery via
`send_image` works.
