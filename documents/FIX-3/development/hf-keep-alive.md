# FIX-3 — Implementation: Worker cron keep-alive

See `../plans/hf-keep-alive.md` for the root cause and decisions.

## Files changed

| File | Change |
|---|---|
| `edge/src/keepAlive.ts` | **New.** `pingAgentRuntime(baseUrl)`: `GET ${baseUrl}/healthz` with a 30 s timeout. Throws on network error, non-2xx, or a body without `ok: true`. Logs uptime on success. |
| `edge/src/index.ts` | Default export gains `async scheduled(_controller, env, _ctx)`, which awaits `pingAgentRuntime(env.GATEWAY_BASE_URL)`. |
| `edge/wrangler.toml` | `[triggers] crons = []` → `["0 */6 * * *"]`. |
| `edge/test/keepAlive.test.ts` | **New.** 6 tests (below). |
| `.github/workflows/hf-sync.yml` | Removed the `schedule` trigger, the `keep-alive` job, and the `sync` job's `if: github.event_name != 'schedule'`. The push (`main` + `agent-runtime/**`) and `workflow_dispatch` triggers and the `sync` job's steps are unchanged. A header comment explains why there is no schedule. |
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

## Why `hf-sync.yml` must not get a `schedule` back

GitHub's 60-day inactivity rule applies to *scheduled* workflows, and
disabling stops the workflow from being triggered at all. While `hf-sync.yml`
had a `schedule`, a quiet repo could therefore switch off the HF sync on push
too. Without one, the sync workflow is no longer subject to that rule.

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
- **Workflow:** `hf-sync.yml` parsed with `js-yaml`. Triggers are `push`
  (`main`, `agent-runtime/**`) and `workflow_dispatch`, and the only job is
  `sync`.

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
4. GitHub → Actions → "Sync to Hugging Face Space" → **Enable workflow**. It is
   still `disabled_inactivity` from before this fix, so pushes to
   `agent-runtime/**` (e.g. FEAT-6) won't sync to HF until it's re-enabled. A
   push does not re-enable it. Once re-enabled, it won't be auto-disabled
   again because it no longer has a schedule.
5. Push to `main`.

**Rollback:** set `crons = []` and redeploy the Worker. Restoring the old
GitHub schedule would bring back the 60-day problem, so don't treat it as a
rollback path.

## Operating notes / follow-ups

- **Symptom of a failure:** failed or missing entries in the Worker's Cron
  Events. The bot going quiet is the late symptom, about 48 h after pings
  stop.
- **Quick manual check:**
  `curl -sS https://andy770921-ai-agent.hf.space/healthz` should return
  `{"ok":true,…}`. A small `uptime` value means the Space restarted recently.
- **Possible follow-up:** if a silent multi-day Cloudflare stop ever happens,
  add an external uptime monitor on `/healthz` for email alerts.
