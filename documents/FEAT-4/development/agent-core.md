# Implementation Plan: Agent Core (Mastra)

## Overview

The agent core wraps Mastra into a `runTurn(userId, message)` entry
point. It is the only place provider names appear; everything else
talks to it through this function. System prompt comes from Supabase
(`agent_config.system_prompt`) and is re-read at session start.

## Files to Modify

### New TS workspace under `agent-runtime/`

The current `agent-runtime/` is a Docker build context, not an npm
workspace. FEAT-4 converts it. Add to root `package.json`
`workspaces` array.

- `agent-runtime/package.json` — new; deps: `@mastra/core`,
  `@mastra/mcp`, `@ai-sdk/anthropic`, `@ai-sdk/openai`,
  `@ai-sdk/google`, `@supabase/supabase-js`, `hono`, `zod`,
  `langfuse-vercel`
- `agent-runtime/tsconfig.json` — extend root; `moduleResolution: bundler`
- `agent-runtime/src/agent/index.ts` — Mastra instance + agent
  registration
- `agent-runtime/src/agent/runTurn.ts` — public `runTurn()` entry.
  Parent tools registered here: `taskBrowserTool`, `taskGithubTool`,
  `sendImageTool`. No `replyTool` — `agent.text` IS the reply.
- `agent-runtime/src/agent/systemPrompt.ts` — DB-backed prompt loader
- `agent-runtime/src/agent/providerRouting.ts` — model picker

### Shared types

- `shared/src/types/agent-events.ts` — no changes (Mastra adapter
  emits the existing union)
- `shared/src/types/turn.ts` — new: `TurnInput`, `TurnResult`

## Step-by-Step Implementation

### Step 1: TS workspace bootstrap

**File:** `agent-runtime/package.json`

```json
{
  "name": "@repo/agent-runtime",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p .",
    "start": "node dist/server.js",
    "test": "vitest run"
  },
  "dependencies": {
    "@mastra/core": "^1.33",
    "@mastra/mcp": "^1.33",
    "@ai-sdk/anthropic": "^3",
    "@ai-sdk/openai": "^3",
    "@ai-sdk/google": "^3",
    "@supabase/supabase-js": "^2",
    "hono": "^4",
    "zod": "^3",
    "langfuse-vercel": "^3"
  }
}
```

**Rationale:** Pin all `@ai-sdk/*` to v3 to avoid the v3↔v4 aliasing
churn Mastra is dealing with. Bump together when we re-test.

### Step 2: Mastra instance + named providers

**File:** `agent-runtime/src/agent/index.ts`

```ts
import { Mastra } from '@mastra/core';
import { Agent } from '@mastra/core/agent';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from '@mastra/core';

// Explicitly pass API keys — the SDK default env var names don't match
// ours (e.g. @ai-sdk/google reads GOOGLE_GENERATIVE_AI_API_KEY, we use
// GEMINI_API_KEY).
const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY ?? '' });
const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? '' });
const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY ?? '' });

// Cast needed: @ai-sdk/*@3 returns LanguageModelV3, but @mastra/core@0.10
// expects LanguageModelV1. The runtime protocol is compatible.
export const PROVIDERS: Record<string, LanguageModel> = {
  'gemini-2.5-flash': google('gemini-2.5-flash') as unknown as LanguageModel,
  'gemini-2.5-pro': google('gemini-2.5-pro') as unknown as LanguageModel,
  'claude-sonnet-4-6': anthropic('claude-sonnet-4-6') as unknown as LanguageModel,
  'claude-haiku-4-5': anthropic('claude-haiku-4-5-20251001') as unknown as LanguageModel,
  'gpt-4o': openai('gpt-4o') as unknown as LanguageModel,
};

export type ProviderKey = string;

export { Agent };

// Telemetry wiring (Langfuse OTel) is deferred to observability-shim.md;
// the Mastra instance here is a stub until that wiring is validated.
export const mastra: InstanceType<typeof Mastra> = new Mastra({});
```

**Rationale:** One static map, one Mastra instance. `Agent` is
re-exported for use in other modules (subagents, extractors). Provider
keys are the only strings stored in `agent_config`. Factory functions
(`createGoogleGenerativeAI` etc.) are used instead of bare imports to
pass API keys explicitly — the SDK's default env var names
(`GOOGLE_GENERATIVE_AI_API_KEY`) don't match ours (`GEMINI_API_KEY`).

> **Note:** Mastra v1.33+ uses `new Agent()` from `@mastra/core/agent`,
> not `mastra.createAgent()`. The Mastra instance is used for telemetry
> and service-level config; agents are instantiated directly.

### Step 3: System prompt loader

**File:** `agent-runtime/src/agent/systemPrompt.ts`

```ts
import { getAgentConfig } from '../db/agentConfig';

// In-process cache: re-read at most every 60 s. Session boundary also
// invalidates implicitly because runTurn re-calls this.
let cached: { value: string; loadedAt: number } | null = null;
const TTL_MS = 60_000;

export async function getSystemPrompt(): Promise<string> {
  const now = Date.now();
  if (cached && now - cached.loadedAt < TTL_MS) return cached.value;
  const value = await getAgentConfig('system_prompt');
  cached = { value, loadedAt: now };
  return value;
}
```

**Rationale:** Admin edits propagate in ≤ 60 s without us building
LISTEN/NOTIFY. No per-user prompt — single global value per the PRD.

### Step 4: Provider routing

**File:** `agent-runtime/src/agent/providerRouting.ts`

```ts
import { PROVIDERS, ProviderKey } from './index';
import { getAgentConfig } from '../db/agentConfig';

export async function pickProvider(
  userId: string,
  hint?: 'main' | 'curator' | 'extractor' | 'skill-creator',
): Promise<ProviderKey> {
  // Lookup precedence (highest → lowest):
  //   1. default_model:<hint>     — per-role override (active in FEAT-4)
  //   2. default_model            — global default (always present)
  //
  // Per-user overrides (e.g. default_model:<userId> or
  // default_model:<userId>:<hint>) are NOT in FEAT-4 scope. If/when
  // added, insert them above step 1 and document the precedence here
  // in the same comment block. The exact key naming will be locked in
  // at that time — do not invent unused keys ahead of need.
  const roleKey = hint ? `default_model:${hint}` : 'default_model';
  const v = await getAgentConfig(roleKey).catch(() => null);
  if (v && v in PROVIDERS) return v as ProviderKey;
  return (await getAgentConfig('default_model')) as ProviderKey;
}
```

**Rationale:** One function, one source of truth. Hints let memory
extraction use Flash while the main turn uses Sonnet.

### Step 5: `runTurn` entry

**File:** `agent-runtime/src/agent/runTurn.ts`

```ts
import { Agent, PROVIDERS } from './index';
import { getSystemPrompt } from './systemPrompt';
import { pickProvider } from './providerRouting';
import { loadRecentMessages } from '../db/messages';
import { findRelevantMemories } from '../db/memories';
import { taskBrowserTool, taskGithubTool, sendImageTool }
  from '../mcp/parentTools';
import { RuntimeContext } from '@mastra/core/runtime-context';

export interface TurnInput { userId: string; userMessage: string; sessionId: string }
export interface TurnResult { reply: string; toolCallCount: number; langfuseTraceId: string }

export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const { userId, userMessage, sessionId } = input;
  const [system, history, memories, providerKey] = await Promise.all([
    getSystemPrompt(),
    loadRecentMessages({ userId, sessionId, limit: 50 }),
    findRelevantMemories({ userId, query: userMessage, limit: 10 }),
    pickProvider(userId, 'main'),
  ]);

  const agent = new Agent({
    name: 'line-bot',
    instructions: composeSystem(system, memories),
    model: PROVIDERS[providerKey],
    tools: { sendImageTool, taskBrowserTool, taskGithubTool },
  });

  const runtimeContext = new RuntimeContext();
  runtimeContext.set('userId', userId);
  runtimeContext.set('sessionId', sessionId);

  const result = await agent.generate(
    [...history.map(toMastraMessage), { role: 'user', content: userMessage }],
    { runtimeContext, maxSteps: 8 },
  );

  return {
    reply: result.text,
    toolCallCount: result.steps.flatMap(s => s.toolCalls).length,
    langfuseTraceId: result.experimental_providerMetadata?.langfuse?.traceId ?? '',
  };
}
```

**Rationale:** Single entry point — caller (LINE adapter) doesn't need
to know which provider, what tools, or that subagents exist. `maxSteps:
8` caps the main loop; subagents have their own caps inside
`mcp-subagent-dispatch.md`. The no-op `replyTool` has been removed —
the natural Mastra flow returns `agent.text` as the final reply, and
having a no-op tool confuses the model about which path actually sends
the message. `RuntimeContext` must be instantiated via the class
constructor and populated with `.set()` — Mastra does not accept a
plain object.

### Step 6: Compose system block

**File:** `agent-runtime/src/agent/composeSystem.ts`

```ts
import type { Memory } from '../db/memories';

const MAX_MEMORY_BLOCK_BYTES = 25_000; // cc-haha pattern: dual cap (row + byte)

export function composeSystem(
  globalPrompt: string,
  memories: Memory[],
  skills: string[] = [],
): string {
  const parts = [globalPrompt];

  // Skills go BEFORE memories (Dive-into-CC context assembly ordering:
  // skills are instructions and should rank higher than potentially
  // stale memory facts).
  if (skills.length > 0) {
    parts.push(`\n\n<active-skills>\n${skills.join('\n---\n')}\n</active-skills>`);
  }

  if (memories.length > 0) {
    let block = memories.map(m => {
      const stale = Date.now() - m.updatedAt.getTime() > 24 * 3600_000;
      return `- ${m.title}${stale ? ' (NOTE: >1 day old, verify before recommending)' : ''}: ${m.body}`;
    }).join('\n');

    // Byte cap: prevent oversized memory injection from blowing context
    if (block.length > MAX_MEMORY_BLOCK_BYTES) {
      block = block.slice(0, block.lastIndexOf('\n', MAX_MEMORY_BLOCK_BYTES));
      block += '\n> Memory index truncated at 25 KB.';
    }

    parts.push(`\n\n<memory-context>\n${block}\n</memory-context>`);
  }

  return parts.join('');
}
```

**Rationale:** Staleness disclaimer mirrors cc-haha's `memoryAge.ts`
rule. Byte cap (25 KB) prevents long-title memories from blowing up
context (cc-haha dual cap pattern). Skills are injected **before**
memories per Dive-into-CC's context assembly ordering principle —
the model weights earlier context more heavily, and skill instructions
should outrank potentially stale memory facts. Bodies inline (no
further fetch) since they're already short-form.

## Testing Steps

1. Unit-test `composeSystem` — empty memories, stale memories, mixed.
2. Unit-test `pickProvider` — DB returns valid / invalid / missing.
3. Integration-test `runTurn` — mocked Mastra, real DB, verify single
   `messages` insert per turn (write happens in the LINE adapter, not
   here — see `line-adapter.md`).
4. Acceptance: load a real seeded system prompt + a real memory, call
   `runTurn` with a fixture user message, expect non-empty reply.

## Dependencies

- Must complete before: line-adapter, mcp-subagent-dispatch,
  memory-skill-pipeline
- Depends on: persistence (DB helpers `getAgentConfig`,
  `loadRecentMessages`, `findRelevantMemories`)

## Notes

- Mastra v1.33 still uses `experimental_providerMetadata` for the
  Langfuse trace id; verify on each Mastra bump.
- Do not add a "fallback provider" pattern. If the chosen provider is
  down, surface the error — quietly switching providers ruins
  reproducibility.

### Security invariants (Dive-into-CC defense-in-depth)

**Permission reset invariant:** Each `runTurn` call creates a fresh
`Agent()`. No tool permissions, MCP connections, or browser state carry
over between turns. This is by construction — do not cache the agent
instance across calls.

**Defense-in-depth layers** (5 layers; L1 + L2 share `LINE_CHANNEL_SECRET`
but run in independent runtimes — they catch different failure modes
despite the shared key; L3–L5 are fully independent):

| Layer | Mechanism | Failure mode |
|---|---|---|
| 1 | LINE HMAC at edge Worker | Network-path tampering (Worker-side) |
| 2 | LINE HMAC re-verify in container | Bypass of the edge Worker (direct HF Space hit) |
| 3 | `LINE_ALLOWED_USER_IDS` allowlist | Authenticated-but-unauthorised user |
| 4 | Subagent dispatch (tool scope) | Parent agent prompt-injected to call wrong MCP |
| 5 | `maxSteps` caps (8 parent, 12 sub) | Agent loop runaway / provider ignores stop |

Compromising `LINE_CHANNEL_SECRET` defeats L1 + L2 simultaneously — that
is the one secret whose rotation hygiene matters most. L3–L5 each
require an independent breach to bypass.
