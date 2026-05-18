# Implementation Plan: MCP Subagent Dispatch

## Overview

Heavy MCP servers (Playwright, GitHub) are NOT exposed to the parent
agent. Instead the parent has a small set of `task_*` tools; calling
one spawns an isolated Mastra subagent with exactly that MCP loaded.
The subagent runs to completion (or `max_steps` cap), and only its
summary returns to the parent. This bounds parent context cost and
solves the Playwright-state-across-turns problem (subagent's browser
dies with the subagent).

This is "Pattern P2" from `design-decisions.md` §7 — what Claude Code
actually ships.

## Files to Modify

- `agent-runtime/src/mcp/parentTools.ts` — new; defines `task_browser`,
  `task_github`, `send_image`
- `agent-runtime/src/mcp/subagentRunner.ts` — new; factory that builds
  + executes a subagent
- `agent-runtime/src/mcp/mcpClients.ts` — new; MCP client config per
  server (Playwright, GitHub)
- `agent-runtime/src/mcp/summarise.ts` — new; reduces subagent output
  to parent-consumable string

## Step-by-Step Implementation

### Step 1: MCP client config

**File:** `agent-runtime/src/mcp/mcpClients.ts`

```ts
import { MastraMCPClient } from '@mastra/mcp';

// `@mastra/mcp` exports `MastraMCPClient` (not `MCPClient`). Each
// instance wraps a single MCP server; use `name` + `server` (singular).
//
// `@playwright/mcp` is a runtime dep in agent-runtime/package.json, so
// `npx @playwright/mcp` resolves from local node_modules/.bin both in
// the container (built via `npm ci`) and during `npm run dev` on a dev
// machine. We deliberately do NOT pass `--no-install` — that was a
// source of breakage when running outside Docker.
export const playwrightMcp = new MastraMCPClient({
  name: 'playwright',
  server: {
    command: 'npx',
    args: ['@playwright/mcp', '--browser', 'chromium', '--headless'],
    env: {
      // PLAYWRIGHT_BROWSERS_PATH is set to /ms-playwright in the
      // Dockerfile; left unset on dev machines so Playwright defaults
      // to ~/.cache/ms-playwright.
      ...(process.env.PLAYWRIGHT_BROWSERS_PATH
        ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}),
    },
  },
});

const githubBin = process.env.GITHUB_MCP_BIN
  ?? (process.platform === 'linux'
        ? '/usr/local/bin/github-mcp-server'
        : 'github-mcp-server');

export const githubMcp = new MastraMCPClient({
  name: 'github',
  server: {
    command: githubBin,
    args: ['stdio', '--toolsets=repos,issues,pull_requests'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN ?? '' },
  },
});
```

**Rationale:** Same MCP servers as FEAT-1, but resolvable from local
`node_modules` so `npm run dev` works without a Docker image. The
GitHub binary path falls back to PATH lookup on macOS dev machines.
The MCPClients are **not connected at module load** — `subagentRunner`
calls `listTools()` lazily inside a try/catch so a missing dev-machine
Chromium does not crash the server.

See `acceptance-tests.md` §"Step 3: Local dev — Playwright +
Chromium without Docker" for the package.json + postinstall changes
that make this work.

### Step 2: Subagent runner

**File:** `agent-runtime/src/mcp/subagentRunner.ts`

```ts
import { Agent, PROVIDERS } from '../agent';
import { pickProvider } from '../agent/providerRouting';
import { MCPClient } from '@mastra/mcp';
import { RuntimeContext } from '@mastra/core/runtime-context';
import { agentEventBus } from '../observability/bus';
import { softTruncate } from './summarise';

interface Args {
  userId: string;
  sessionId: string;
  parentTraceId: string;
  taskName: 'browser' | 'github';
  mcpClient: MCPClient;
  prompt: string;
  systemHint: string;
}

export async function runSubagent(a: Args): Promise<string> {
  const providerKey = await pickProvider(a.userId, 'main');
  const tools = await safeListTools(a.mcpClient, a.taskName);
  if (!tools) {
    agentEventBus.emit({
      kind: 'AgentToolResult',
      userId: a.userId, sessionId: a.sessionId,
      toolName: `task_${a.taskName}`, ok: false,
      error: `${a.taskName} MCP unavailable in this environment`,
    });
    return JSON.stringify({
      ok: false, task: a.taskName,
      reason: `${a.taskName} MCP unavailable in this environment — ` +
              `run "npm install" or rebuild the container image.`,
    });
  }
  const subagent = new Agent({
    name: `subagent-${a.taskName}`,
    instructions: a.systemHint,
    model: PROVIDERS[providerKey],
    tools,
  });

  const runtimeContext = new RuntimeContext();
  runtimeContext.set('userId', a.userId);
  runtimeContext.set('sessionId', a.sessionId);

  let attempt = 0;
  while (attempt < 2) {
    attempt += 1;
    try {
      agentEventBus.emit({
        kind: 'AgentToolCall',
        userId: a.userId, sessionId: a.sessionId,
        toolName: `task_${a.taskName}`, attempt,
        parentTraceId: a.parentTraceId,
      });
      const result = await subagent.generate(
        [{ role: 'user', content: a.prompt }],
        { runtimeContext, maxSteps: 12 },
      );
      agentEventBus.emit({
        kind: 'AgentToolResult',
        userId: a.userId, sessionId: a.sessionId,
        toolName: `task_${a.taskName}`, ok: true,
      });
      // Per-tool-result budget (Dive-into-CC pattern): truncate before
      // returning to parent to prevent one oversized subagent output
      // from blowing up the parent context.
      return softTruncate(result.text);
    } catch (err) {
      if (attempt >= 2) {
        agentEventBus.emit({
          kind: 'AgentToolResult',
          userId: a.userId, sessionId: a.sessionId,
          toolName: `task_${a.taskName}`, ok: false,
          error: String(err),
        });
        return JSON.stringify({ ok: false, reason: String(err), task: a.taskName });
      }
    }
  }
  return JSON.stringify({ ok: false, reason: 'exhausted retries', task: a.taskName });
}

async function safeListTools(client: MCPClient, mcpName: string) {
  try {
    return await client.listTools();
  } catch (err) {
    console.warn(`[mcp] ${mcpName} not available: ${String(err)}`);
    return null;
  }
}
```

**Rationale:** Implements the retry policy from `design-decisions.md`
§14 — one automatic retry, then return structured `{ok:false}` to
parent. No exponential backoff (LINE is human-paced). `safeListTools`
turns "MCP can't even start" (typically: missing Chromium in dev) into
the same structured failure shape as runtime errors, so the webhook
server keeps serving and the LINE user gets a useful error message
instead of a 500.

### Step 3: Parent-level tools

**File:** `agent-runtime/src/mcp/parentTools.ts`

```ts
import { createTool } from '@mastra/core';
import { z } from 'zod';
import { runSubagent } from './subagentRunner';
import { playwrightMcp, githubMcp } from './mcpClients';

export const taskBrowserTool = createTool({
  id: 'task_browser',
  description:
    'Use the headless browser to fetch, screenshot, click, or extract content from a webpage. ' +
    'Pass a one-paragraph English task description; the subagent decides which browser actions to run.',
  inputSchema: z.object({
    task: z.string().describe('What to do in the browser, e.g. "Screenshot the Google homepage and return the PNG path"'),
  }),
  execute: async ({ context, runtimeContext }) => {
    const { userId, sessionId, langfuseTraceId } = runtimeContext as any;
    const out = await runSubagent({
      userId, sessionId, parentTraceId: langfuseTraceId ?? '',
      taskName: 'browser', mcpClient: playwrightMcp,
      prompt: context.task,
      systemHint: 'You are a headless-browser specialist. Use Playwright MCP tools to fulfil the task. Save screenshots to /tmp/.',
    });
    return out;
  },
});

export const taskGithubTool = createTool({
  id: 'task_github',
  description:
    'Read a GitHub repo, summarise a PR, or comment on an issue. Pass a one-paragraph English task description.',
  inputSchema: z.object({ task: z.string() }),
  execute: async ({ context, runtimeContext }) => {
    const { userId, sessionId, langfuseTraceId } = runtimeContext as any;
    return runSubagent({
      userId, sessionId, parentTraceId: langfuseTraceId ?? '',
      taskName: 'github', mcpClient: githubMcp,
      prompt: context.task,
      systemHint: 'You are a GitHub specialist. Use GitHub MCP tools to fulfil the task.',
    });
  },
});

export const sendImageTool = createTool({
  id: 'send_image',
  description: 'Send an image to the user. Provide a local PNG path; the harness uploads it and pushes a LINE image message.',
  inputSchema: z.object({ pngPath: z.string() }),
  execute: async ({ context, runtimeContext }) => {
    const { userId } = runtimeContext as any;
    const { execFile } = await import('node:child_process');
    const out = await new Promise<string>((resolve, reject) =>
      execFile('/usr/local/bin/deliver-line-image.sh', [userId, context.pngPath],
        (err, stdout) => err ? reject(err) : resolve(stdout)));
    return JSON.parse(out);
  },
});
```

**Rationale:** The PARENT only sees these 3 tools (`task_browser`,
`task_github`, `send_image`). Playwright's 20-something tools never
enter the parent's context window. The model asks for `task_browser`,
gets the subagent's prose summary back, and moves on. The no-op
`replyTool` was removed — Mastra's natural `agent.text` return is the
reply; a no-op tool that claims to "send a reply" confuses the model
about which path actually delivers the message.

### Step 4: Summary post-processing (optional, only if subagent output is huge)

**File:** `agent-runtime/src/mcp/summarise.ts`

```ts
const SOFT_CAP = 4000; // chars

export function softTruncate(s: string): string {
  if (s.length <= SOFT_CAP) return s;
  return s.slice(0, SOFT_CAP) + `\n…(truncated, original ${s.length} chars)`;
}
```

Apply in `runSubagent` before returning `result.text`.

**Rationale:** PRD says no token-aware truncation, but a hard char cap
prevents pathological subagent runs from spamming the parent.

## Testing Steps

1. Unit-test `runSubagent` with a mocked Mastra agent — assert one
   retry happens on first failure, structured error returned on
   second failure.
2. Unit-test `taskBrowserTool` schema validation.
3. Integration: real Playwright MCP, prompt `task_browser` with
   `"Visit example.com and report the page title"`. Expect non-empty
   string return within 30 s.
4. Acceptance: PRD Success Criterion #2 — LINE message `screenshot
   google.com`, expect PNG reply within 30 s.

## Dependencies

- Must complete before: memory-skill-pipeline (the memory extractor IS
  a subagent), curator (Phase 2 uses a subagent too)
- Depends on: agent-core, observability-shim (for event bus emits)

## Notes

- Each subagent call is one MCP client instantiation. If startup cost
  dominates, pool MCP clients per server (Mastra supports this) — defer
  until measured.
- Subagent's MCP client cleans up automatically when the subagent's
  Mastra instance is GC'd. No explicit `close()` needed.
- The subagent inherits Langfuse parent trace via `runtimeContext` —
  verify in week 2.
- **Mastra MCP API:** Use `mcp.listTools()` (returns `Tool[]`) for
  static agent config, or `mcp.listToolsets()` for dynamic per-request
  injection. There is no `getTools()` method.
- **Zod v4 compat:** `@mastra/mcp` has a known Zod v4 break
  (mastra-ai/mastra#7092). Pin `zod: ^3` and verify Mastra's
  transitive Zod version doesn't conflict.
