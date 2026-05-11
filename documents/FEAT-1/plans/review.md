# FEAT-1 Plan Review (Codex Adversarial)

- Date: 2026-05-08
- Target: `documents/FEAT-1/plans/prd.md` + `documents/FEAT-1/development/*.md` (working tree)
- Verdict: **needs-attention** — No-ship as currently scoped.

## Summary

The plan currently depends on:

1. An unsafe Gemini execution model (tool confinement is not actually enforced).
2. A LINE webhook path that can both lose and replay events.
3. An unproven OpenAB contract (the config is admitted-guess).
4. Materially wrong Northflank sizing / cost assumptions.

A thin feasibility spike is required before any dashboard / BFF / container build-out work continues.

## Findings

### 1. [critical] Gemini tool confinement is not actually enforced
- File: `documents/FEAT-1/development/gemini-cli-tools.md:62-91`
- Issue: Plan relies on `tools.shell.allow` to restrict shell to two commands, but Gemini CLI's documented policy knobs are `tools.core`, `tools.allowed`, `tools.confirmationRequired`, and `tools.sandbox*` (see https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md). There is no documented `tools.shell.allow` key.
- Impact: The pseudo-allowlist will not remove default built-in shell/file/web tools. Combined with OpenAB enabling unattended `--trust-all-tools`, a prompt-injected repo page or browser session can read files, hit the network, or exfiltrate `GITHUB_TOKEN` / LINE secrets from the container.
- Recommendation:
  - Replace pseudo-allowlist with documented `tools.core` / `tools.exclude` policy.
  - Enable Gemini sandboxing (`tools.sandbox*`).
  - Mount secrets outside the agent-visible workspace where possible.
  - Do not auto-trust tools until an end-to-end policy test proves only the intended commands are reachable.

### 2. [high] Webhook ingress is neither reliable nor idempotent
- File: `documents/FEAT-1/development/cloudflare-webhook.md:206-245`
- Issue: `handleLineWebhook` acks LINE immediately and only does best-effort forward in `ctx.waitUntil`, swallowing errors with `console.error`. It never persists `webhookEventId` or checks `deliveryContext.isRedelivery`. See https://developers.line.biz/en/docs/messaging-api/receiving-messages/.
- Impact:
  - Upstream outages or restarts drop messages permanently after a 200.
  - Redeliveries or duplicate posts can replay the same GitHub or browser action twice.
- Recommendation:
  - Store `webhookEventId` with a TTL (e.g. KV / D1) before forwarding.
  - Propagate a deterministic idempotency key downstream into OpenAB / Gemini executions.
  - Queue or persist the event before returning 200 (use Cloudflare Queues if needed).
  - For outbound push retries, use `X-Line-Retry-Key` so retry cannot double-send.

### 3. [high] Runtime image omits files that later steps depend on
- File: `documents/FEAT-1/development/northflank-container.md:92-99`
- Issue: Dockerfile only copies `openab.toml`, `settings.json`, `entrypoint.sh`, `healthz.js`. But:
  - `settings.json` references `/etc/openab/system-prompt.md`.
  - The shell policy references `/usr/local/bin/post-screenshot.sh`.
  - `healthz.js` later spawns `/usr/local/bin/events-emitter.js`.
- Impact: Screenshot flow and dashboard emitter are missing from the image before integration even starts.
- Recommendation:
  - Copy and `chmod` every referenced runtime asset (`system-prompt.md`, `post-screenshot.sh`, `events-emitter.js`).
  - Add a container smoke test that boots Gemini config, invokes the screenshot helper, and starts the emitter process.

### 4. [high] Northflank sizing and cost math are materially wrong
- File: `documents/FEAT-1/development/northflank-container.md:313-346`
- Issue: Plan selects `nf-compute-20` as `1 vCPU / 2 GB RAM, ~$13/mo`. Actual Northflank pricing (crawled 2026-05-08, https://northflank.com/pricing):
  - `nf-compute-20` = 0.2 shared vCPU / 512 MB / **$5.40/mo**
  - `nf-compute-100-2` (1 dedicated vCPU / 2 GB) = **$24/mo**
- Impact: Nominated SKU cannot satisfy memory assumptions elsewhere; true always-on baseline is well above stated budget before storage or paid Workers.
- Recommendation:
  - Re-baseline architecture on an actually available SKU.
  - Benchmark Playwright memory on that exact plan.
  - Update every cost/risk document before implementing around Northflank as default host.

### 5. [high] OpenAB is still a hypothesis, not a validated foundation
- File: `documents/FEAT-1/development/openab-config.md:9-58`
- Issue: The doc itself says key paths may differ, instructs the implementer to read upstream source before writing TOML, and notes Gemini ACP flag may be different. Yet OpenAB is the chosen "glue-free" base.
- Impact: Framework chosen as the foundation is unverified at exactly the seams you need most: LINE ingress, per-user sessioning, agent launch, tool policy. Building the Worker / dashboard / container around this contract is high rework risk.
- Recommendation: Do a thin feasibility spike first:
  1. Prove one real LINE message can reach OpenAB.
  2. Spawn Gemini in ACP mode.
  3. Survive a >30s reply path.
  4. Restore the same user session after restart.
  - If that requires patching OpenAB or inventing extra adapters, reassess whether a thinner custom Gemini orchestrator is lower risk than continuing with OpenAB.

## Cross-doc Contract Issues

- `IMG <url>` vs plain URL convention is inconsistent between `line-integration.md` and `gemini-cli-tools.md`.
- Wildcard allowlist bootstrap is unspecified.
- `line.sendInterim` is referenced but does not exist in the LINE Messaging API.

## Next Steps (Ordered)

1. **Spike OpenAB end-to-end** before doing more dashboard / BFF work.
2. **Redesign Gemini tool policy** using documented Gemini settings + sandboxing; remove auto-trust until verified.
3. **Add durable, deduped webhook ingress** and outbound idempotency keys before exposing GitHub or browser actions.
4. **Recalculate hosting cost** on actual Northflank and Cloudflare plans. If the budget cap is real, defer the dashboard and/or browser path until the core chat loop is proven.
5. **Resolve remaining cross-doc contracts** (`IMG <url>` format, wildcard allowlist bootstrap, nonexistent `line.sendInterim`) and add end-to-end tests for them.
