# Implementation Plan: Acceptance Tests (Playwright + GitHub MCP)

## Overview

The first two MCPs in scope for FEAT-4 are Playwright (browser
automation) and GitHub (repo / PR / issue read). This doc defines:

1. The conversation fixtures that prove each MCP works end-to-end
   through the new stack (LINE webhook → Mastra parent → subagent →
   MCP → reply).
2. The pass/fail criteria for each fixture.
3. A debug checklist when a fixture fails.
4. A **local dev setup** for both MCPs so `npm run dev` outside Docker
   does not break — addresses the `--no-install` gotcha noted in
   `mcp-subagent-dispatch.md`.

The fixtures here map to **PRD Success Criterion #2** (Playwright
works) and serve as the smoke test before cutover (week 5).

## Files to Modify

- `agent-runtime/tests/acceptance/playwright.fixture.json` — new;
  LINE webhook payload + expected reply shape
- `agent-runtime/tests/acceptance/github.fixture.json` — new
- `agent-runtime/tests/acceptance/runner.ts` — new; loads a fixture,
  posts a signed payload to `http://localhost:7860/webhook/line`,
  asserts the reply
- `agent-runtime/package.json` — add `@playwright/mcp` as a runtime
  dependency (not just global), add `postinstall` script
- `agent-runtime/scripts/install-mcp-deps.cjs` — new; runs Chromium +
  optional GitHub MCP install on `npm install`
- Reference updates: `mcp-subagent-dispatch.md` Step 1
  (`mcpClients.ts` lazy/graceful pattern + dropped `--no-install`),
  `container-deploy-cutover.md` Dockerfile (drop redundant global
  install since `npm ci` already pulls the dep)

## Step-by-Step Implementation

### Step 1: Use-case fixtures

**File:** `agent-runtime/tests/acceptance/playwright.fixture.json`

```json
{
  "name": "playwright-screenshot-google",
  "description": "Parent agent receives a screenshot request, delegates to task_browser, subagent uses Playwright MCP to capture google.com, send_image returns the PNG to LINE.",
  "webhookPayload": {
    "events": [{
      "type": "message",
      "replyToken": "FIXTURE_REPLY_TOKEN_GOES_HERE",
      "source": { "userId": "U_FIXTURE_USER_001", "type": "user" },
      "message": { "id": "fixture-msg-001", "type": "text", "text": "screenshot google.com" }
    }]
  },
  "expect": {
    "httpStatus": 200,
    "withinMs": 30000,
    "lineApiCalls": [
      {
        "endpoint": "push",
        "messageType": "image",
        "originalContentUrlMatches": "^https://.*\\.workers\\.dev/img/.+\\.png$"
      },
      {
        "endpoint": "reply",
        "messageType": "text",
        "textMatches": "(?i)(screenshot|google|done|sent)"
      }
    ],
    "supabase": {
      "messages": [
        { "role": "user", "contentText": "screenshot google.com" },
        { "role": "assistant", "toolCallsContainTool": "task_browser" }
      ]
    },
    "langfuse": {
      "parentTraceContainsSpan": "task_browser",
      "subagentTraceContainsTool": "playwright_browser_take_screenshot"
    }
  }
}
```

**File:** `agent-runtime/tests/acceptance/github.fixture.json`

```json
{
  "name": "github-summarise-pr",
  "description": "Parent agent receives a PR-summary request, delegates to task_github, subagent uses GitHub MCP to fetch the PR, returns a short summary that gets sent as a LINE text reply.",
  "webhookPayload": {
    "events": [{
      "type": "message",
      "replyToken": "FIXTURE_REPLY_TOKEN_GOES_HERE",
      "source": { "userId": "U_FIXTURE_USER_001", "type": "user" },
      "message": {
        "id": "fixture-msg-002", "type": "text",
        "text": "Summarise https://github.com/openabdev/openab/pull/1 in two sentences."
      }
    }]
  },
  "expect": {
    "httpStatus": 200,
    "withinMs": 25000,
    "lineApiCalls": [{
      "endpoint": "reply",
      "messageType": "text",
      "textMinLength": 40,
      "textMaxLength": 500
    }],
    "supabase": {
      "messages": [
        { "role": "user", "contentTextContains": "github.com" },
        { "role": "assistant", "toolCallsContainTool": "task_github" }
      ]
    },
    "langfuse": {
      "parentTraceContainsSpan": "task_github",
      "subagentTraceContainsTool": "github_get_pull_request"
    }
  }
}
```

**Rationale:** Fixtures are JSON, not code, so non-engineers can copy
one and tweak. `expect` is structured — the runner validates each
clause and reports per-field failure.

### Step 2: Fixture runner

**File:** `agent-runtime/tests/acceptance/runner.ts`

```ts
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { db } from '../../src/db/client';

interface Fixture {
  name: string;
  webhookPayload: { events: any[] };
  expect: {
    httpStatus: number;
    withinMs: number;
    lineApiCalls: any[];
    supabase?: any;
    langfuse?: any;
  };
}

const recordedLineCalls: any[] = [];

// Override fetch to intercept LINE API calls
const origFetch = globalThis.fetch;
globalThis.fetch = async (url: any, init: any) => {
  if (String(url).startsWith('https://api.line.me/')) {
    recordedLineCalls.push({
      url: String(url),
      body: JSON.parse(init?.body ?? '{}'),
    });
    return new Response('{}', { status: 200 });
  }
  return origFetch(url, init);
};

export async function runFixture(path: string): Promise<{ pass: boolean; failures: string[] }> {
  const fx: Fixture = JSON.parse(readFileSync(path, 'utf8'));
  recordedLineCalls.length = 0;

  const body = JSON.stringify(fx.webhookPayload);
  const signature = createHmac('sha256', process.env.LINE_CHANNEL_SECRET!)
    .update(body).digest('base64');

  const t0 = Date.now();
  const r = await fetch(`http://localhost:${process.env.PORT ?? 7860}/webhook/line`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': signature },
    body,
  });

  const failures: string[] = [];
  if (r.status !== fx.expect.httpStatus)
    failures.push(`http status ${r.status} !== ${fx.expect.httpStatus}`);

  // Wait for processEvents (fire-and-forget) to complete
  await waitFor(() => recordedLineCalls.length >= fx.expect.lineApiCalls.length, fx.expect.withinMs);

  if (Date.now() - t0 > fx.expect.withinMs)
    failures.push(`exceeded ${fx.expect.withinMs}ms budget`);

  for (const [i, expected] of fx.expect.lineApiCalls.entries()) {
    const actual = recordedLineCalls[i];
    if (!actual) { failures.push(`missing LINE call #${i}`); continue; }
    if (!actual.url.endsWith(`/${expected.endpoint}`))
      failures.push(`call #${i} endpoint mismatch: ${actual.url}`);
    const msg = actual.body.messages?.[0];
    if (msg?.type !== expected.messageType)
      failures.push(`call #${i} message type ${msg?.type} !== ${expected.messageType}`);
    if (expected.textMatches && !new RegExp(expected.textMatches).test(msg?.text ?? ''))
      failures.push(`call #${i} text "${msg?.text}" does not match ${expected.textMatches}`);
    if (expected.originalContentUrlMatches &&
        !new RegExp(expected.originalContentUrlMatches).test(msg?.originalContentUrl ?? ''))
      failures.push(`call #${i} image URL "${msg?.originalContentUrl}" does not match`);
  }

  if (fx.expect.supabase) await verifySupabase(fx.expect.supabase, fx.webhookPayload, failures);
  // Langfuse verification deferred to manual step (see Debug Checklist)

  return { pass: failures.length === 0, failures };
}

async function waitFor(pred: () => boolean, ms: number) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise(r => setTimeout(r, 200));
  }
}

async function verifySupabase(spec: any, payload: any, failures: string[]) {
  const userId = payload.events[0].source.userId;
  const r = await db().from('messages').select('role, content, tool_calls')
    .eq('user_id', userId).order('created_at', { ascending: true }).limit(10);
  const rows = r.data ?? [];
  for (const want of spec.messages) {
    const match = rows.find((row: any) =>
      row.role === want.role &&
      (!want.contentText || row.content?.text === want.contentText) &&
      (!want.contentTextContains || (row.content?.text ?? '').includes(want.contentTextContains)) &&
      (!want.toolCallsContainTool || JSON.stringify(row.tool_calls ?? []).includes(want.toolCallsContainTool))
    );
    if (!match) failures.push(`supabase row missing: ${JSON.stringify(want)}`);
  }
}

// Run from CLI: `tsx tests/acceptance/runner.ts playwright.fixture.json`
if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2] ?? 'tests/acceptance/playwright.fixture.json';
  runFixture(path).then(({ pass, failures }) => {
    console.log(pass ? 'PASS' : 'FAIL');
    for (const f of failures) console.log('  -', f);
    process.exit(pass ? 0 : 1);
  });
}
```

**Rationale:** Intercepts `fetch` to LINE API so the runner does not
actually push messages during automated runs. Verifies Supabase rows
because that proves persistence works alongside the user-visible
reply.

### Step 3: Local dev — Playwright + Chromium without Docker

**Problem:** The current `mcpClients.ts` uses
`npx --no-install @playwright/mcp …`. In the container that works
because the Dockerfile does `npm install -g @playwright/mcp`. Outside
Docker (`npm run dev` on macOS / Linux dev machine) there is no global
install, `--no-install` skips fetching, and the MCP process exits with
"package not found". Then the parent's first `task_browser` call
errors, the LINE user sees "browser tool unavailable" and the dev loop
stalls.

**Fix (4 parts):**

#### 3a) Add `@playwright/mcp` as a runtime npm dependency

**File:** `agent-runtime/package.json`

```json
{
  "name": "@repo/agent-runtime",
  "dependencies": {
    "@mastra/core": "^1.33",
    "@mastra/mcp": "^1.33",
    "@playwright/mcp": "^0.0.30",
    "@ai-sdk/anthropic": "^3",
    "@ai-sdk/openai": "^3",
    "@ai-sdk/google": "^3",
    "@supabase/supabase-js": "^2",
    "hono": "^4",
    "zod": "^3",
    "langfuse-vercel": "^3"
  },
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p .",
    "start": "node dist/server.js",
    "test": "vitest run",
    "test:acceptance": "tsx tests/acceptance/runner.ts",
    "postinstall": "node scripts/install-mcp-deps.cjs"
  }
}
```

`@playwright/mcp` is now resolvable from local `node_modules/.bin`, so
the next change can drop `--no-install`.

#### 3b) Auto-install Chromium binary via postinstall hook

**File:** `agent-runtime/scripts/install-mcp-deps.cjs`

```js
// Runs after `npm install` in this workspace.
// Skippable via PLAYWRIGHT_SKIP_BROWSER_INSTALL=1 (CI, Dockerfile build).
const { execSync } = require('node:child_process');

function run(cmd, label) {
  console.log(`[install-mcp-deps] ${label}`);
  try { execSync(cmd, { stdio: 'inherit' }); }
  catch (e) {
    console.warn(`[install-mcp-deps] ${label} FAILED — continuing. ` +
                 `task_browser will return graceful error until fixed.`);
  }
}

if (process.env.PLAYWRIGHT_SKIP_BROWSER_INSTALL) {
  console.log('[install-mcp-deps] PLAYWRIGHT_SKIP_BROWSER_INSTALL set — skipping');
  process.exit(0);
}

// Playwright Chromium → ~/.cache/ms-playwright on macOS/Linux,
// or wherever PLAYWRIGHT_BROWSERS_PATH points (set to /ms-playwright in Docker).
run('npx playwright install chromium', 'installing Chromium for Playwright MCP');

// GitHub MCP binary is optional locally; only install if explicitly opted in.
// In Docker the Dockerfile downloads it directly to /usr/local/bin.
if (process.env.INSTALL_GITHUB_MCP_LOCALLY === '1') {
  const ghVersion = process.env.GH_MCP_VERSION ?? '1.0.4';
  const url = `https://github.com/github/github-mcp-server/releases/download/v${ghVersion}/github-mcp-server_Darwin_x86_64.tar.gz`;
  run(`curl -fsSL ${url} | tar -xz -C node_modules/.bin/`, 'installing github-mcp-server binary');
}
```

**Behaviour:**
- Local dev: `npm install` triggers Chromium download (~150 MB,
  one-time). GitHub MCP skipped unless `INSTALL_GITHUB_MCP_LOCALLY=1`.
- CI: set `PLAYWRIGHT_SKIP_BROWSER_INSTALL=1` to keep CI fast (unit
  tests don't use Playwright).
- Docker build: same env var, set in the `Dockerfile`. The Dockerfile
  already does an explicit `npx playwright install chromium` with
  `PLAYWRIGHT_BROWSERS_PATH=/ms-playwright` for the production
  location.

#### 3c) Drop `--no-install` and make MCPClient connect lazy + graceful

**File:** `agent-runtime/src/mcp/mcpClients.ts`

```ts
import { MCPClient } from '@mastra/mcp';
import path from 'node:path';

// Resolve @playwright/mcp from local node_modules, falling back to PATH.
// `npx @playwright/mcp` works both in dev (local install) and in container
// (Dockerfile relies on the same dep via `npm ci`).
const playwrightCmd = 'npx';
const playwrightArgs = ['@playwright/mcp', '--browser', 'chromium', '--headless'];

const githubBin = process.env.GITHUB_MCP_BIN
  ?? (process.platform === 'linux' ? '/usr/local/bin/github-mcp-server' : 'github-mcp-server');

export const playwrightMcp = new MCPClient({
  servers: {
    playwright: {
      command: playwrightCmd,
      args: playwrightArgs,
      env: {
        // PLAYWRIGHT_BROWSERS_PATH: set in container (/ms-playwright);
        // unset locally — Playwright defaults to ~/.cache/ms-playwright.
        ...(process.env.PLAYWRIGHT_BROWSERS_PATH
          ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}),
      },
    },
  },
});

export const githubMcp = new MCPClient({
  servers: {
    github: {
      command: githubBin,
      args: ['stdio', '--toolsets=repos,issues,pull_requests'],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN ?? '' },
    },
  },
});

// Lazy / graceful connect: do NOT call listTools() at module load.
// subagentRunner.ts catches the error and returns a structured failure
// to the parent agent, so the LINE webhook server still boots even if
// Chromium is missing or the GitHub binary isn't on PATH.
```

**File:** `agent-runtime/src/mcp/subagentRunner.ts` (additions)

```ts
async function safeListTools(client: MCPClient, mcpName: string) {
  try {
    return await client.listTools();
  } catch (err) {
    console.warn(`[mcp] ${mcpName} not available: ${String(err)}`);
    return null;
  }
}

// In runSubagent(), wrap the tools load:
//   const tools = await safeListTools(a.mcpClient, a.taskName);
//   if (!tools) return JSON.stringify({
//     ok: false, task: a.taskName,
//     reason: `${a.taskName} MCP unavailable in this environment — ` +
//             `run "npm install" or check container image build.`,
//   });
```

**Rationale:** The parent agent sees the same `task_browser` /
`task_github` tools regardless of environment. If the underlying MCP
fails to spawn, the parent gets a structured error message it can
surface ("I can't open a browser right now — your dev container may
be missing Chromium"). The webhook server doesn't crash; iteration on
unrelated features (memory, persistence, LINE delivery) continues.

#### 3d) Simplify the Dockerfile

**File:** `agent-runtime/Dockerfile` (in `container-deploy-cutover.md` Step 1)

Drop the redundant global `@playwright/mcp` install — `npm ci` now
covers it via `agent-runtime/package.json`. Keep Chromium runtime libs
+ explicit Chromium binary install (because the Docker layer should
have everything baked in, not rely on a runtime `postinstall`).

Diff against current Dockerfile in `container-deploy-cutover.md`:

```diff
- # Playwright + Chromium (still needed for the browser MCP subagent)
- ARG PLAYWRIGHT_MCP_VERSION=0.0.30
- RUN npm install -g @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} --retry 3
+ # Chromium binary for Playwright MCP (the npm package is pulled by `npm ci`)
  ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
+ ENV PLAYWRIGHT_SKIP_BROWSER_INSTALL=1  # postinstall would re-download; we do it explicitly below

  RUN npx --yes playwright install chromium && chmod -R a+rX /ms-playwright
```

The build stage's `npm ci` now installs `@playwright/mcp` to
`node_modules/.bin/` inside `/app/node_modules`; the runtime stage
copies that over.

### Step 4: Wire fixtures into `npm run` and CI

**File:** `agent-runtime/package.json` (already shown above)

```json
"test:acceptance": "tsx tests/acceptance/runner.ts"
```

Invoke per fixture:

```sh
PORT=7860 LINE_CHANNEL_SECRET=test_secret \
  npm run test:acceptance --workspace=@repo/agent-runtime -- tests/acceptance/playwright.fixture.json

PORT=7860 LINE_CHANNEL_SECRET=test_secret \
  npm run test:acceptance --workspace=@repo/agent-runtime -- tests/acceptance/github.fixture.json
```

CI (optional, week 5): add a job that boots the agent against a
Supabase test branch + mock LINE secrets, then runs both fixtures.
Skip on PRs that don't touch `agent-runtime/`.

## Testing Steps

For each fixture: pass = `runner.ts` exits 0.

### Pre-cutover smoke (week 5, manual)

After deploying the new image to the throwaway staging HF Space:

1. Hit the bot from a real LINE account: `screenshot google.com`
   → expect PNG within 30 s.
2. Hit the bot: `Summarise https://github.com/openabdev/openab/pull/1
   in two sentences.` → expect text reply 40–500 chars.

Pass both → green-light cutover. Either fails → debug per checklist
below, do not cut over.

## Debug Checklist

When `runFixture` reports failure, work down this list in order. Each
item is a one-line check that returns yes/no.

### Playwright fixture failures

1. **Container has Chromium?**
   ```sh
   docker exec <container> ls /ms-playwright
   ```
   Expect a `chromium-*` directory. If empty, `npm ci` skipped the
   `postinstall` or `PLAYWRIGHT_SKIP_BROWSER_INSTALL=1` was set but the
   explicit `RUN npx playwright install chromium` step also failed.
2. **`@playwright/mcp` resolvable?**
   ```sh
   docker exec <container> ls node_modules/@playwright/mcp/package.json
   ```
   If missing, `npm ci` in the build stage didn't include the dep
   (check `agent-runtime/package.json` has it under `dependencies`,
   not `devDependencies`).
3. **MCP starts at all?**
   ```sh
   docker exec <container> npx @playwright/mcp --headless --browser chromium
   ```
   Expect "MCP server listening on stdio". If it errors, you'll see a
   library-missing message (libnss3, libasound2, etc.) — add to the
   apt install in the Dockerfile.
4. **Parent agent sees `task_browser`?**
   ```sh
   curl http://<host>:7860/healthz?tools=1
   ```
   (Add a debug endpoint for week-2 smoke; remove before cutover.)
5. **Subagent receives Playwright tools?**
   Inspect Langfuse subagent trace — the first span should be
   `mcp.list_tools` and return ~20 tool names. Empty list = MCPClient
   connected but the MCP returned no tools (version mismatch).
6. **Image upload to Worker succeeds?**
   Look in agent logs for `deliver-line-image.sh` exit code. Non-zero
   = check `CF_UPLOAD_SECRET` mismatch (see `env-vars.md`
   "Cross-workspace consistency checks").

### GitHub fixture failures

1. **Binary on PATH?**
   ```sh
   docker exec <container> which github-mcp-server
   ```
   Expect `/usr/local/bin/github-mcp-server`. If missing, the
   Dockerfile's `curl … | tar -xz` step failed — re-check the version
   ARG.
2. **PAT scopes sufficient?**
   Repo:read + pull_requests:read minimum. Token without
   `pull_requests` scope returns 403 when the subagent fetches the PR;
   you'll see "Resource not accessible by personal access token" in
   the GitHub MCP stderr.
3. **Toolsets enabled?**
   The Dockerfile passes `--toolsets=repos,issues,pull_requests`. If
   the fixture asks for a workflow operation, that toolset isn't
   loaded.

### Local dev (`npm run dev`) failures

1. **Did postinstall run?**
   ```sh
   ls node_modules/.cache/ms-playwright/chromium-* || ls ~/.cache/ms-playwright/chromium-*
   ```
   No directory = `npm install` didn't run the `postinstall` script,
   or it errored silently. Run manually:
   ```sh
   npx playwright install chromium
   ```
2. **`npx @playwright/mcp` resolves?**
   ```sh
   npx --no-install @playwright/mcp --version
   ```
   If "package not found", you skipped `npm install`. Re-run.
3. **GitHub MCP not installed locally?** Expected — set
   `INSTALL_GITHUB_MCP_LOCALLY=1` before `npm install` to opt in, or
   accept that `task_github` returns the structured "unavailable"
   error during dev.
4. **Server boots but `task_browser` errors at first call?** Verify
   the lazy `safeListTools` warning appears in stderr — if the server
   crashed instead, the safety wrapper in step 3c isn't applied
   correctly.

## Dependencies

- Depends on: `mcp-subagent-dispatch.md` (the MCP client config this
  doc updates), `line-adapter.md` (the `/webhook/line` endpoint the
  fixtures POST to), `persistence.md` (the Supabase rows the runner
  verifies), `container-deploy-cutover.md` (the Dockerfile changes
  this doc reduces)
- Must complete before: cutover (week 5) — the two fixtures are the
  gate on flipping the LINE webhook URL

## Notes

- Fixtures live under `agent-runtime/tests/acceptance/` (gitignored by
  default in some templates — make sure `.gitignore` does **not**
  exclude this path).
- `LINE_CHANNEL_SECRET` for the runner can be any non-empty string in
  dev — the runner signs with the same string the server verifies
  against.
- A future fixture for memory persistence (PRD Success Criterion #4)
  would post one message on day N, one on day N + 1, and assert the
  day N + 1 system prompt contains the day N fact. That fixture
  requires a way to fast-forward the session-day boundary; defer to
  the memory-pipeline week (week 3) when the trigger code exists.
- Do NOT commit a real `LINE_CHANNEL_ACCESS_TOKEN` to fixtures. The
  runner's `fetch` interceptor catches outbound LINE calls before they
  hit the real API, so a dummy token in `.env` is sufficient.
