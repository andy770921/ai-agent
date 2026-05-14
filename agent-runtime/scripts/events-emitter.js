// events-emitter.js — emits one AgentEvent JSON per stdout line.
//
// Source: Gemini CLI's $GEMINI_TELEMETRY_OUTFILE. Gemini CLI v0.41.x writes
// telemetry as pretty-printed OpenTelemetry LogRecordImpl JSON objects,
// concatenated in the file. Each record looks like:
//
//   {
//     "hrTime": [<seconds>, <nanoseconds>],
//     "attributes": { "session.id": "...", ... },
//     "_eventName": "gemini_cli.user_prompt",
//     ...
//   }
//
// The file is NOT JSONL — each object spans ~40+ lines. We use a brace-depth
// streaming parser to reassemble complete JSON objects from the byte stream.
//
// See: https://geminicli.com/docs/cli/telemetry/
//
// Mapped events:
//   gemini_cli.user_prompt           → message_in
//   gemini_cli.tool_call             → tool_call + tool_result
//   gemini_cli.conversation_finished → message_out
//   gemini_cli.api_response          → (logged, not mapped)

const fs = require('node:fs');

const SRC = process.env.GEMINI_TELEMETRY_OUTFILE || '/var/log/openab/gemini-events.jsonl';

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

// === Brace-depth streaming JSON parser ======================================
// Tracks { } depth to delimit individual JSON objects in a pretty-printed
// file. Handles strings (with escapes) correctly so braces inside strings
// don't confuse the parser.

let jsonBuf = '';
let depth = 0;
let inString = false;
let escape = false;

function pushChunk(chunk) {
  for (const ch of chunk) {
    if (depth === 0 && ch !== '{') continue; // skip inter-object whitespace
    jsonBuf += ch;

    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        processJsonObject(jsonBuf);
        jsonBuf = '';
      }
    }
  }
}

// Log the first N complete records for format discovery.
let recordsSampled = 0;
const RECORD_SAMPLE_LIMIT = 15;

function processJsonObject(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return; // skip malformed
  }

  if (recordsSampled < RECORD_SAMPLE_LIMIT) {
    recordsSampled++;
    const a = raw.attributes || {};
    const preview = {
      eventName: a['event.name'] || raw._eventName || raw.eventName || '(none)',
      attrKeys: Object.keys(a),
      hrTime: raw.hrTime,
    };
    console.error(`events-emitter: record[${recordsSampled}] ${JSON.stringify(preview)}`);
  }

  const result = reshape(raw);
  if (!result) return;
  const events = Array.isArray(result) ? result : [result];
  for (const ev of events) {
    process.stdout.write(JSON.stringify(ev) + '\n');
  }
}

// === File tailing ===========================================================
let lastOffset = 0;
let stream = null;

function cleanup() {
  try {
    stream?.destroy();
  } catch {
    /* ignore */
  }
  stream = null;
}

function openTail(start) {
  cleanup();
  stream = fs.createReadStream(SRC, { encoding: 'utf8', start });
  stream.on('data', pushChunk);
  stream.on('end', () => setTimeout(pollAndResume, 250));
  stream.on('error', () => setTimeout(tail, 1000));
}

function pollAndResume() {
  let stat;
  try {
    stat = fs.statSync(SRC);
  } catch {
    cleanup();
    setTimeout(tail, 500);
    return;
  }
  if (stat.size < lastOffset) {
    // Truncated — reset parser state and re-read from 0.
    lastOffset = 0;
    jsonBuf = '';
    depth = 0;
    inString = false;
    escape = false;
    openTail(0);
    return;
  }
  if (stat.size > lastOffset) {
    openTail(lastOffset);
    lastOffset = stat.size;
    return;
  }
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

// === Event reshape ===========================================================
const seenUnrecognized = new Set();

function reshape(raw) {
  // Convert hrTime [seconds, nanoseconds] to ISO timestamp.
  const ts = raw.hrTime
    ? new Date(raw.hrTime[0] * 1000 + raw.hrTime[1] / 1e6).toISOString()
    : raw.timestamp || new Date().toISOString();

  const attrs = raw.attributes || {};

  // Event name: Gemini CLI v0.41.x stores it in attributes["event.name"],
  // NOT in _eventName or eventName (those are undefined in the serialized JSON).
  const eventName = attrs['event.name'] || raw._eventName || raw.eventName || raw.name;

  // Session ID from attributes.
  const sid = attrs['session.id'] || raw.session_id;

  // Try to extract LINE userId from prompt's <sender_context> block.
  const prompt = attrs.prompt || raw.prompt;
  if (prompt && sid) {
    const m = String(prompt).match(/"sender_id"\s*:\s*"([^"]+)"/);
    if (m) rememberSession(sid, m[1]);
  }

  // Fallback: use session_id as user identifier (one session per LINE user).
  let sessionUserId = sid ? recentSession.get(sid) : undefined;
  if (!sessionUserId && sid) {
    rememberSession(sid, sid);
    sessionUserId = sid;
  }
  if (!sessionUserId) return null;

  switch (eventName) {
    case 'gemini_cli.user_prompt':
      return {
        type: 'message_in',
        sessionUserId,
        ts,
        text: String(prompt ?? ''),
      };

    case 'gemini_cli.tool_call': {
      const toolName = String(attrs.function_name || 'unknown');
      const toolArgs = attrs.function_args || null;
      const durationMs = Number(attrs.duration_ms || 0);
      const ok = attrs.success ?? true;
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
      return {
        type: 'message_out',
        sessionUserId,
        ts,
        text: String(attrs.text || ''),
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
