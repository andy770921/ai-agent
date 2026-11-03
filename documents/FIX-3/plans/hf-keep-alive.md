# FIX-3 — HF Space keep-alive stopped silently

## Problem

On 2026-11-03 the agent-runtime HF Space (`andy770921-ai-agent.hf.space`) was
found asleep, so LINE messages went unanswered until someone opened the Space.
The free `cpu-basic` tier sleeps a Space after 48 h without traffic
(`runtime.gcTimeout: 172800` from `GET https://huggingface.co/api/spaces/andy770921/ai-agent`).

FEAT-2 added a keep-alive for exactly this: the `keep-alive` job in
`.github/workflows/hf-sync.yml` pinged the Space every 12 hours.

## Root cause

1. **GitHub disabled the schedule.** The GitHub API reports the workflow's
   state as `disabled_inactivity`. GitHub documents: *"In a public repository,
   scheduled workflows are automatically disabled when no repository activity
   has occurred in 60 days."* The timeline matches exactly:

   | Date (UTC) | Event |
   |---|---|
   | 2026-07-09 | Last commits pushed (`244bda0`, `c923576`) |
   | 2026-09-07 | Last scheduled `keep-alive` run (07-09 + 60 days) |
   | 2026-10-05 | `ee14cc1` pushed, but a push does **not** re-enable a disabled workflow |
   | → 2026-11-03 | No pings → Space idle > 48 h → asleep |

2. **The job could never fail.** It ran `curl … https://…hf.space/ || true` and
   only echoed the status code. A sleeping or broken Space still produced a
   green run, so even while the schedule was active, nothing would have warned
   us.

## Decisions

| Question | Decision | Rationale |
|---|---|---|
| Primary keep-alive | **Cloudflare Worker Cron Trigger** (`edge/`), every 6 h, `GET /healthz`. | The Worker already exists and knows the Space URL. Cloudflare documents no inactivity-based disabling of Cron Triggers (unlike GitHub's 60-day rule). Usage is far inside Free-plan limits (see below). 6 h gives 8 attempts per 48 h window, so a few missed or failed runs can't let the Space sleep. |
| Keep the GitHub job? | **Yes, as an independent backup** (12 h). | The two schedulers fail for unrelated reasons: GitHub on a predictable 60-day inactivity rule, Cloudflare on rare platform incidents. Either one alone covers the 48 h window. |
| How does a failure become visible? | **Both pingers fail loudly.** The Worker's `scheduled` handler throws, so the invocation is marked failed in Cron Events / Workers Logs. The GitHub job uses `curl --fail` on `/healthz` plus a body check, so the run goes red, and GitHub notifies *"the user who last modified the cron syntax in the workflow file"*. | Fixes root cause 2. |
| What counts as healthy? | **HTTP 2xx and a JSON body with `ok: true`** (what `agent-runtime/src/ports/healthz.ts` returns). | `/` returned plain text and proved little. A 200 HTML interstitial (e.g. while the Space builds) must not count as healthy. |

### Can Cloudflare stop our cron the same way GitHub did?

Checked on 2026-11-03 against Cloudflare's docs:

- **[Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)**
  and **[Workers limits](https://developers.cloudflare.com/workers/platform/limits/)**
  contain no rule that pauses or disables Cron Triggers for inactivity, on any
  plan.
- **Free-plan limits that do apply:**
  - 5 Cron Triggers per account. We use 1; the FEAT-4 curator cron is cleared.
  - 10 ms CPU per Cron Trigger invocation. We do one `fetch` and a tiny JSON
    parse, and time spent waiting on the network is not CPU.
  - 15 min wall time per scheduled invocation. We cap the fetch at 30 s.
- **Residual risk is platform incidents, not policy.** Cloudflare's status
  history includes cron-execution incidents (e.g.
  [2021-01-29, ~1 h](https://cloudflarestatus.com/incidents/j4jg0mwf07j6)).
  Community threads also report schedules that silently stopped dispatching.
  Third-party trackers list more recent "Cron Trigger activation issues"
  incidents, reportedly affecting newly created or modified schedules. That
  detail is unverified because the pages were not readable. This is why the
  GitHub backup stays and why the post-deploy checklist verifies the first
  runs.

## Alternatives considered

- **HF paid hardware with sleep disabled.** Removes the problem entirely, but
  costs money. Not worth it for a single-user bot today.
- **Third-party uptime monitor** (UptimeRobot etc.). Works, but adds another
  account outside the repo. The Worker is already ours.
- **Dummy commits / auto re-enabling the GitHub workflow** to dodge the 60-day
  rule. Rejected: it games a platform policy, and the Worker cron makes it
  unnecessary.

## Scope

**In scope:** `edge/src/keepAlive.ts` (new), the `scheduled` export in
`edge/src/index.ts`, `[triggers]` in `edge/wrangler.toml`, the `keep-alive`
job in `hf-sync.yml`, tests, README / CLAUDE.md.

**Out of scope:** waking an already-sleeping Space via the HF API (needs an
HF token in the Worker), alerting beyond what Cloudflare and GitHub provide by
default, and any `agent-runtime/` change (`/healthz` already exists).
