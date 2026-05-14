# Implementation Plan: MCP Env Fix & Langfuse Observability

## Overview

Three changes in one deployment:

1. **MCP fix** — change env var syntax in `mcp/servers.json` from `${VAR}`
   to `$VAR` so Gemini CLI correctly expands the token at runtime.
2. **Langfuse integration** — add the Langfuse JS SDK to the Node sidecar
   (`healthz.js`) to forward agent events to Langfuse Cloud for persistent
   observability.
3. **Remove `HF_SPACE` guard** — the reverse proxy (`hf-proxy.js`) now always
   starts. The `HF_SPACE` env var is no longer needed.

## Files to Modify

| File | Change | Purpose |
|---|---|---|
| `agent-runtime/mcp/servers.json` | `${VAR}` → `$VAR` | Fix MCP env expansion |
| `agent-runtime/Dockerfile` | Install `langfuse` npm package | Sidecar dependency |
| `agent-runtime/scripts/healthz.js` | Add Langfuse forwarding | Observability |
| `agent-runtime/scripts/entrypoint.sh` | Pass `LANGFUSE_*` env vars to sidecar; always start hf-proxy | Credentials + proxy |
| `CLAUDE.md` | Remove `HF_SPACE=1` references | Docs cleanup |

## Step-by-Step Implementation

### Step 1: Fix MCP env var syntax

**File:** `agent-runtime/mcp/servers.json`

**Change:**

```diff
 "github": {
   "command": "github-mcp-server",
   "args": ["stdio", "--toolsets=repos,issues,pull_requests"],
   "env": {
-    "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}"
+    "GITHUB_PERSONAL_ACCESS_TOKEN": "$GITHUB_PERSONAL_ACCESS_TOKEN"
   }
 }
```

**Rationale:** Gemini CLI's documented env expansion format uses `$VAR_NAME`
(no curly braces). The `${VAR}` syntax is not guaranteed to be expanded by
all Gemini CLI versions. This is the root cause of MCP servers failing to
authenticate.

### Step 2: Install Langfuse SDK in Dockerfile

**File:** `agent-runtime/Dockerfile`

Add after the GitHub MCP server installation block:

```dockerfile
# --- Langfuse SDK for sidecar observability (optional — enabled by env) ---
RUN mkdir -p /opt/sidecar \
 && cd /opt/sidecar \
 && npm init -y \
 && npm install langfuse@3 --save
ENV NODE_PATH=/opt/sidecar/node_modules
```

**Rationale:** The sidecar scripts (`healthz.js`, `events-emitter.js`) are
standalone Node scripts, not part of an npm workspace. Installing Langfuse
into `/opt/sidecar/node_modules` and setting `NODE_PATH` makes
`require('langfuse')` work without modifying the script locations. Pinned to
major version 3 for stability.

### Step 3: Integrate Langfuse into healthz.js

**File:** `agent-runtime/scripts/healthz.js`

Add Langfuse initialization after the `DASHBOARD_TOKEN` check:

```js
// === Langfuse (optional — enabled when LANGFUSE_SECRET_KEY is set) ========
let langfuse = null;
try {
  if (process.env.LANGFUSE_SECRET_KEY) {
    const Langfuse = require('langfuse').default;
    langfuse = new Langfuse();  // auto-reads LANGFUSE_* env vars
    console.error('langfuse: enabled');
  }
} catch (e) {
  console.error('langfuse: init failed —', e.message);
}
```

Add event forwarding logic with trace/span management:

```js
// Active Langfuse traces keyed by LINE userId
const activeTraces = new Map();

function sendToLangfuse(ev) {
  if (!langfuse || !ev?.sessionUserId) return;
  const userId = ev.sessionUserId;

  switch (ev.type) {
    case 'message_in': {
      const trace = langfuse.trace({
        name: 'line-message',
        sessionId: userId,
        userId: userId,
        input: { text: ev.text },
      });
      const generation = trace.generation({
        name: 'gemini-2.5-flash',
        model: 'gemini-2.5-flash',
        input: ev.text,
      });
      activeTraces.set(userId, { trace, generation, spans: new Map() });
      break;
    }
    case 'tool_call': {
      const ctx = activeTraces.get(userId);
      if (!ctx) return;
      const span = ctx.generation.span({
        name: ev.tool || 'unknown',
        input: ev.args,
      });
      ctx.spans.set(ev.tool, span);
      break;
    }
    case 'tool_result': {
      const ctx = activeTraces.get(userId);
      if (!ctx) return;
      const span = ctx.spans.get(ev.tool);
      if (span) {
        span.end({
          output: ev.error || 'ok',
          level: ev.ok ? 'DEFAULT' : 'ERROR',
          statusMessage: ev.error,
          metadata: { durationMs: ev.durationMs },
        });
        ctx.spans.delete(ev.tool);
      }
      break;
    }
    case 'message_out': {
      const ctx = activeTraces.get(userId);
      if (!ctx) return;
      ctx.generation.end({ output: ev.text });
      ctx.trace.update({
        output: { text: ev.text, kind: ev.kind },
      });
      activeTraces.delete(userId);
      break;
    }
  }
}
```

Call `sendToLangfuse(ev)` inside the event processing loop, right after
`appendRecent(ev)` and before `fanOut(ev)`.

### Step 4: Always start hf-proxy (remove `HF_SPACE` guard)

**File:** `agent-runtime/scripts/entrypoint.sh`

**Change:**

```diff
-# ===== 4b. Start HF Spaces reverse proxy if HF_SPACE=1 =====================
-if [ "${HF_SPACE:-}" = "1" ]; then
-  node /usr/local/bin/hf-proxy.js &
-  echo "hf-proxy started on :7860" >&2
-fi
+# ===== 4b. Start reverse proxy (routes :7860 → gateway/sidecar) ============
+node /usr/local/bin/hf-proxy.js &
```

**Also updated:** `CLAUDE.md` — removed two references to `HF_SPACE=1`
(proxy description and env var list).

**Rationale:** The deployment target is always HF Spaces. The conditional
added unnecessary configuration surface — operators had to remember to set
`HF_SPACE=1`. Making the proxy unconditional eliminates this footgun and
allows removing the env var from HF Space secrets.

### Step 5: Pass Langfuse env vars in entrypoint.sh

**File:** `agent-runtime/scripts/entrypoint.sh`

Update the sidecar launch block to forward the three Langfuse env vars:

```diff
 GEMINI_TELEMETRY_OUTFILE="${GEMINI_TELEMETRY_OUTFILE:-/var/log/openab/gemini-events.jsonl}" \
 DASHBOARD_INGEST_TOKEN="$DASHBOARD_INGEST_TOKEN" \
+LANGFUSE_SECRET_KEY="${LANGFUSE_SECRET_KEY:-}" \
+LANGFUSE_PUBLIC_KEY="${LANGFUSE_PUBLIC_KEY:-}" \
+LANGFUSE_BASE_URL="${LANGFUSE_BASE_URL:-https://jp.cloud.langfuse.com}" \
   node /usr/local/bin/healthz.js &
```

**Rationale:** The Langfuse SDK constructor auto-reads these env vars. If
`LANGFUSE_SECRET_KEY` is empty, the sidecar skips Langfuse initialization
entirely — no error, no change in behavior.

## HF Space Secrets Required

Set these in HF Space Settings → Repository secrets:

| Secret name | Value | Notes |
|---|---|---|
| `LANGFUSE_SECRET_KEY` | `sk-lf-...` | Create in Langfuse → Settings → API Keys |
| `LANGFUSE_PUBLIC_KEY` | `pk-lf-...` | Same page as above |
| `LANGFUSE_BASE_URL` | `https://jp.cloud.langfuse.com` | Fixed for JP region |

## Testing Steps

1. **MCP fix verification:** Send "Can you grab andy770921 GitHub repo name
   for me? Only need top 5" via LINE. The agent should respond with a repo
   list (not a web search error) within ~10 seconds.

2. **Langfuse verification:** After a LINE conversation, open Langfuse
   dashboard at `https://jp.cloud.langfuse.com` → project "line-ai-agent" →
   Traces. You should see:
   - A trace named "line-message" per conversation turn
   - A generation span "gemini-2.5-flash" inside each trace
   - Tool call spans (e.g., "github__list_repos") nested inside the generation

3. **Graceful degradation:** If `LANGFUSE_SECRET_KEY` is not set, the sidecar
   should log "langfuse: init failed" or simply not log anything about
   Langfuse, and SSE/dashboard endpoints should work as before.

## Dependencies

- Depends on: Phase 1 (universal MCP config) — already complete
- No downstream dependencies

## Notes

- The Langfuse SDK auto-flushes every ~10 seconds. For a long-running sidecar
  process, explicit `flush()` calls are not needed.
- If the same MCP tool is called twice in one turn (rare), the second call's
  span overwrites the first in the tracking map. This is acceptable for v1.
- Token usage / cost data is not available from Gemini CLI telemetry. The
  generation span will show input/output text but not token counts.
