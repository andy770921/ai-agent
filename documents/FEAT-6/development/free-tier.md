# FEAT-6 — Follow-up: run on OpenRouter's free tier (402 fix)

## Incident (2026-11-03)

After FEAT-6 shipped, the first LINE message ("Hi") got *"Sorry, something
went wrong."* The HF logs showed:

```
runTurn failed MastraError: Payment Required
  modelId: 'google/gemini-2.5-flash', modelProvider: 'openrouter.chat'
  statusCode: 402
  requestBodyValues: { model: 'google/gemini-2.5-flash', max_tokens: undefined, … }
  responseBody: {"error":{"message":"This request requires more credits, or fewer
    max_tokens. You requested up to 65535 tokens, but can only afford 16000. …",
    "code":402,"metadata":{"limit_source":"openrouter_credits", …}}}
```

## Root cause

1. **The account has no purchased credits.** The "$100 credit limit" shown at
   OpenRouter onboarding is the key's *spending cap*, not money. OpenRouter is
   prepaid, and `limit_source: openrouter_credits` names the account balance as
   the blocker. The balance could cover about 16000 output tokens, roughly
   $0.04 at $2.50 / M.
2. **We never sent `max_tokens`.** OpenRouter estimates each paid request's
   cost up front: *"input tokens plus the completion tokens allowed by
   `max_tokens`"*, with a large fixed cap when it is unset. It rejects
   requests whose estimate doesn't fit
   ([OpenRouter limits](https://openrouter.ai/docs/api-reference/limits)).
   Here it assumed the model's full 65535-token output limit, so even "Hi"
   failed.

## Goal and decisions

The goal is to make "Hi" **and** a screenshot request work **without buying
credits**.

| Change | Why |
|---|---|
| `DEFAULT_MODEL = 'gemma-4-31b-it:free'` (`src/config/agentConfig.ts`), with a new `PROVIDERS` entry → `google/gemma-4-31b-it:free` | Free models cost $0, and the up-front cost estimate *"does not apply to requests to free models"*. A cap alone isn't enough: on a paid model every message still spends the ~$0.04, and once it can't cover 8192 tokens the 402 returns. |
| `MAX_OUTPUT_TOKENS = 8192`, passed as `maxTokens` to all four `generate()` calls (`runTurn`, `subagentRunner`, `extractMemory`, `createSkill`) | Requested cap. Shrinks the cost estimate for paid models and bounds runaway output on any model. Gemma's max output is 32768. |
| `runTurn` tool keys `send_image` / `task_browser` / `task_github` (were `sendImageTool` / `taskBrowserTool` / `taskGithubTool`) | Mastra sends the object **keys** as tool names. The system prompt tells the model to call `task_browser` and `send_image`, which didn't exist under those names. Gemini coped; a smaller model may not. |

### Why `google/gemma-4-31b-it:free`

On 2026-11-03, 13 of OpenRouter's 14 `:free` models listed `tools` support
(`GET /api/v1/models`). Gemma 4 31B was picked because it is:

- a Google model, closest to the previous Gemini default;
- tool-capable, with a 262k context and 32768 max output;
- served by Google AI Studio, at 100% uptime over the last 30 min at the time
  of checking (`GET /api/v1/models/google/gemma-4-31b-it:free/endpoints`).

If it can't drive the screenshot flow, try these next. Each needs a
`PROVIDERS` entry plus a `DEFAULT_MODEL` change:
- `nvidia/nemotron-3-ultra-550b-a55b:free`
- `google/gemma-4-26b-a4b-it:free`

### Free-tier limits

- **Rate limits** (OpenRouter docs): 20 requests/min. 50 requests/day while
  less than $10 of credits has ever been bought; 1,000/day after that.
- **Requests per message:** one LINE message can use several requests. A
  screenshot is about 5–8: parent → `task_browser` subagent steps → parent →
  `send_image` → parent.
- **Negative balance:** blocks free models too.
- **Data policy:** free endpoints can have different data policies from paid
  ones. If OpenRouter returns *"No endpoints found matching your data
  policy"*, check https://openrouter.ai/settings/privacy. Remember that LINE
  messages then go to that provider under its terms (PDPA/GDPR).

## Making the screenshot flow testable locally

The screenshot path and image delivery were hardcoded to the container. Two
small changes let `scripts/smoke-turn.ts` run the same code on a laptop.
Production behavior is unchanged.

- **Screenshot directory** (`src/mcp/parentTools.ts`): now
  `join(process.cwd(), '.playwright-mcp')`, instead of the literal
  `/home/node/.playwright-mcp`.
  - Playwright MCP only allows writes under its cwd and `<cwd>/.playwright-mcp`.
    A local probe confirmed `/home/node/...` is rejected with *"outside allowed
    roots"*.
  - In the container the cwd is `WORKDIR /home/node` (`entrypoint.sh` execs
    node without `cd`), so the prompt text is byte-identical there.
- **`DELIVER_LINE_IMAGE_BIN`** (`src/mcp/parentTools.ts`): overrides
  `/usr/local/bin/deliver-line-image.sh`, following the existing
  `GITHUB_MCP_BIN` pattern. The real script is Linux-only (it reads
  `/proc/sys/kernel/random/uuid`).
- **`.gitignore`:** now covers `.playwright-mcp/` output from local runs.

## Smoke test: `npm run smoke`

```bash
cd agent-runtime && npm run smoke     # = tsx --env-file=.env scripts/smoke-turn.ts
```

The test runs real `runTurn()` calls against `DEFAULT_MODEL` on OpenRouter,
with the real Playwright MCP. LINE is not involved. Two cases:

| Case | Message | PASS when |
|---|---|---|
| `greeting` | `Hi` | non-empty reply, **no** tool calls, no image sent |
| `screenshot` | `Please help me screenshot the Google home page image for me` | `task_browser` succeeded, **and** `send_image` was called with an existing file whose bytes are a PNG, **and** the reply is non-empty |

- **Image delivery:** `send_image` goes to a stub that checks the file and
  returns `{"ok":true,"stub":true}`. Actual LINE delivery is only covered by
  the production check below.
- **Output:** the subagent's Playwright calls are logged as
  `[subagent:browser] step N call …`. The test exits 1 if any case fails.
- **Budget:** each run uses roughly 10 free-tier requests out of 50/day.

**Prerequisites:**
- `OPEN_ROUTER_API_KEY` in `agent-runtime/.env`.
- A Chromium matching the `@playwright/mcp` version that `npx` resolves
  locally. Locally it is unpinned: 0.0.84 on 2026-11-03, while Docker pins
  0.0.75. If the browser tool reports *"Browser … is not installed"*, run:

  ```bash
  npx -p @playwright/mcp@<version> playwright-core install --no-shell chromium
  ```

  This is the same procedure as `scripts/install-mcp-deps.cjs`.

## Production acceptance (after deploy)

Send both messages to the bot in LINE:
1. `Hi` → a short text reply.
2. `Please help me screenshot the Google home page image for me` → an image
   message with the Google homepage, plus a short text.

In the HF logs, expect:
- `[subagent:browser] step … call browser_navigate`;
- `… call browser_take_screenshot` with a `/home/node/.playwright-mcp/…png`
  filename;
- no `runTurn failed`.

## Switching back to a paid model

1. Buy credits at https://openrouter.ai/settings/credits.
2. Set `DEFAULT_MODEL = 'gemini-2.5-flash'`.
3. Re-run `npm run smoke`.

Keep `MAX_OUTPUT_TOKENS`: it keeps each request's up-front estimate around
$0.02 instead of about $0.16.

## Verification (2026-11-03)

- **Unit tests:** `cd agent-runtime && npx vitest run` → 34/34.
  - New `src/agent/runTurn.test.ts` stubs `fetch` and runs `runTurn('Hi')`.
    It asserts model `google/gemma-4-31b-it:free`, `max_tokens: 8192`, a
    leading system message, and tools `send_image` / `task_browser` /
    `task_github`.
  - `index.test.ts` covers the new `PROVIDERS` entry.
- **Static checks:** `tsc --noEmit` (including `scripts/smoke-turn.ts`),
  eslint and prettier are clean.
- **Smoke without a key** (no `--env-file`): both cases reach OpenRouter and
  fail with `Unauthorized`, which confirms the wiring.
- **Playwright MCP probe, no LLM:** navigating to google.com and taking a
  screenshot works locally. It writes to
  `agent-runtime/.playwright-mcp/<name>.png`; `/home/node/...` and
  `~/.playwright-mcp/...` are rejected.
- **Not verified yet:** the real free model's behavior. That needs the key,
  which only the developer's `.env` holds: run `npm run smoke` and paste the
  output.
