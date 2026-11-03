# FIX-3 — Implementation: Worker cron keep-alive + loud GitHub backup

See `../plans/hf-keep-alive.md` for the root cause and decisions.

## Files changed

| File | Change |
|---|---|
| `edge/src/keepAlive.ts` | **New.** `pingAgentRuntime(baseUrl)`: `GET ${baseUrl}/healthz` with a 30 s timeout. Throws on network error, non-2xx, or a body without `ok: true`. Logs uptime on success. |
| `edge/src/index.ts` | Default export gains `async scheduled(_controller, env, _ctx)`, which awaits `pingAgentRuntime(env.GATEWAY_BASE_URL)`. |
| `edge/wrangler.toml` | `[triggers] crons = []` → `["0 */6 * * *"]`. |
| `edge/test/keepAlive.test.ts` | **New.** 6 tests (below). |
| `.github/workflows/hf-sync.yml` | `keep-alive` job: `curl … / \|\| true` → `curl --fail … /healthz` with retries plus a body check. |
| `README.md`, `CLAUDE.md` | CI/CD section, module list, docs index. |

## Why `scheduled` awaits instead of `ctx.waitUntil`

If the handler awaits the ping and it throws, Cloudflare records the cron
invocation as failed (Cron Events and Workers Logs with
`invocation_logs = true`, already on in `wrangler.toml`). Fire-and-forget would
hide exactly the failure FIX-3 is about.

## Why `[triggers]` must stay explicit

Omitting `[triggers]` keeps whatever schedules already exist on Cloudflare
when you deploy. Listing `crons` replaces them. This list is the full set of
schedules for the Worker, which also keeps the retired FEAT-4 curator cron
cleared (see `ee14cc1`).

## GitHub backup step

```bash
BODY=$(curl --fail --silent --show-error --max-time 30 \
  --retry 3 --retry-delay 20 --retry-all-errors \
  https://andy770921-ai-agent.hf.space/healthz)
echo "HF Space /healthz: $BODY"
echo "$BODY" | grep -q '"ok":true'
```

GitHub runs `run:` blocks with `bash -eo pipefail`. A failing `curl` inside
the assignment, or a failing `grep`, therefore fails the step. The retries
(about 60 s total) absorb a Space that is still waking up.

## Verification (2026-11-03)

- **Unit tests:** `cd edge && npx vitest run` → 50/50 passed, 6 new in
  `keepAlive.test.ts`:
  - healthy `/healthz` resolves; URL, timeout signal and the uptime log line
    are checked;
  - HTTP 503 rejects;
  - a network error rejects;
  - a 200 with an HTML body rejects;
  - `worker.scheduled` pings `GATEWAY_BASE_URL/healthz`;
  - `worker.scheduled` rejects when the ping fails.
- **Static checks:** `tsc --noEmit`, eslint and prettier are clean.
- **Bundle:** `wrangler deploy --dry-run` bundles fine (35.7 KiB).
- **Real runtime, live Space:**
  `wrangler dev --test-scheduled` then
  `curl 'http://127.0.0.1:8799/__scheduled?cron=0+*/6+*+*+*'` logged
  `keep-alive: https://andy770921-ai-agent.hf.space/healthz ok (uptime 331.2s)`.
- **GitHub step, run locally** with `bash --noprofile --norc -eo pipefail`:
  - against the live Space: prints the body, exit 0;
  - against a 404 path: 1 attempt + 3 retries, then exit 56, so the run
    would fail.

## Deployment checklist

1. `cd edge && wrangler deploy`. The output should list the trigger
   `schedule: 0 */6 * * *`.
2. Wait up to 15 min for the trigger to propagate (per Cloudflare docs).
   Then, in Dashboard → Workers → `ai-agent-edge-server` → Settings → Triggers,
   confirm the cron is listed.
3. After the next `:00` of an hour divisible by 6 (UTC), check
   **Cron Events**: the first run should be `Success`. New events can take up
   to 30 min to appear. **Do not skip this step.** A fresh or modified
   schedule is where silent non-dispatch has been reported.
4. GitHub → Actions → "Sync to Hugging Face Space" → **Enable workflow**. A
   push does not re-enable a workflow that GitHub disabled for inactivity.
5. Push to `main`. Only `agent-runtime/**` changes trigger the HF sync job, so
   this commit doesn't rebuild the Space.

**Rollback:** set `crons = []` and redeploy the Worker. The GitHub job keeps
working on its own once re-enabled.

## Operating notes / follow-ups

- **Symptoms of a failure:**
  - a red scheduled run in GitHub Actions (emailed to whoever last edited the
    cron line);
  - failed entries in the Worker's Cron Events.
- **If both pingers stop:** this means the Cloudflare cron stopped *and* the
  GitHub schedule is disabled. GitHub's disablement is predictable: 60 days
  without a push. Re-enable it in the Actions tab.
- **Possible follow-up, cross-check heartbeat:** the Worker could record its
  last successful ping (e.g. in KV) and expose it. The GitHub job would then
  fail if that timestamp is older than ~13 h. A silently stopped Cloudflare
  cron would turn red on GitHub instead of only showing as missing Cron Events.
  Not built yet. It adds a KV write per run and a new public route.
