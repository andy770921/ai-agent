// events-emitter.js — emits AgentEvent JSON lines to stdout.
//
// Source: Gemini CLI's $GEMINI_TELEMETRY_OUTFILE. Gemini CLI v0.41.x writes
// telemetry as pretty-printed OpenTelemetry LogRecordImpl JSON objects.
// We use a brace-depth streaming parser to reassemble them.
//
// A single conversation turn produces this event sequence:
//   api_request  (user prompt)       → message_in
//   api_response (model: use tool)   → llm_response  (ends generation, keeps trace)
//   tool_call    (MCP execution)     → tool_call + tool_result
//   api_request  (follow-up)         → (skipped — same turn)
//   api_response (final answer)      → llm_response  (ends generation, keeps trace)
//   conversation_finished            → turn_end      (closes trace)
//
// See: https://geminicli.com/docs/cli/telemetry/

const fs = require('node:fs');

const SRC = process.env.GEMINI_TELEMETRY_OUTFILE || '/var/log/openab/gemini-events.jsonl';

// LRU-cap so a long-running pod with many sessions doesn't leak.
const SESSION_MAP_LIMIT = 200;
const recentSession = new Map(); // Gemini session_id -> LINE userId

// Track which sessions already emitted message_in (avoid duplicate traces
// when multiple api_request events fire in one conversation turn).
const sessionHasMessageIn = new Set();

function rememberSession(sid, userId) {
  if (recentSession.has(sid)) recentSession.delete(sid);
  recentSession.set(sid, userId);
  while (recentSession.size > SESSION_MAP_LIMIT) {
    const oldest = recentSession.keys().next().value;
    recentSession.delete(oldest);
  }
}

// === Brace-depth streaming JSON parser ======================================
let jsonBuf = '';
let depth = 0;
let inString = false;
let escape = false;

function pushChunk(chunk) {
  for (const ch of chunk) {
    if (depth === 0 && ch !== '{') continue;
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

let recordsSampled = 0;
const RECORD_SAMPLE_LIMIT = 15;

function processJsonObject(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return;
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
  const ts = raw.hrTime
    ? new Date(raw.hrTime[0] * 1000 + raw.hrTime[1] / 1e6).toISOString()
    : raw.timestamp || new Date().toISOString();

  const attrs = raw.attributes || {};
  const eventName = attrs['event.name'] || raw._eventName || raw.eventName || raw.name;
  const sid = attrs['session.id'] || raw.session_id;

  // Extract LINE userId from any attribute that contains the <sender_context>
  // block.  Gemini CLI may split the conversation into multiple `parts`;
  // request_text often holds only the last part, so we search all string-
  // valued attributes (and the raw body) for the sender_id pattern.
  if (sid && !recentSession.has(sid)) {
    const haystack = JSON.stringify(attrs) + (raw.body ? JSON.stringify(raw.body) : '');
    const m = haystack.match(/sender_id["\s:\\]+([U][0-9a-f]{32,})/);
    if (m) rememberSession(sid, m[1]);
  }

  let sessionUserId = sid ? recentSession.get(sid) : undefined;
  if (!sessionUserId && sid) {
    rememberSession(sid, sid);
    sessionUserId = sid;
  }
  if (!sessionUserId) return null;

  switch (eventName) {
    case 'gemini_cli.user_prompt':
    case 'gemini_cli.api_request': {
      // Only emit message_in for the FIRST api_request per session/turn.
      // Subsequent api_requests (follow-ups after tool calls) are skipped
      // to avoid creating duplicate Langfuse traces.
      if (sessionHasMessageIn.has(sid)) return null;
      sessionHasMessageIn.add(sid);
      return {
        type: 'message_in',
        sessionUserId,
        ts,
        text: String(attrs.request_text || attrs.prompt || raw.prompt || ''),
        model: String(attrs.model || ''),
      };
    }

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

    // LLM response — carries token counts. Does NOT close the trace.
    case 'gemini_cli.api_response':
      return {
        type: 'llm_response',
        sessionUserId,
        ts,
        model: String(attrs.model || ''),
        inputTokens: Number(attrs.input_token_count || 0),
        outputTokens: Number(attrs.output_token_count || 0),
        durationMs: Number(attrs.duration_ms || 0),
        statusCode: Number(attrs.status_code || 0),
      };

    // API error — record it but don't close trace (conversation_finished does).
    case 'gemini_cli.api_error':
      return {
        type: 'llm_response',
        sessionUserId,
        ts,
        model: String(attrs.model_name || attrs.model || ''),
        error: String(attrs['error.message'] || attrs.error || 'API error'),
        statusCode: Number(attrs.status_code || attrs['http.status_code'] || 0),
        durationMs: Number(attrs.duration_ms || attrs.duration || 0),
      };

    // End of conversation turn — closes the trace.
    case 'gemini_cli.conversation_finished':
      sessionHasMessageIn.delete(sid); // reset for next turn
      return {
        type: 'turn_end',
        sessionUserId,
        ts,
        turnCount: Number(attrs.turnCount || 0),
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
