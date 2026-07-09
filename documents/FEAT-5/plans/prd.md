# FEAT-5 — Remove Supabase (in-process stores + hardcoded config)

## Summary

Remove the external Supabase Postgres dependency from `agent-runtime/`. The
LINE agent no longer needs `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` (or the
`@supabase/supabase-js` package). Everything Supabase used to back — the system
prompt, model routing, conversation history, long-term memories, skills, user
records, curator bookkeeping, and advisory locks — now lives inside the running
container: config as hardcoded TypeScript constants, and mutable data in
in-process stores.

## Motivation

The request started from "long-term memory looks unused — can we drop
`SUPABASE_URL` / `SUPABASE_SERVICE_KEY`?" Investigation showed the premise was
only partly right:

- **Long-term memory really was dormant.** The extraction gate
  (`memory/gateCheck.ts`) requires `new_sessions >= 5`, where `new_sessions`
  counts `curator_runs` rows with `phase = 'session-end'`. **No code ever
  writes that phase**, so `new_sessions` is always `0` and extraction never
  runs. Memory retrieval therefore always reads an empty table.
- **But Supabase was never "just memory."** A single `createClient` in
  `src/db/client.ts` backed six subsystems, two of which run on every single
  message:
  - `agent_config` — `getSystemPrompt()` and `pickProvider()` read
    `system_prompt` / `default_model` inside `runTurn`'s `Promise.all`, and
    both **throw** if the row is missing. Without Supabase, every LINE reply
    would fail with "Sorry, something went wrong."
  - `messages` — multi-turn conversation history (last 50 loaded per turn).
  - `memories`, `skills`, `users`, `curator_runs` / `curator_backups`, plus
    ~11 RPC functions and advisory locks.

So dropping the two env vars naively would have bricked the agent. The feature
is worth removing, but only by re-homing the load-bearing pieces first.

## Decisions

| Question | Decision | Rationale |
|---|---|---|
| Scope | Full Supabase removal, but **re-home** the features into the codebase (not delete them) with a dedicated folder structure. | Keeps existing behavior (history, memory, skills, curator) working without an external DB. |
| Where do `system_prompt` / `default_model` live? | **Hardcoded TS constants** in `src/config/agentConfig.ts`. | Simplest; no DB, no runtime config surface. Change = edit + redeploy. |
| Conversation history | **In-memory per container** (bounded ring buffer per session). | Multi-turn context keeps working; resets on restart/rebuild — acceptable for a single-user personal bot. |
| Long-term memory / skills / curator | Re-homed to in-memory stores, kept wired but **memory extraction stays disabled** (it never ran anyway). | Preserves the code paths and dashboards; no behavior regression vs. today. |

## Scope

**In scope**
- Delete `src/db/` and `@supabase/supabase-js`.
- Add `src/config/` (constants) and `src/store/` (in-process stores).
- Rewrite every consumer to call the new modules.
- Delete `agent-runtime/supabase/` migrations.
- Update `.env.example`, `README.md`, `CLAUDE.md`.

**Out of scope**
- Durable local persistence (SQLite / file store). All state is ephemeral by
  design. See "Known tradeoffs / follow-ups" in the development doc if
  durability is needed later.
- Re-enabling long-term memory extraction (would need a `session-end`
  curator-run writer + flipping the `MEMORY_EXTRACTION_ENABLED` flag).
- Any change to `edge/` or `frontend/`. The Worker never read Supabase; the
  dashboard talks only to the Worker.

## Impact / tradeoffs

- **No external database to provision, secure, or pay for.** One fewer set of
  secrets to rotate; no PDPA/GDPR data-at-rest surface in Supabase.
- **All mutable state is per-container and resets on restart/rebuild.** HF
  Spaces rebuilds on every push to `main` and sleeps when idle, so in practice
  history rarely survives long. This matches the previous *effective* behavior
  for memory (which never persisted anything) but is a real change for chat
  history, which previously survived restarts.
- **Config changes now require a redeploy** instead of a Supabase row edit.
