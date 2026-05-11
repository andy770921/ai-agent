# Implementation Plan: LINE Integration

## Overview

Stand up the LINE Messaging API channel that fronts the whole system, configure its webhook to point at the Cloudflare Worker (which forwards to the OpenAB **gateway**), collect the LINE userIds of the invited allowlist, and document the reply paths (text vs image) the agent-runtime container uses to talk back.

This plan is **mostly LINE Console clicks + secret rotation**. There is no glue code in `agent-runtime/` for `replyToken` expiry — that's already implemented inside `openab-gateway` (verified in Phase 0.1; see `openab-upstream-findings.md` §3).

## Prerequisites

- A LINE Business ID (free).
- A "Provider" in the LINE Developers Console (free).

## Files to Create / Modify

LINE Console clicks only — no source code. `openab-gateway` handles HMAC verification and the replyToken/pushMessage hybrid natively, and image replies go through `send-line-image.sh` inside the agent (see `gemini-cli-tools.md` Step 5b), not through a gateway-side parser.

```
edge/
└── (no new files — already covered in cloudflare-webhook.md)
documents/FEAT-1/plans/
└── line-onboarding-runbook.md       # NEW — step-by-step LINE Console runbook
                                     # (created during this implementation step)
```

## Step-by-Step Implementation

### Step 1: Create a LINE Messaging API channel

In the [LINE Developers Console](https://developers.line.biz/console/):

1. Create a Provider if none exists (e.g., `Andy Personal`).
2. Inside that Provider → **Create a new Messaging API channel**.
3. Name: `OpenAB Personal Agent`. Description: brief. Region: `JP` (default).
4. Under **Messaging API settings**:
   - Disable **Auto-reply messages**.
   - Disable **Greeting messages**.
   - Enable **Use webhook** = ON.
   - Webhook URL: leave blank for now (filled in Step 4).
5. Under **Basic settings**:
   - Note the **Channel secret** → store as Northflank secret `LINE_CHANNEL_SECRET` (consumed by `openab-gateway`) and Cloudflare Worker secret `LINE_CHANNEL_SECRET` (consumed by the Worker's fast-fail HMAC pre-check).
6. Under **Messaging API settings** → **Channel access token**:
   - Issue a long-lived **channel access token** (or use the rotated short-lived one if you'll run a refresh job). For v1, long-lived is fine.
   - Store as Northflank secret `LINE_CHANNEL_ACCESS_TOKEN`. This is consumed by **both** `openab-gateway` (for its Reply/Push API calls) and the agent process itself via OpenAB's `[agent].env` (for `send-line-image.sh`).

**Rationale:** Auto-reply and greeting messages confuse users when there's a real bot behind it. Disable both. Same secret reaches three consumers (Worker, gateway, agent); rotating it means rotating all three at once.

### Step 2: Collect LINE userIds for the allowlist

LINE userIds are not visible to users; they're surfaced only after the user has interacted with the bot and a webhook event has fired with `events[].source.userId`. Procedure:

1. Temporarily set `LINE_ALLOWED_USER_IDS=*` (wildcard) in the Worker — see Step 3.
2. Each invited person scans the bot's QR code (in **Messaging API settings** → "Bot basic ID / QR code") and sends any text.
3. Inspect the Worker's logs (`wrangler tail`) for the `events[].source.userId` value. Copy it.
4. After all userIds are collected, set `LINE_ALLOWED_USER_IDS` to the comma-separated list. **Remove the wildcard.**

> **Security note:** never leave `*` in production — it would let anyone DM the bot. Treat the wildcard window as a one-time bootstrap.

**Rationale:** there's no LINE API to look up "who is in my friend list" with userIds; the webhook is the only authoritative source.

### Step 3: Rate-limit + abuse handling at the Worker

Already covered in `cloudflare-webhook.md`, but for completeness:

- Allowlist enforcement at the Worker (defense layer 1).
- Allowlist enforcement at OpenAB (defense layer 2; see `openab-config.md`).
- A simple per-user rate limit can be added in the Worker using Cloudflare KV or Durable Objects later (deferred to v1.5).

### Step 4: Wire the webhook URL

Once the Cloudflare Worker is deployed (`wrangler deploy`):

1. Copy its public URL, e.g., `https://openab-line-edge.<account>.workers.dev`.
2. In LINE Console → **Messaging API settings** → **Webhook URL**: paste `https://openab-line-edge.<account>.workers.dev/line/webhook`.
3. Click **Verify**. LINE sends a test event; expect `Success`.
4. Toggle **Use webhook** = ON if not already.

**Forwarding path:** The Worker forwards verified events to the gateway endpoint `https://<container>.northflank.app/webhook/line` (per `openab-gateway`'s documented routes — see `openab-upstream-findings.md` §2). The gateway re-verifies the HMAC against the request bytes it sees and then pushes the event over the WebSocket link to `openab` core.

**Rationale:** the verify button is the canonical end-to-end check that signature verification works on a real LINE-signed payload, all the way through Worker → gateway. The two-layer HMAC check (Worker fast-fail + gateway authoritative) is intentional: the Worker stops obvious garbage at the edge without waking the container, but the gateway is the trust boundary.

### Step 5: ~~Reply-message handling inside `agent-runtime/`~~ — DELEGATED to `openab-gateway`

> **Rewritten (per `openab-upstream-findings.md` §3).** The previous version of this step assumed we had to implement the `replyMessage` / `pushMessage` switch ourselves, possibly via a Node helper at `agent-runtime/scripts/line-helper.js`. **That helper is no longer needed.** The OpenAB upstream `gateway/src/adapters/line.rs` (read on 2026-05-11) already implements the hybrid strategy:
>
> 1. On webhook receipt, the gateway generates an `event_id` (UUID), caches `event_id → replyToken` with a **50-second TTL**, and forwards the event over WebSocket to OpenAB core.
> 2. When OpenAB core replies, the gateway looks up the cached `replyToken`. Fresh ⇒ Reply API (free). Expired or missing ⇒ Push API (counts toward quota).
> 3. Background sweeper reaps expired cache entries.
>
> All of this is the gateway's responsibility; the agent emits plain text and the gateway picks the right LINE endpoint. The `line-helper.js` fallback and its `X-Line-Retry-Key` derivation are **deleted from this plan**. The Cloudflare Worker's KV dedup (`cloudflare-webhook.md` Step 3) still wraps the gateway as an additional outer ring against webhook replays.

There is still **one** outbound LINE API call that the FEAT-1 agent makes directly — image messages, via `send-line-image.sh` (see `gemini-cli-tools.md` Step 5b). That script:

- Reads `LINE_CHANNEL_ACCESS_TOKEN` from the agent's process env.
- Generates a fresh UUID per call and sends it as `X-Line-Retry-Key`.
- POSTs an image-message to LINE's Push API.

This is the **only** code path in FEAT-1 that talks to `api.line.me` directly outside the gateway. It's necessary because OpenAB does not relay images.

### Step 6: Image reply path

> **Rewritten (per `openab-upstream-findings.md` §4).** The previous version of this step described a gateway-side `IMG <url>` prefix parser. **That parser does not exist in OpenAB upstream** — `bundle/docs/sendimages.md` explicitly states "OpenAB does **not** relay images from the agent... the agent must call the [platform] API directly." We follow that pattern.

**Concrete flow (v1):**

1. The agent (Gemini) calls Playwright MCP and saves a PNG to `/tmp/x.png`.
2. The agent runs `/usr/local/bin/post-screenshot.sh /tmp/x.png` → R2 upload via the Worker → prints `https://<worker>.workers.dev/img/<uuid>.png`.
3. The agent reads `sender_context.sender_id` from the incoming prompt (OpenAB injects this block; see `openab-upstream-findings.md` §6).
4. The agent runs `/usr/local/bin/send-line-image.sh <sender_id> <url-from-step-2>`. The script POSTs the LINE Push API.
5. The agent's text reply (a brief confirmation) flows through OpenAB → gateway → LINE Reply or Push (via the hybrid logic in Step 5).

The exact `image` message payload sent to LINE by `send-line-image.sh`:

```json
{
  "to": "<userId>",
  "messages": [{
    "type": "image",
    "originalContentUrl": "https://openab-line-edge.<account>.workers.dev/img/<uuid>.png",
    "previewImageUrl":   "https://openab-line-edge.<account>.workers.dev/img/<uuid>.png"
  }]
}
```

(For v1 we use the same URL for both `originalContentUrl` and `previewImageUrl`; LINE accepts that. A real preview-thumbnail pipeline is v2.)

**Why this pattern instead of patching OpenAB upstream:**

| Option | Description | Pros | Cons | Decision |
|---|---|---|---|---|
| A | Agent calls LINE Push API directly via `send-line-image.sh` | No upstream changes; lands today | `LINE_CHANNEL_ACCESS_TOKEN` reaches the agent process (acceptable per OpenAB's documented tradeoff) | **chosen for v1** |
| B | Patch `openab-gateway` to parse a new `[[image:<url>]]` output directive | Cleaner long-term; agent stays text-only | Requires upstream PR + release cycle; merge risk | deferred to v2 |
| C | "IMG <url>" prefix in plain text + sidecar parser | Doesn't need upstream changes; doesn't expose token to agent | Ambiguous with normal URL citations; sidecar becomes a parser of unstructured text | rejected |

The relevant cross-doc contracts (Option A landed):

- `gemini-cli-tools.md` Step 4 — system prompt instructs the agent to read `sender_context.sender_id` and run the two scripts.
- `gemini-cli-tools.md` Step 5b — defines `send-line-image.sh`.
- `gemini-cli-tools.md` Step 3b — Policy Engine allows that script's `commandPrefix`.
- `openab-config.md` Step 2 — `[agent].env` exports `LINE_CHANNEL_ACCESS_TOKEN`.

### Step 7: Quota & cost monitoring

LINE's free Messaging API plan allows 200 push messages/month. Our reply path uses `replyMessage` whenever possible (free, doesn't count). With ≤5 users and intermittent use, we should stay well inside the free quota — but **enable email notifications** in the LINE Console for "monthly message quota at 80%" so we know if we're trending over.

If we exceed: upgrade to the LINE "Light" plan (~5,000 msg/mo) or implement aggressive replyToken-only behavior. Out of scope for v1.

## Testing Steps

1. **Webhook verification:** click "Verify" in LINE Console → expect `Success`. Worker logs show a verify-event.
2. **Bootstrap allowlist:** with allowlist temporarily wildcarded, message the bot from each invited LINE account. Collect all `source.userId` values from Worker logs. Lock the allowlist.
3. **Reject non-allowlisted users:** message from a fresh LINE account → expect no reply, Worker log shows "dropped".
4. **Text reply round-trip:** send `ping` → expect a Gemini-generated reply within ~5s.
5. **Image reply round-trip:** send `screenshot https://example.com` → expect an image message with the rendered homepage.
6. **`replyToken` expiry:** send a deliberately slow request (e.g., "fetch and summarize this 50-page PDF") → expect the bot to switch to `pushMessage` after 25s and the user still receives the reply.
7. **Quota probe:** check LINE Console's quota dashboard; verify `pushMessage` count is small (most replies should hit `replyMessage`).

## Dependencies

- Must complete before: end-to-end smoke test of the whole system.
- Depends on: `cloudflare-webhook.md` (Worker URL), `northflank-container.md` (container deployed), `openab-config.md` (TOML wired), `gemini-cli-tools.md` (system prompt mentions image-URL convention).

## Notes

- **Why use a Provider + a single channel?** A LINE Provider is free and groups channels under one entity. We may add a v2 channel later for a different bot persona; the Provider gives us a place to put it.
- **Why long-lived channel access token vs short-lived (`Channel access token v2.1`)?** Short-lived tokens require a refresh job inside the container. For ≤5 users this is unnecessary complexity; rotate the long-lived token quarterly via a calendar reminder.
- **Personal data note:** LINE userIds are pseudonymous identifiers, not PII. Storing them in env is OK. Do NOT store users' real names, profile pictures, or message contents outside the persistent volume (which is itself encrypted-at-rest by Northflank).
- **Future: rich messages.** LINE supports flex messages, carousels, postback buttons. v1 sticks to text + image. v2 can add a "PR review carousel" once we know the dashboard exists.
