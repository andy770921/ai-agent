# FEAT-5 — Implementation: Remove Supabase

This doc records exactly what changed to drop Supabase from `agent-runtime/`.
See `../plans/prd.md` for the motivation and decisions.

## New folder structure

```
agent-runtime/src/
├── config/
│   └── agentConfig.ts       # hardcoded constants (was the agent_config table)
└── store/                   # in-process replacements for the old Supabase tables
    ├── messageStore.ts      # messages   → per-session ring buffer
    ├── memoryStore.ts       # memories   → array + keyword FTS + curator ops
    ├── skillStore.ts        # skills     → array + keyword FTS + curator ops
    ├── userStore.ts         # users      → Map keyed by userId
    ├── curatorRunStore.ts   # curator_runs / curator_backups + extraction stats
    ├── locks.ts             # advisory locks → in-process Set guard
    └── store.test.ts        # Vitest coverage for the stores + locks
```

`src/db/` (client, agentConfig, messages, memories, skills, users, locks,
writeQueue) and `agent-runtime/supabase/` (migrations) were **deleted**.

## Config: `src/config/agentConfig.ts`

- Exports `SYSTEM_PROMPT` (verbatim from the last Supabase seed,
  `supabase/migrations/20260519_004_update_system_prompt.sql`),
  `DEFAULT_MODEL = 'gemini-2.5-flash'`, and `MEMORY_EXTRACTION_ENABLED = false`.
- Keeps the old async, string-keyed, throw-on-missing `getAgentConfig(key)`
  signature backed by a constants map, so `systemPrompt.ts`, `providerRouting.ts`,
  and `gateCheck.ts` needed only an import-path change (plus `gateCheck` now
  reads the flag via `getAgentConfig` instead of a table query).
- Config keys covered: `system_prompt`, `default_model`,
  `default_model:{main,curator,extractor,skill-creator}`,
  `memory_extraction_enabled`.

> `MEMORY_EXTRACTION_ENABLED` is `false`. The seed set it `true`, but extraction
> never actually ran (the gate's `new_sessions` counter keys on a `session-end`
> curator-run phase that no code writes). Setting it `false` documents reality.

## Stores: `src/store/*`

Each store is a module-level singleton (arrays / Maps) with functions that
mirror the exact operations the old Supabase queries and RPCs performed:

- **messageStore** — `appendUserMessage`, `appendAssistantMessage`,
  `loadRecentMessages`. Bounded to 200 messages per `${userId}:${sessionId}`.
  Row shape matches the columns the old `loadRecentMessages` selected
  (`role`, `content`, `tool_calls`, `tool_results`, `created_at`).
- **memoryStore** — retrieval (`findRelevantMemories`, `markUsed`), extractor
  CRUD (`existingMemoryIndex`, `listMemories`, `insertMemory`, `patchMemory`),
  and curator ops (`activeMemoryUserIds`, `listMemoriesForConsolidation`,
  `mergeMemory`, `archiveMemory`, `markStaleMemories`, `archiveOldMemories`,
  `hardCapMemories`). Postgres `tsvector` search is approximated with a
  keyword-overlap ranker; `find_memories_recent` becomes a pinned-first,
  most-recently-used sort. The `Memory` type consumed by `composeSystem` is
  unchanged.
- **skillStore** — `findRelevantSkills`, `listSkillsForUser`, `upsertSkill`,
  plus curator ops (`snapshotActiveAgentSkills`, `activeAgentSkillUserIds`,
  `listSkillsForConsolidation`, `archiveSkills`, and the stale/archive/hardCap
  transitions). `userId === null` still marks a global skill.
- **userStore** — `upsertUser(userId, displayName?)`.
- **curatorRunStore** — `recordCuratorRun`, `updateCuratorRun`,
  `memoryExtractionStats`, `insertBackup`, `retainBackups`.
- **locks** — `withAdvisoryLock(name, fn)`: an in-process `Set` guard giving the
  same "one holder at a time" guarantee as `pg_try_advisory_lock` (valid because
  the runtime is a single Node process).

## Consumers rewritten

| File | Change |
|---|---|
| `agent/runTurn.ts` | Imports from `store/` instead of `db/`; `toAiMessage` typed with `StoredMessage`. |
| `agent/composeSystem.ts` + `.test.ts` | `Memory` type import path → `store/memoryStore`. |
| `agent/systemPrompt.ts`, `agent/providerRouting.ts` | `getAgentConfig` import path → `config/agentConfig`. |
| `line/webhookHandler.ts` | Message + user imports → `store/`. |
| `memory/gateCheck.ts` | Reads the flag via `getAgentConfig`; stats via `curatorRunStore.memoryExtractionStats`. |
| `memory/extractMemory.ts` | `db()` memory/curator-run calls → store functions; lock → `store/locks`. |
| `skills/createSkill.ts` | `db()` skill calls → `store/skillStore`; lock → `store/locks`; `buildSkillPrompt` typed. |
| `curator/runCurator.ts` | All `db()` / `rpc()` calls → memory/skill/curator store functions. |
| `curator/handler.ts` | `curator_runs` insert/update → `curatorRunStore`. |
| `server.ts` | Dropped the `writeQueue` import + SIGTERM flush (in-memory writes need no flush; Langfuse flush kept). |
| `scripts/entrypoint.sh` | Removed the `: "${SUPABASE_URL:?missing}"` / `SUPABASE_SERVICE_KEY` fail-fast assertions. **Without this the container would `exit` on boot once the secrets are gone.** |
| `package.json` | Removed `@supabase/supabase-js`. |

`writeQueue.ts` (and its test) were removed: they existed only to avoid blocking
requests on Supabase network writes. In-memory writes are synchronous, so the
queue is obsolete.

## Testing

```bash
cd agent-runtime
npx tsc -p . --noEmit     # clean
npx vitest run            # 6 files, 30 tests pass (added src/store/store.test.ts)
```

Runtime smoke test (with `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` **unset**):
`getSystemPrompt()` returns the prompt, `pickProvider()` returns
`gemini-2.5-flash`, and `findRelevantMemories()` works — the exact path that
previously threw because `agent_config` couldn't be read.

`src/store/store.test.ts` covers: message ordering / limit / session isolation;
memory insert/patch/duplicate-slug/hard-cap/user-scoping; skill retrieval and
cross-user isolation; curator run record/update and the always-zero
`newSessions`; and advisory-lock mutual exclusion + release.

## Lint / formatting cleanup

`npm run lint` was already failing repo-wide before FEAT-5 (config drift, not
introduced here). Fixed as part of this work:

- Ran `prettier --write` on all non-conforming code (31 files across
  `agent-runtime/src`, `edge/src`, `frontend/src`) so it matches the root
  `.prettierrc` (`printWidth: 100`). The code had never been run through
  `prettier --write`; changing the width would not have helped (edge/frontend
  diverge *more* at width 80).
- `.eslintrc.js`: taught `@typescript-eslint/no-unused-vars` to honor the
  `_`-prefix convention already used in the code (`argsIgnorePattern: '^_'`,
  etc.) — fixes the `scheduled(_event, env, _ctx)` Worker signature in
  `edge/src/index.ts`. Also added `next-env.d.ts` (Next.js auto-generated,
  must not be edited) to `ignorePatterns`.
- `agent-runtime/package.json`: added a `lint` script (`eslint src --ext .ts`).
  The workspace previously had none, so `turbo run lint` never checked it —
  which is how its 24 files drifted unnoticed. It is now covered.

Result: `npm run lint` → 5/5 tasks pass; `prettier --check` clean.

## Live-data audit (verified via Supabase MCP)

Confirmed against the live project **"AI agent"** (`qjdwamklxjvdgzgkuxcs`) before
decommissioning — no valuable data is stranded:

| Table | Live rows | Notes |
|---|---|---|
| `memories` | 0 | Extraction never ran (empty despite `memory_extraction_enabled=true` for ~2 months). |
| `skills` | 0 | Dormant — nothing accumulated. |
| `messages` | 30 | Ephemeral chat history; intentionally in-memory now. |
| `users` | 1 | Operational state; not needed. |
| `curator_runs` | 3 | Bookkeeping. |
| `curator_backups` | 0 | Empty. |
| `agent_config` | 6 | All match the re-homed constants. |

`agent_config` verification: `default_model` (+ `:curator`/`:extractor`/`:skill-creator`)
all `gemini-2.5-flash`; `system_prompt` is **md5-identical** to the hardcoded
constant (`a936fe36…`, 1385 chars). `memory_extraction_enabled` is `true` in the
DB but `false` in code — deliberate, and validated by `memories = 0`.

## Curator removal (follow-up cleanup)

The weekly curator maintenance job was removed entirely — after FEAT-5 it
maintained in-memory memory/skill banks that reset on every container restart
and never survive its 30/90-day thresholds, so it was a weekly no-op.

Removed:

- **edge**: the `[triggers]` cron block in `wrangler.toml`, the `scheduled`
  export in `src/index.ts`, `src/cron/curator.ts` (deleted), and the
  `CURATOR_TOKEN` field in `src/env.ts`.
- **agent-runtime**: the `POST /admin/curator` route in `server.ts`, the whole
  `src/curator/` directory (`handler.ts`, `runCurator.ts`), the `'curator'`
  provider-routing hint, and the `default_model:curator` config key.
- **stores**: the curator-only functions in `memoryStore.ts` / `skillStore.ts`
  (consolidation, stale/archive/hard-cap, backup snapshot) and the
  backup/`updateCuratorRun` helpers in `curatorRunStore.ts`.

Kept: `store/curatorRunStore.ts` (trimmed to `recordCuratorRun` +
`memoryExtractionStats`) — it is still used by the memory-extraction gate
(`memory/gateCheck.ts` + `memory/extractMemory.ts`), which is a separate
(dormant) pipeline, not the curator cron. `curator` in its name is a historical
artifact of the `curator_runs` table.

## Deployment / manual follow-ups

These are **not** code changes and must be done by hand at deploy time:

1. **`agent-runtime/.env.example`** — remove the two Supabase lines **and** the
   `CURATOR_TOKEN` line. This file is git-protected in the local sandbox and
   could not be edited automatically:

   ```diff
   - # --- Supabase persistence (new project: agent-runtime-prod) ---
   - # URL format: https://<project-ref>.supabase.co
   - SUPABASE_URL=https://YOUR_SUPABASE_PROJECT_REF.supabase.co
   - # Service-role key; never expose to the browser. Found under
   - # Supabase project → Project settings → API → service_role secret.
   - SUPABASE_SERVICE_KEY=YOUR_SUPABASE_SERVICE_KEY_HERE
   - # --- Curator cron (bearer the edge Worker sends on /admin/curator) ---
   - CURATOR_TOKEN=YOUR_CURATOR_TOKEN_HERE
   ```

2. **HF Space secrets** — delete `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, and
   `CURATOR_TOKEN` from the Space's Variables and secrets (now ignored; remove
   to shrink the secret surface). Rotate the Supabase keys if decommissioning.

3. **Cloudflare Worker secret** — delete `CURATOR_TOKEN` from the edge Worker
   (`wrangler secret delete CURATOR_TOKEN` from `edge/`).

4. **Supabase project** — the `agent-runtime-prod` project can be paused /
   deleted once this ships. Migrations were removed from the repo; git history
   retains them if a schema reference is ever needed.

## Known tradeoffs / future work

- **Ephemeral state.** History, memories, skills, and curator data live only
  for the container's lifetime. If durability is needed, add a file-backed or
  SQLite-backed store implementing the same module interfaces — consumers would
  not change.
- **Approximate search.** Keyword-overlap ranking replaces Postgres FTS. Fine
  for the small per-user banks this bot accumulates; revisit if banks grow.
- **Long-term memory still off.** To enable it: write a `session-end`
  `curator_runs` row on the `session_ended` bus event, then set
  `MEMORY_EXTRACTION_ENABLED = true` in `config/agentConfig.ts`.
