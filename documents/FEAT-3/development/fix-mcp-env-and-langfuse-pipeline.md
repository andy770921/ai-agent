# Fix: MCP Env Expansion & Langfuse Pipeline (Phase 2 Patch)

## Date: 2026-05-14

## Summary

Five independent bugs prevented MCP server authentication and Langfuse trace
collection. All five must be fixed together for either feature to work.

---

## Bug 1 (MCP): render-mcp-config.sh does not expand env vars

**Symptom:** GitHub MCP server starts but receives a literal `$GITHUB_TOKEN`
string as its token, causing silent auth failure. Agent falls back to
`web_search` (denied by Gemini policy engine at priority 800).

**Root cause chain:**

1. `mcp/servers.json` contains `"GITHUB_PERSONAL_ACCESS_TOKEN": "$GITHUB_PERSONAL_ACCESS_TOKEN"`.
2. `render-mcp-config.sh` merges this JSON into `~/.gemini/settings.json`
   **verbatim** — no env var expansion.
3. The entrypoint shell has `GITHUB_TOKEN` (the HF Space secret name), but
   **not** `GITHUB_PERSONAL_ACCESS_TOKEN` — that name only exists inside the
   OpenAB-spawned subprocess via `[agent].env` mapping.
4. Gemini CLI v0.41.2 attempts to expand `$GITHUB_PERSONAL_ACCESS_TOKEN` from
   process env when spawning the MCP server subprocess. Even if the expansion
   worked, the variable does not exist in the Gemini subprocess env under that
   name — OpenAB sets it via `[agent].env`, but the MCP env block expansion
   may read from a different scope. Known upstream bugs
   ([#5828](https://github.com/google-gemini/gemini-cli/issues/5828),
   [#2836](https://github.com/google-gemini/gemini-cli/issues/2836)) confirm
   env expansion timing issues in v0.41.x.

**Fix:**

- Change `mcp/servers.json` to reference `$GITHUB_TOKEN` (exists in the
  entrypoint shell).
- Add env var expansion (`$VAR` / `${VAR}`) to `render-mcp-config.sh` so
  actual token values are baked into `settings.json` at boot time.
- This eliminates all dependency on Gemini CLI's env expansion behavior.

**Sources:**

- [Gemini CLI MCP server docs](https://geminicli.com/docs/tools/mcp-server/)
- [github-mcp-server install guide for Gemini CLI](https://github.com/github/github-mcp-server/blob/main/docs/installation-guides/install-gemini-cli.md)
- [Gemini CLI issue #5828](https://github.com/google-gemini/gemini-cli/issues/5828) — env var substitution not performed
- [Gemini CLI issue #2836](https://github.com/google-gemini/gemini-cli/issues/2836) — .env not loaded before settings parse

---

## Bug 2 (Langfuse): Wrong env var name for base URL

**Symptom:** Langfuse SDK initializes successfully (`langfuse: enabled`) but
sends traces to the US default endpoint (`cloud.langfuse.com`) instead of the
JP region (`jp.cloud.langfuse.com`). Traces are silently dropped because the
API keys belong to the JP project.

**Root cause:**

- `entrypoint.sh` passes `LANGFUSE_BASE_URL` (with underscore between BASE
  and URL).
- The `langfuse` npm package v3 reads `LANGFUSE_BASEURL` (no underscore).
- The SDK falls back to `https://cloud.langfuse.com` when the env var is
  unset.

**Fix:** Pass `secretKey`, `publicKey`, and `baseUrl` explicitly in the
`new Langfuse()` constructor instead of relying on auto-read env vars.
The entrypoint continues to use the human-readable `LANGFUSE_BASE_URL` name;
the constructor maps it to the SDK's internal field. This avoids the confusing
`LANGFUSE_BASEURL` (no underscore) env var that Langfuse v3 expects.

---

## Bug 3 (Langfuse): events-emitter.js reshape() uses fabricated event names

**Symptom:** Zero events flow through the AgentEventBus. Both the SSE
dashboard and Langfuse receive nothing.

**Root cause:**

The `reshape()` function (explicitly marked as a "placeholder" in the code
comments) expects event names and field paths that do not match Gemini CLI
v0.41.x's actual telemetry format:

| What reshape() expects | Actual Gemini CLI format |
|---|---|
| `raw.event \|\| raw.type` | `raw.name` |
| `raw.session_id` | `raw.attributes["session.id"]` |
| `raw.prompt` (top-level) | `raw.attributes.prompt` |
| Event `prompt_received` | `gemini_cli.user_prompt` |
| Event `tool_call` | `gemini_cli.tool_call` |
| Event `tool_result` | (no separate event — `tool_call` includes `duration_ms` + `success`) |
| Event `response_sent` | `gemini_cli.conversation_finished` |
| `raw.tool_name` | `raw.attributes.function_name` |
| `raw.tool_args` | `raw.attributes.function_args` |

Since none of the event names match, `reshape()` returns `null` for every
line, and `events-emitter.js` emits zero AgentEvents.

**Fix:** Rewrite `reshape()` to use actual Gemini CLI telemetry field names.
Also emit both `tool_call` + `tool_result` from a single
`gemini_cli.tool_call` event (which contains both input args and
duration/success).

**Source:**

- [Gemini CLI telemetry docs](https://geminicli.com/docs/cli/telemetry/) —
  full event catalog with field names

---

## Bug 4 (Langfuse): No flush or shutdown hook

**Symptom:** Even if events reached the Langfuse sink, traces would likely be
lost on container shutdown.

**Root cause:**

The Langfuse v3 SDK batches events in memory and flushes on an internal timer.
However:

- The sidecar (`healthz.js`) never calls `flushAsync()` or
  `shutdownAsync()`.
- On SIGTERM (container stop), the entrypoint kills the sidecar, and Node
  exits before the SDK's internal flush timer fires.
- Buffered traces are lost.

**Fix:**

- Call `langfuse.flushAsync()` in the existing 15-second heartbeat interval.
- Add a SIGTERM handler that calls `langfuse.shutdownAsync()`.

---

## Bug 5 (Langfuse): `langfuseSink.js` data model mismatch

**Symptom:** Would cause errors once events start flowing (not visible yet
because Bug 3 blocks all events).

**Root cause:**

The sink expects separate `tool_call` and `tool_result` events. After fixing
the reshape function, `tool_call` events will carry `durationMs` and `ok`
fields, and `tool_result` is emitted immediately after. The sink handles this
correctly, but needs minor robustness improvements.

**Fix:** Add try/catch in `onEvent` to prevent one bad event from poisoning
the trace state. Add cleanup of stale traces (user sends next message before
previous trace is closed).

---

## Bug 6 (MCP): Missing `trust: true` on MCP server definitions

**Symptom:** After fixing env expansion (Bug 1), MCP tools are still not
available to the agent. Agent falls back to web_search.

**Root cause:**

Gemini CLI's MCP server config defaults `trust` to `false`. When `false`,
every MCP tool call requires user confirmation. In ACP mode, the ACP client
(OpenAB) must handle these confirmations. Without `trust: true`, the tool
approval flow may hang or silently fail — the agent never sees the MCP
tools as available and falls back to web_search.

**Fix:** Add `"trust": true` to both MCP server definitions in
`mcp/servers.json`.

**Source:**

- [Gemini CLI MCP server docs](https://geminicli.com/docs/tools/mcp-server/)
  — trust property: "bypasses all tool call confirmations for this server"

---

## Bug 7 (Langfuse pipeline): sessionUserId extraction silently fails

**Symptom:** `events-emitter.js` processes telemetry lines but `reshape()`
returns `null` for every event. No unrecognized-event logs, no events
published to the bus, no Langfuse traces.

**Root cause:**

The `sessionUserId` is extracted from a `"sender_id"` JSON field in the
prompt text. This assumes OpenAB injects a `<sender_context>` block into
the prompt. If OpenAB does not inject this (or if the Gemini CLI telemetry
truncates the prompt), the regex never matches, `sessionUserId` is always
`undefined`, and `reshape()` returns `null` for every event — including
unrecognized ones, because the `null` return is before the event-name
switch.

**Fix:**

- Add session_id fallback: if sender_id extraction fails, use the Gemini
  session_id as the user identifier. In our system, OpenAB creates one
  Gemini session per LINE user, so session_id is unique per user.
- Add diagnostic logging: print the first 10 raw telemetry events to
  stderr for format discovery on next deployment.

---

## Bug 8 (MCP): `sandboxNetworkAccess: false` blocks MCP server network

**Symptom:** After fixing env expansion (Bug 1) and adding `trust: true`
(Bug 6), GitHub MCP tools are STILL not available. Agent falls back to
web_search. Container logs show no MCP-related errors.

**Root cause:**

`gemini/settings.json` has `toolSandboxing: true` + `sandboxNetworkAccess:
false`. Gemini CLI v0.41.2 may sandbox MCP server subprocesses. With
network access disabled, `github-mcp-server` cannot reach `api.github.com`
— the server starts, fails to authenticate or list tools, and silently
disconnects. The model never sees GitHub tools.

**Fix:** Change `sandboxNetworkAccess` to `true` in `gemini/settings.json`.
MCP servers need network access to reach external APIs.

---

## Bug 9 (Langfuse): Telemetry file is NOT JSONL — format completely wrong

**Symptom:** Diagnostic logging on 2026-05-14 deployment shows the
telemetry file contains individual primitive values per line:

```
events-emitter: raw[1] 317000000
events-emitter: raw[2] 317000000
events-emitter: raw[3] "r-andy770921-ai-agent-xbejgfl9-f665e-dxqx4"
events-emitter: raw[4] "amd64"
events-emitter: raw[5] null
events-emitter: raw[6] 63
events-emitter: raw[7] "/usr/local/bin/node"
events-emitter: raw[8] "/usr/local/bin/node"
events-emitter: raw[9] "--acp"
events-emitter: raw[10] "22.22.2"
```

These are OTLP resource attributes (pod name, architecture, Node.js
version, process path) — NOT JSON event objects.

**Root cause:**

Gemini CLI v0.41.2 with `GEMINI_TELEMETRY_TARGET=local` writes telemetry
in an OTLP-derived format, not the `{"name":"gemini_cli.user_prompt",...}`
JSONL format documented on the telemetry event catalog page. The events-
emitter's line-by-line JSON parser picks up individual primitive values
from this structure, none of which are event objects.

**Current fix (diagnostic):** Added raw-line logging (`events-emitter:
line[N] ...`) to capture the first 20 lines of the actual file content.
Also filter out non-object JSON values (primitives). Next deployment's
logs will reveal the exact file structure needed to write a correct parser.

**Future fix (after format discovery):** Either:
- Rewrite the parser to handle the actual OTLP file format, OR
- Switch to OTLP HTTP endpoint approach: run an OTLP receiver in the
  sidecar and set `GEMINI_TELEMETRY_OTLP_ENDPOINT` in `[agent].env`

---

## Files Changed

| File | Change |
|---|---|
| `agent-runtime/mcp/servers.json` | Value `$GITHUB_PERSONAL_ACCESS_TOKEN` -> `$GITHUB_TOKEN`; add `"trust": true` to both servers |
| `agent-runtime/gemini/settings.json` | `sandboxNetworkAccess: false` -> `true` (unblock MCP server network) |
| `agent-runtime/scripts/render-mcp-config.sh` | Add `expand_and_read_servers()` helper — resolves `$VAR` / `${VAR}` from `process.env` at boot, bakes real token into `settings.json` |
| `agent-runtime/scripts/entrypoint.sh` | Keep `LANGFUSE_BASE_URL` (human-readable); no longer relies on SDK auto-read |
| `agent-runtime/scripts/healthz.js` | Pass `secretKey`, `publicKey`, `baseUrl` explicitly to `new Langfuse()` constructor; add `flushAsync()` every 15 s in heartbeat; add `shutdownAsync()` on SIGTERM |
| `agent-runtime/scripts/events-emitter.js` | Rewrite `reshape()` for actual Gemini CLI telemetry; add session_id fallback; log first 20 raw file LINES to stderr; skip non-object JSON values |
| `agent-runtime/scripts/lib/langfuseSink.js` | Add try/catch error isolation in `onEvent`; add stale trace cleanup on new `message_in` |

## Verification Steps

1. **MCP:** Send "Can you grab andy770921 GitHub repo name for me? Only need
   top 5" via LINE. Agent should respond with repo list (not web search
   error) within ~30 seconds.

2. **Telemetry format discovery:** Check container logs for
   `events-emitter: line[1]` through `line[20]` — these show the raw file
   content, revealing the actual Gemini CLI telemetry format. This data
   determines whether a parser fix or an OTLP endpoint switch is needed.

3. **Langfuse:** If events flow, traces appear at
   `https://jp.cloud.langfuse.com` -> project "line-ai-agent" -> Tracing.
   If not, the telemetry format discovery (step 2) will inform the next fix.

4. **Graceful degradation:** If `LANGFUSE_SECRET_KEY` is unset, sidecar
   starts normally, SSE works, no Langfuse errors in logs.
