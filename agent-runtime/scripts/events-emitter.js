// events-emitter.js — emits one AgentEvent JSON per stdout line.
//
// Source: Gemini CLI's $GEMINI_TELEMETRY_OUTFILE. Gemini CLI writes JSON-line
// telemetry events to this file when GEMINI_TELEMETRY_ENABLED=true and
// GEMINI_TELEMETRY_TARGET=local (per bundle/docs/cli/acp-mode.md, v0.41.x).
//
// The reshape() function below is a placeholder until Phase 0.3 captures real
// telemetry samples. Update it once we see the actual field names produced by
// `gemini --acp` runs. The OUTPUT contract is fixed (see shared/src/types/
// agent-events.ts); only the mapping from upstream fields is flexible.

const fs = require('node:fs');
const readline = require('node:readline');

const SRC = process.env.GEMINI_TELEMETRY_OUTFILE
  || '/var/log/openab/gemini-events.jsonl';

// LRU-cap so a long-running pod with many sessions doesn't leak.
const SESSION_MAP_LIMIT = 200;
const recentSession = new Map(); // Gemini session_id -> LINE userId

function rememberSession(sid, userId) {
  if (recentSession.has(sid)) recentSession.delete(sid);
  recentSession.set(sid, userId);
  while (recentSession.size > SESSION_MAP_LIMIT) {
    const oldest = recentSession.keys().next().value;
    recentSession.delete(oldest);
  }
}

// Offset we've consumed so far. On file truncation (size < lastOffset) we
// reset to 0 and re-tail from the new beginning. On file deletion + recreation
// (rename / logrotate copytruncate) we re-poll until the path exists again.
let lastOffset = 0;
let stream = null;
let rl = null;

function cleanup() {
  try { rl?.close(); } catch { /* ignore */ }
  try { stream?.destroy(); } catch { /* ignore */ }
  rl = null;
  stream = null;
}

function openTail(start) {
  cleanup();
  stream = fs.createReadStream(SRC, { encoding: 'utf8', start });
  rl = readline.createInterface({ input: stream });
  rl.on('line', (line) => {
    try {
      const raw = JSON.parse(line);
      const ev = reshape(raw);
      if (ev) process.stdout.write(JSON.stringify(ev) + '\n');
    } catch {
      // Skip non-JSON lines silently.
    }
  });
  stream.on('end', () => {
    // EOF — schedule a poll for new bytes.
    setTimeout(pollAndResume, 250);
  });
  stream.on('error', () => {
    setTimeout(tail, 1000);
  });
}

function pollAndResume() {
  let stat;
  try { stat = fs.statSync(SRC); } catch {
    // File disappeared (rotate via rename). Re-poll until it returns.
    cleanup();
    setTimeout(tail, 500);
    return;
  }
  if (stat.size < lastOffset) {
    // Truncated (logrotate copytruncate). Re-read from byte 0.
    lastOffset = 0;
    openTail(0);
    return;
  }
  if (stat.size > lastOffset) {
    openTail(lastOffset);
    lastOffset = stat.size;
    return;
  }
  // No new bytes; keep polling.
  setTimeout(pollAndResume, 500);
}

function tail() {
  if (!fs.existsSync(SRC)) {
    setTimeout(tail, 1000);
    return;
  }
  lastOffset = fs.statSync(SRC).size;
  openTail(lastOffset);
}

function reshape(raw) {
  const ts = raw.timestamp || raw.ts || new Date().toISOString();
  const sid = raw.session_id;

  // OpenAB injects a <sender_context> block at the top of every prompt; the
  // prompt event therefore carries the LINE userId in its `prompt` field.
  // We extract it and cache against the Gemini session_id for subsequent
  // tool_call / tool_result / response events.
  if (raw.prompt && sid) {
    const m = String(raw.prompt).match(/"sender_id"\s*:\s*"([^"]+)"/);
    if (m) rememberSession(sid, m[1]);
  }

  const sessionUserId = sid ? recentSession.get(sid) : undefined;
  if (!sessionUserId) return null;

  switch (raw.event || raw.type) {
    case 'prompt_received':
      return { type: 'message_in', sessionUserId, ts, text: String(raw.prompt ?? '') };
    case 'tool_call':
      return {
        type: 'tool_call',
        sessionUserId,
        ts,
        tool: String(raw.tool_name ?? 'unknown'),
        args: raw.tool_args ?? raw.args ?? null,
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        sessionUserId,
        ts,
        tool: String(raw.tool_name ?? 'unknown'),
        durationMs: Number(raw.duration_ms ?? raw.durationMs ?? 0),
        ok: raw.ok ?? !raw.error,
        error: raw.error ? String(raw.error) : undefined,
      };
    case 'response_sent':
      return {
        type: 'message_out',
        sessionUserId,
        ts,
        text: String(raw.text ?? ''),
        kind: raw.has_image ? 'image' : 'text',
        imageUrl: raw.image_url ?? undefined,
      };
    default:
      return null;
  }
}

tail();
