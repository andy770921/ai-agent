# FEAT-6 — LLM access via OpenRouter (replace `GEMINI_API_KEY`)

## Summary

Stop calling Google's Gemini API directly from `agent-runtime/`. The default
models (`gemini-2.5-flash`, `gemini-2.5-pro`) are now reached through
[OpenRouter](https://openrouter.ai), authenticated with a single
`OPEN_ROUTER_API_KEY`. `GEMINI_API_KEY` and the `@ai-sdk/google` package are
removed. The upstream model was initially unchanged (`google/gemini-2.5-flash`
on OpenRouter).

**Update 2026-11-03:** the first production request failed with HTTP 402
because the OpenRouter account has no purchased credits. The default model is
now the free `google/gemma-4-31b-it:free`, and every `generate()` call caps
output at 8192 tokens. See `../development/free-tier.md`.

## Motivation

- **One key, many models.** OpenRouter exposes Gemini, Claude, GPT and others
  behind one OpenAI-compatible API (`POST https://openrouter.ai/api/v1/chat/completions`).
  Switching or A/B-ing models becomes a one-line change in
  `src/agent/index.ts` instead of a new SDK + new secret.
- **Spend is capped by the key itself.** OpenRouter keys carry a spending
  limit and an expiry date, so a leaked key has a bounded blast radius. (The
  key created at onboarding has a $100 limit and expires 2027-05-02.) The
  limit is a *cap*, not credit: OpenRouter is prepaid, and paid models only
  work once the account balance covers the request.
- **One billing/usage dashboard** for all LLM traffic.

## Decisions

| Question | Decision | Rationale |
|---|---|---|
| Which AI SDK provider? | **`@openrouter/ai-sdk-provider@^0.7.5`** (npm dist-tag `ai-sdk-v4`). | `@mastra/core@0.10` runs on `ai@4`, which only accepts `LanguageModelV1` models. 0.7.x is OpenRouter's AI SDK 4 line (peer `ai ^4.3.17`); 1.x and later need `ai@5+` and would throw `Unsupported model version` at call time. It is OpenRouter's own provider and exposes OpenRouter-only settings (`models` fallbacks, `reasoning`, `usage` accounting) if we need them later. |
| Why not reuse `@ai-sdk/openai` with `baseURL`? | Rejected. | It would save one package and work for basic chat, but it's a generic OpenAI client: OpenRouter-specific request/response fields are not modelled. Locally it also resolves to `@ai-sdk/openai@3` (a v3 model), which Mastra 0.10 rejects; see the development doc. |
| Env var name | **`OPEN_ROUTER_API_KEY`**, passed explicitly via `createOpenRouter({ apiKey })`. | Requested name. The provider's own default is `OPENROUTER_API_KEY`, which matches the existing "pass keys explicitly" pattern in `index.ts`. |
| Model keys in `PROVIDERS` | **Unchanged** (`gemini-2.5-flash`, `gemini-2.5-pro`), mapped to OpenRouter slugs `google/gemini-2.5-flash` / `google/gemini-2.5-pro`. | `DEFAULT_MODEL` in `src/config/agentConfig.ts`, `pickProvider`, and the Langfuse `model` name all stay as they are. |
| `HTTP-Referer` / `X-Title` headers | **Hardcoded**: the HF Space URL and `LINE AI Agent`. | Optional OpenRouter app attribution. Not secrets; follows FEAT-5's "config is hardcoded constants" convention. |
| Claude / GPT-4o entries | **Unchanged** (still direct `@ai-sdk/anthropic` / `@ai-sdk/openai` with their own keys). | Out of scope; see follow-ups. |
| Default model (2026-11-03) | **`gemma-4-31b-it:free`** → `google/gemma-4-31b-it:free`. | The bot has to work without buying credits. Free models cost $0 and are exempt from OpenRouter's up-front cost check. It is a Google model with tool support. Switch back to `gemini-2.5-flash` once credits are bought. |
| Output-token cap (2026-11-03) | **`MAX_OUTPUT_TOKENS = 8192`**, passed as `maxTokens` to all four `generate()` calls. | Without `max_tokens`, OpenRouter budgets a paid request at the model's full output limit (65535 for Gemini 2.5 Flash) and returns 402 if the balance can't cover it, even for "Hi". |

## Scope

**In scope**
- `agent-runtime/src/agent/index.ts`: swap the Google provider for OpenRouter.
- `agent-runtime/package.json` and `package-lock.json`: remove `@ai-sdk/google`, add
  `@openrouter/ai-sdk-provider`.
- `agent-runtime/src/agent/index.test.ts`: new wire-level test for the provider.
- `agent-runtime/.env.example`, `README.md`, `CLAUDE.md`: env var rename.

**Out of scope**
- Routing Claude / GPT-4o through OpenRouter, or dropping `ANTHROPIC_API_KEY` /
  `OPENAI_API_KEY`.
- Changing the default model.
- Upgrading Mastra / AI SDK (would unlock newer provider lines).
- Any change to `edge/` or `frontend/`. Neither talks to an LLM.

## Impact / tradeoffs

- **Extra hop and extra dependency.** Every LLM call now goes LINE → Worker →
  container → OpenRouter → Google. An OpenRouter outage takes the bot down even
  if Google is healthy. Acceptable for a single-user personal bot.
- **A second data processor.** LINE user messages now transit OpenRouter as
  well as Google. Check the OpenRouter account's privacy settings (prompt
  logging, which upstream providers are allowed) against PDPA/GDPR
  expectations before relying on it for sensitive conversations.
- **Pricing.** OpenRouter lists `google/gemini-2.5-flash` at $0.30 / M input
  and $2.50 / M output tokens (from `GET /api/v1/models`, 2026-11-03). Credits
  are prepaid. A paid request fails with **402** in any of these cases:
  - the account balance can't cover the request's *estimated* cost (input
    tokens plus `max_tokens`, or a large default when `max_tokens` is unset);
  - the key's spending limit is reached;
  - the key has expired.
- **Free models** (`:free`) cost $0 and skip that estimate. They are rate
  limited instead: 20 requests/min, and 50 requests/day until $10 of credits
  have ever been purchased (1,000/day after). A negative balance also blocks
  free models
  ([OpenRouter limits](https://openrouter.ai/docs/api-reference/limits)).
- **Key expiry is a scheduled outage.** Put a reminder ahead of the key's
  expiry date to rotate it in the HF Space secrets.
