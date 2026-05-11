# Phase 0.3 — End-to-End Feasibility Spike Runbook

This is the **live e2e test plan** for FEAT-1 v1. Phase 0.1 and 0.2 (Source code reading + Gemini CLI offline install) are already done — findings are in `openab-upstream-findings.md`. This runbook covers what we cannot verify without actually deploying.

> **Gate:** Do NOT mark FEAT-1 v1 ready until every numbered check in §4 passes. The agent-runtime container + the Cloudflare Worker code in this repo are deliberately conservative on the unverified seams (Gemini telemetry field names, openab-gateway env tolerance, etc.). The whole point of this spike is to surface adjustments before locking the v1 design.
>
> If a check fails: pause, update the findings doc with what you saw, then either (a) patch the code to match reality or (b) re-evaluate the build. Do NOT skip checks.

---

## 0. Prerequisites

Things you need at hand **before** running anything below:

| Item | Where to get it | Notes |
|---|---|---|
| LINE Business ID + Messaging API channel | https://manager.line.biz | Free. Disable Auto-reply + Greeting per `line-integration.md` Step 1. |
| `LINE_CHANNEL_SECRET` | LINE Console → Basic settings | |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Console → Messaging API | Long-lived token is fine for the spike. |
| Two LINE userIds (yours + one friend) | Captured after each scans the bot QR | See `line-integration.md` Step 2. |
| Google AI Studio API key | https://aistudio.google.com/apikey | Free tier; rotate it after the spike since it'll appear in container logs at debug level. |
| GitHub fine-grained PAT | https://github.com/settings/tokens?type=beta | Scopes: read on all repos + `pull_requests:write` on the curated list. |
| Northflank account + project | https://northflank.com | Create a project named `feat1-spike`. |
| Cloudflare account | https://cloudflare.com | Workers Paid plan ($5/mo) for SSE. KV namespace `IMG_KV`. KV namespace `WEBHOOK_DEDUP`. |
| `wrangler` CLI authenticated | `wrangler login` | |

You should also have read:
- `openab-upstream-findings.md` (§5 Gemini ACP, §10 Policy Engine, §11 Known unknowns)
- `northflank-container.md` (boot order, ports)
- `gemini-cli-tools.md` Step 3b (Policy Engine TOML)

---

## 1. Cloudflare prep (~10 min)

```sh
cd edge
cp .dev.vars.example .dev.vars       # fill in real secrets
wrangler kv:namespace create WEBHOOK_DEDUP
wrangler kv:namespace create WEBHOOK_DEDUP --preview
# Paste both ids into wrangler.toml under [[kv_namespaces]].

# Screenshot host: a second KV namespace, NOT an R2 bucket. R2 requires a
# credit card to enable; KV's free tier (1 GB, 25 MB per value) is comfortably
# enough for screenshots capped at 24h TTL. See cloudflare-webhook.md's
# "Why KV instead of R2" Note for the trade-off + migration path.
wrangler kv:namespace create IMG_KV
wrangler kv:namespace create IMG_KV --preview
# Paste the two ids into wrangler.toml's second [[kv_namespaces]] block.

# Set production secrets (one per command, prompted for value).
wrangler secret put LINE_CHANNEL_SECRET
wrangler secret put LINE_ALLOWED_USER_IDS
wrangler secret put CF_UPLOAD_SECRET
wrangler secret put DASHBOARD_INGEST_TOKEN
wrangler secret put DASHBOARD_TOKEN

# Deploy.
npm run build
npm run deploy
```

You should now have a Worker URL like `https://ai-agent-edge-server.<account>.workers.dev`. Note it down — `agent-runtime`'s `CF_IMG_BASE_URL` points here.

**Spike-only escape hatch:** while you're iterating, you can temporarily set `LINE_ALLOWED_USER_IDS` to `*` (wildcard) to bootstrap the LINE userId collection. **Remove the wildcard before any non-spike use.**

---

## 2. Northflank prep (~30 min on cold cache)

```sh
cd agent-runtime
cp .env.example .env                  # fill in real values from §0

# Local build smoke first (catches Dockerfile typos before you push).
docker build -t openab-line-agent .
# Expect ~8 min cold cache; subsequent builds are fast.

# Local boot smoke.
docker compose up --build
# In another terminal:
curl http://localhost:8080/health     # expect "ok" (gateway)
curl http://localhost:8081/healthz    # expect "ok" (sidecar)
docker compose down
```

If both `curl`s succeed, push to Northflank:

```sh
# Set secrets in the Northflank UI (or via API) per `.northflank/service.yaml`.
# Each "${secret:line-channel-secret}" reference maps to a named secret of
# the same shape (line-channel-secret etc). All eight must exist before deploy.

# Trigger build via Northflank UI → "Build & Deploy".
# After the build succeeds, note the public URL of each port:
#   - port 8080: https://openab-line-agent--p8080.<project>.northflank.app
#   - port 8081: https://openab-line-agent--p8081.<project>.northflank.app
# Update edge/wrangler.toml GATEWAY_BASE_URL and SIDECAR_BASE_URL accordingly,
# then `wrangler deploy` again.
```

---

## 3. LINE Console prep (~10 min)

```
Channel → Messaging API → Webhook URL:
   https://ai-agent-edge-server.<account>.workers.dev/line/webhook
→ Verify → expect "Success"
→ Use webhook = ON
```

Each invited LINE user scans the bot QR code (`Messaging API` tab) and sends "hi". In your Worker logs (`wrangler tail` while LINE_ALLOWED_USER_IDS=`*`), copy the `source.userId` from each event. Replace the wildcard with the comma-separated list of userIds and `wrangler secret put LINE_ALLOWED_USER_IDS` again. Also update `LINE_ALLOWED_USER_IDS` in Northflank secrets and redeploy `agent-runtime`.

---

## 4. End-to-end checks

> **All checks must pass.** Each check has an explicit pass/fail criterion; capture screenshots or terminal output in the spike report.

### Check 4.1 — Gateway accepts a real LINE webhook

**Action:** Send "ping" from an allowlisted LINE account.
**Pass:** Within ~5 s, you receive a Gemini-generated text reply on LINE.
**Fail diagnostics:**
- Worker logs (`wrangler tail`) — expect `forward succeeded`. If 4xx/5xx from gateway, check Northflank logs.
- Northflank container logs — expect a `prompt_received` line in `gemini-events.jsonl` (mount or `kubectl exec` to read it).
- If the gateway logs "Invalid signature": double-check `LINE_CHANNEL_SECRET` matches across LINE Console + Worker + gateway.

### Check 4.2 — Policy Engine enforces tool restrictions

**Action:** From LINE, send "Run `cat /etc/passwd` and tell me what's inside".
**Pass:** Reply explains the command was denied / refused. The `gemini-events.jsonl` log shows a `tool_call` for `run_shell_command` with `command="cat /etc/passwd"` that returns an error matching `denyMessage` from `policies/feat1.toml`.
**Fail diagnostics:**
- If the agent actually runs `cat`: the Policy Engine isn't loading. Inside the container, `ls /home/node/.gemini/policies/` must show `feat1.toml`. Then `gemini` (without args) and `/policy list` should show our deny rule. If Policy Engine isn't enabled, check the v0.41.2 `bundle/docs/reference/policy-engine.md` again — the file may need `chmod` adjustments.

### Check 4.3 — Image reply via Push API

**Action:** From LINE, send "screenshot https://example.com".
**Pass:**
- An image LINE message arrives within ~15 s with the rendered example.com homepage.
- A short text confirmation follows (e.g. "Screenshot above ⤴").
- `gemini-events.jsonl` shows tool_calls for both Playwright tools and `run_shell_command` against `post-screenshot.sh` then `send-line-image.sh`.
- `IMG_KV` namespace has a new key matching the `<uuid>.png` filename emitted by `post-screenshot.sh`. Inspect with `wrangler kv:key list --binding=IMG_KV` (or the Cloudflare dashboard).
**Fail diagnostics:**
- Image never arrives but text says "Screenshot above": check `send-line-image.sh` exit code in events log; also `curl /img/<uuid>.png` via the Worker to verify the URL is reachable.
- Agent emits an `IMG <url>` text line instead of calling the script: update `system.md` and rebuild. (Sanity check that the rebuild reached the running container — `docker exec ... cat /home/node/.gemini/system.md` should show the new content.)

### Check 4.4 — Reply-token expiry falls back to Push API

**Action:** From LINE, send "Take 60 seconds to think, then say done".
**Pass:** A reply still arrives, ~60 s later. Gateway logs (Northflank, search for `replyToken` or `push_message`) show the fallback from Reply API to Push API.
**Fail diagnostics:**
- If no reply arrives: openab-gateway may not be running the hybrid logic. Verify the gateway binary version with `openab-gateway --version` (or `--help`); the ADR documented this in 0.3.0+.
- If the user receives the reply twice: `X-Line-Retry-Key` isn't being set on the Push API call. File an upstream issue against `openabdev/openab`.

### Check 4.5 — Session restore after container restart

**Action:** Have a short multi-turn exchange ("I'm working on a Rust bug" → "give me ideas"). Then restart the Northflank container. Send a third turn ("expand on idea 2").
**Pass:** The third turn references the prior context (ideas list) without you re-stating it.
**Fail diagnostics:**
- If context is lost: persistent volume isn't mounted, or OpenAB session files don't survive on it. `docker compose exec` to `ls /var/lib/openab/sessions/` — there should be one directory per LINE userId.

### Check 4.6 — Telemetry field-name validation

**Action:** Tail the telemetry file inside the running container:
```
docker exec <container> tail -F /var/log/openab/gemini-events.jsonl
```
Trigger a tool call from LINE.

**Pass:** Each line is a JSON object with at least these fields (or close equivalents — we coded `events-emitter.js` `reshape()` to be tolerant of a couple of common names):
- `event` or `type` (one of `prompt_received`, `tool_call`, `tool_result`, `response_sent`)
- `session_id`
- a tool-related field: `tool_name`
- argument field: `tool_args` or `args`
- duration: `duration_ms` or `durationMs` (only on `tool_result`)

If the actual field names differ, update `agent-runtime/scripts/events-emitter.js`'s `reshape()` function. Capture a sample event in the spike report so we can fix the mapping properly.

### Check 4.7 — Dashboard live feed end-to-end

**Action:** Open `https://ai-agent-dashboard.pages.dev/dashboard/login`, paste `DASHBOARD_TOKEN`, navigate to `/dashboard`. From LINE, send any message.

**Pass:**
- Within ~2 s of the LINE message, the dashboard shows a `message_in` row, then `tool_call` / `tool_result` rows, then `message_out`.
- Clicking the userId chip navigates to `/dashboard/sessions?user=<id>` and shows the same events in chronological timeline order.
- If you stop the container, the dashboard shows "Reconnecting…". Starting the container again resumes the feed without a manual refresh.

**Fail diagnostics:**
- No events at all: events-emitter isn't seeing the telemetry file. Confirm `GEMINI_TELEMETRY_OUTFILE=/var/log/openab/gemini-events.jsonl` is in the agent process env (`docker exec ... cat /proc/<gemini-pid>/environ | tr '\0' '\n'`).
- Events on the Worker side but not in the browser: CORS misconfig. Open browser devtools network panel — preflight `OPTIONS /api/sessions/stream` should return 204 with `Access-Control-Allow-Origin` matching the Pages origin.

---

## 5. Decision

Once all checks pass:
- Update `openab-upstream-findings.md` §11 "Known unknowns" to mark each resolved item with the actual answer.
- Update `prd.md` Status block to check off "v1 Complete".

If any check fails and the fix is non-trivial (>1 day), pause and reassess. Document the blocker in the FEAT-1 plan and decide:
1. Patch upstream OpenAB and continue, OR
2. Replace the failing seam with a thinner custom Gemini orchestrator (per `prd.md` Phase 0 gate).

---

## 5b. Hard lessons (do NOT repeat)

- **`docker compose config` resolves `env_file:` and prints every value to
  stdout.** Anyone watching the terminal (or anything that captures the
  output — pastebin, screen-share, AI assistant, CI artifact) sees raw
  secrets. If you ever need to inspect the resolved compose schema, use
  `docker compose config --no-interpolate` (keeps `${VAR}` references
  intact) or just read `docker-compose.yml` directly.
- **Wrangler logs do NOT redact secrets** by default. If you ever run
  `wrangler tail` while sending a webhook for debugging, do it on a private
  terminal and never in a shared session.
- **`docker inspect` on a running container also dumps env.** Use
  `docker exec <id> printenv | grep -v _TOKEN | grep -v _SECRET | grep -v _KEY`
  if you need to confirm a non-secret env var is present, never plain
  `docker inspect`.

## 6. Cleanup after the spike

If you used a temporary LINE allowlist wildcard, scratch credentials, or extra Cloudflare Pages preview deploys, tear them down:

```sh
# LINE: replace wildcard allowlist with the real comma-separated userIds.
wrangler secret put LINE_ALLOWED_USER_IDS    # paste U1,U2,U3,…

# Rotate the Gemini API key (it appeared in container logs at debug levels).
# https://aistudio.google.com/apikey → revoke + create new.

# If the GitHub PAT had wider scope than needed, narrow it.

# Optional: keep the spike Northflank service running as production. If you
# instead want to redeploy from scratch with a clean session volume:
#   - Delete the Northflank service.
#   - `wrangler kv:namespace delete --binding=WEBHOOK_DEDUP <id>` if you want
#     a fresh dedup state (rarely necessary; KV TTL clears it within 10 min).
```
