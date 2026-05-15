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
(Bug 6), GitHub MCP tools are STILL not available.

**Fix:** Changed `sandboxNetworkAccess` to `true`. However, this alone did
not fix the issue — see Bug 10.

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

**Fix:** Replaced readline-based parser with a brace-depth streaming JSON
parser. See Bug 11 for details.

---

## Bug 10 (MCP — ROOT CAUSE): Missing workspace trust in headless ACP mode

**Symptom:** After all previous MCP fixes (env expansion, trust, sandbox
network), GitHub MCP tools are STILL not available. Agent always falls
back to web_search (~230s timeout). Zero MCP-related error messages.

**Root cause:**

Gemini CLI v0.41.2 silently skips MCP servers in **untrusted workspaces**.
Since v0.39.1, headless/ACP mode does not auto-trust workspaces (security
fix for a CVSS-10 RCE vulnerability). In untrusted mode:

- MCP servers are **never started** (silently disconnected)
- Workspace-level settings overrides are ignored
- Tool auto-acceptance is disabled

The `trust: true` property on individual MCP servers only controls tool
call confirmation dialogs — it does NOT bypass the workspace-level trust
gate. Without workspace trust, the model has no MCP tools and falls back
to built-in tools (web_search, which policy denies).

**Fix:** Add `GEMINI_CLI_TRUST_WORKSPACE = "true"` to `[agent].env` in
`config/openab.toml`. This tells Gemini CLI to trust the workspace in
headless mode, allowing MCP servers to start.

**Sources:**

- [Trusted Folders | Gemini CLI](https://geminicli.com/docs/cli/trusted-folders/)
- [MCP servers with Gemini CLI](https://geminicli.com/docs/tools/mcp-server/)
  — "stdio MCP servers are only Connected if the folder is trusted"

---

## Bug 11 (Langfuse): Telemetry file is pretty-printed OTel LogRecordImpl

**Symptom:** events-emitter.js line-by-line parser gets individual
primitives instead of JSON objects (confirmed by diagnostic logs).

**Root cause (from format discovery on 2026-05-14):**

The telemetry file contains pretty-printed `@opentelemetry/sdk-logs`
`LogRecordImpl` objects — one multi-line JSON object per event:

```json
{
  "hrTime": [1778759427, 693000000],
  "attributes": { "session.id": "...", "event.name": "gemini_cli.user_prompt", "prompt": "..." },
  ...
}
```

Line-by-line `JSON.parse` can never reassemble these.

**Fix:** Replaced readline-based parser with a brace-depth streaming JSON
parser that tracks `{ }` nesting to delimit complete objects.

---

## Bug 12 (Langfuse): Event name stored in `attributes["event.name"]`

**Symptom:** After fixing the parser (Bug 11), records are assembled
correctly but `reshape()` still matches no events. Diagnostic logs from
2026-05-14 deployment confirmed:

```
events-emitter: record[1] {"attrKeys":["session.id","event.name","model","mcp_servers_count",...]}
```

`_eventName` and `eventName` are both `undefined` in the serialized JSON.

**Root cause:**

Gemini CLI v0.41.2 stores the event name in `attributes["event.name"]`,
not in `_eventName` or `eventName` at the top level. The `_eventName`
getter on the OTel `LogRecordImpl` class does not serialize because
`JSON.stringify` only captures own enumerable properties, and the getter
lives on the prototype.

**Fix:** Changed event name lookup to check `attrs['event.name']` first:

```js
const eventName = attrs['event.name'] || raw._eventName || raw.eventName || raw.name;
```

Key field mapping (final):

| What | Field path |
|---|---|
| Event name | `raw.attributes["event.name"]` |
| Timestamp | `new Date(raw.hrTime[0] * 1000 + raw.hrTime[1] / 1e6)` |
| Session ID | `raw.attributes["session.id"]` |
| Prompt text | `raw.attributes.prompt` |
| Tool name | `raw.attributes.function_name` |
| Tool args | `raw.attributes.function_args` |
| Duration | `raw.attributes.duration_ms` |
| Success | `raw.attributes.success` |

**Verified locally:** 4 mock OTel records → 4 correct AgentEvents
(message_in, tool_call, tool_result, message_out).

---

## Bug 13 (Langfuse): `gemini_cli.user_prompt` not emitted in ACP mode

**Symptom:** After fixing the event name path (Bug 12), diagnostic logs
from 2026-05-14 deployment show `gemini_cli.config`, `api_request`,
`api_error`, `model_routing`, etc. — but NO `gemini_cli.user_prompt`.
Zero AgentEvents produced, zero Langfuse traces.

**Root cause:**

Gemini CLI v0.41.2 in ACP mode does not emit `gemini_cli.user_prompt` in
the telemetry file. Instead, the prompt is carried by
`gemini_cli.api_request` (which has `request_text`, `prompt_id`, `model`).
Similarly, responses come from `gemini_cli.api_response` (with token
counts) or `gemini_cli.api_error` (with error details).

**Fix:** Expanded the reshape event mapping:

| Gemini CLI event | AgentEvent type | Key fields used |
|---|---|---|
| `gemini_cli.api_request` | `message_in` | `request_text` (contains sender_context) |
| `gemini_cli.tool_call` | `tool_call` + `tool_result` | `function_name`, `duration_ms`, `success` |
| `gemini_cli.api_response` | `message_out` | `input_token_count`, `output_token_count` |
| `gemini_cli.api_error` | `message_out` (kind=error) | `error.message`, `status_code` |
| `gemini_cli.conversation_finished` | `message_out` | (end signal) |

**Verified locally:** 6 real OTel events → 5 AgentEvents (message_in,
tool_call, tool_result, message_out x2). Full pipeline confirmed working.

---

## Files Changed

| File | Change |
|---|---|
| `agent-runtime/config/openab.toml` | Add `GEMINI_CLI_TRUST_WORKSPACE = "true"` to `[agent].env` — **the MCP root cause fix** |
| `agent-runtime/mcp/servers.json` | Value `$GITHUB_PERSONAL_ACCESS_TOKEN` -> `$GITHUB_TOKEN`; add `"trust": true` to both servers |
| `agent-runtime/gemini/settings.json` | `sandboxNetworkAccess: false` -> `true` (unblock MCP server network) |
| `agent-runtime/scripts/render-mcp-config.sh` | Add `expand_and_read_servers()` helper — resolves `$VAR` / `${VAR}` from `process.env` at boot |
| `agent-runtime/scripts/entrypoint.sh` | Keep `LANGFUSE_BASE_URL` (human-readable); no longer relies on SDK auto-read |
| `agent-runtime/scripts/healthz.js` | Pass `secretKey`, `publicKey`, `baseUrl` explicitly to `new Langfuse()` constructor; add flush + SIGTERM shutdown |
| `agent-runtime/scripts/events-emitter.js` | **Complete rewrite**: brace-depth streaming JSON parser for pretty-printed OTel LogRecordImpl; read `attributes["event.name"]`; convert `hrTime` tuples; session_id fallback |
| `agent-runtime/scripts/lib/langfuseSink.js` | Add try/catch error isolation in `onEvent`; add stale trace cleanup on new `message_in` |

## Verification Results

1. **MCP: CONFIRMED WORKING (2026-05-14 20:14 local)**
   - LINE response: `✅ search_repositories (github MCP Server)`
   - Returned top 5 repos in 14 seconds (down from 230s timeouts)
   - Used reply API (fast enough for replyToken)
   - Root cause was Bug 10 (`GEMINI_CLI_TRUST_WORKSPACE`)

2. **Langfuse: PENDING VERIFICATION**
   - Local test confirms full pipeline: 4 OTel records → 4 AgentEvents
   - Bug 12 (`attributes["event.name"]`) was the final missing piece
   - After deploy: send a LINE message, then check Langfuse Tracing
     at `https://jp.cloud.langfuse.com` → "line-ai-agent" → Tracing.
     Traces should appear within ~15 seconds (flush interval).

3. **Graceful degradation:** If `LANGFUSE_SECRET_KEY` is unset, sidecar
   starts normally, SSE works, no Langfuse errors in logs.

## Known limitation

- The Gemini API free-tier daily quota may cause "Internal Server Error
  (code: 500) You have exhausted your daily quota on this model" — this
  is not a bug in our system. Quota resets daily.
