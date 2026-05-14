// events-emitter.js — emits one AgentEvent JSON per stdout line.
//
// Source: Gemini CLI's $GEMINI_TELEMETRY_OUTFILE. Gemini CLI writes JSON-line
// telemetry events to this file when GEMINI_TELEMETRY_ENABLED=true and
// GEMINI_TELEMETRY_TARGET=local (per bundle/docs/cli/acp-mode.md, v0.41.x).
//
// Gemini CLI telemetry JSONL format (v0.41.x):
//   {"timestamp":"ISO8601","name":"gemini_cli.<event>","attributes":{"session.id":"...","field":"value"},"resource":{...}}
// See: https://geminicli.com/docs/cli/telemetry/
//
// Mapped events:
//   gemini_cli.user_prompt  → message_in
//   gemini_cli.tool_call    → tool_call + tool_result (single event carries both)
//   gemini_cli.conversation_finished → message_out (no response text available)
//   gemini_cli.api_response → (logged for debug, not mapped to AgentEvent)

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
      const result = reshape(raw);
      if (!result) return;
      const events = Array.isArray(result) ? result : [result];
      for (const ev of events) {
        process.stdout.write(JSON.stringify(ev) + '\n');
      }
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

// Log each unrecognized event name once so we can refine the mapping.
const seenUnrecognized = new Set();

function reshape(raw) {
  const ts = raw.timestamp || raw.ts || new Date().toISOString();
  const attrs = raw.attributes || {};

  // Gemini CLI uses attributes["session.id"] for the session identifier.
  const sid = attrs['session.id'] || raw.session_id;

  // Event name: Gemini CLI v0.41.x uses raw.name (e.g. "gemini_cli.user_prompt").
  const eventName = raw.name || raw.event || raw.type;

  // OpenAB injects a <sender_context> block at the top of every prompt; the
  // user_prompt event carries the LINE userId in its attributes.prompt field.
  // We extract it and cache against the Gemini session_id for subsequent events.
  const prompt = attrs.prompt || raw.prompt;
  if (prompt && sid) {
    const m = String(prompt).match(/"sender_id"\s*:\s*"([^"]+)"/);
    if (m) rememberSession(sid, m[1]);
  }

  const sessionUserId = sid ? recentSession.get(sid) : undefined;
  if (!sessionUserId) return null;

  switch (eventName) {
    case 'gemini_cli.user_prompt':
    case 'prompt_received': // legacy fallback
      return {
        type: 'message_in',
        sessionUserId,
        ts,
        text: String(prompt ?? ''),
      };

    case 'gemini_cli.tool_call':
    case 'tool_call': { // legacy fallback
      const toolName = String(attrs.function_name || raw.tool_name || 'unknown');
      const toolArgs = attrs.function_args || raw.tool_args || raw.args || null;
      const durationMs = Number(attrs.duration_ms || raw.duration_ms || 0);
      const ok = attrs.success ?? raw.ok ?? true;
      // Emit both tool_call and tool_result since Gemini CLI's single event
      // carries input args, duration, and success/failure.
      return [
        { type: 'tool_call', sessionUserId, ts, tool: toolName, args: toolArgs },
        {
          type: 'tool_result',
          sessionUserId,
          ts,
          tool: toolName,
          durationMs,
          ok,
          error: ok ? undefined : String(attrs.error || 'tool failed'),
        },
      ];
    }

    case 'gemini_cli.conversation_finished':
    case 'response_sent': // legacy fallback
      return {
        type: 'message_out',
        sessionUserId,
        ts,
        text: String(attrs.text || raw.text || ''),
        kind: 'text',
      };

    default:
      if (eventName && !seenUnrecognized.has(eventName)) {
        seenUnrecognized.add(eventName);
        console.error(`events-emitter: unrecognized event "${eventName}"`);
      }
      return null;
  }
}

tail();
