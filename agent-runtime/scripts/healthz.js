// Node sidecar — owns the dashboard endpoints on :8081.

const http = require('node:http');
const { spawn } = require('node:child_process');

const PORT = 8081;
const DASHBOARD_TOKEN = process.env.DASHBOARD_INGEST_TOKEN;
if (!DASHBOARD_TOKEN) {
  console.error('DASHBOARD_INGEST_TOKEN missing — sidecar refusing to start');
  process.exit(1);
}

// === Langfuse (optional — enabled when LANGFUSE_SECRET_KEY is set) ========
let langfuse = null;
try {
  if (process.env.LANGFUSE_SECRET_KEY) {
    const Langfuse = require('langfuse').default;
    langfuse = new Langfuse(); // auto-reads LANGFUSE_SECRET_KEY, LANGFUSE_PUBLIC_KEY, LANGFUSE_BASE_URL
    console.error('langfuse: enabled');
  }
} catch (e) {
  console.error('langfuse: init failed —', e.message);
}

// Active Langfuse traces keyed by LINE userId.
// Each entry: { trace, generation, spans: Map<toolName, span> }
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
      ctx.trace.update({ output: { text: ev.text, kind: ev.kind } });
      activeTraces.delete(userId);
      break;
    }
  }
}

// In-memory ring buffer of recent events keyed by sessionUserId.
const RECENT_LIMIT = 200;
const recent = new Map(); // userId -> AgentEvent[]
const subscribers = new Set(); // SSE res objects

// === Boot the events emitter child ===========================================
const emitter = spawn('node', ['/usr/local/bin/events-emitter.js'], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
emitter.on('exit', (code) => {
  console.error('events-emitter exited', code);
});

let buf = '';
emitter.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    appendRecent(ev);
    sendToLangfuse(ev);
    fanOut(ev);
  }
});

function appendRecent(ev) {
  if (!ev || !ev.sessionUserId) return;
  const arr = recent.get(ev.sessionUserId) ?? [];
  arr.push(ev);
  while (arr.length > RECENT_LIMIT) arr.shift();
  recent.set(ev.sessionUserId, arr);
}

function fanOut(ev) {
  const data = `event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`;
  for (const res of subscribers) {
    try {
      res.write(data);
    } catch {
      subscribers.delete(res);
    }
  }
}

// === HTTP routes =============================================================
http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');

    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200).end('ok');
      return;
    }

    if (req.headers.authorization !== `Bearer ${DASHBOARD_TOKEN}`) {
      res.writeHead(401).end('unauthorized');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/events/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      subscribers.add(res);
      req.on('close', () => subscribers.delete(res));
      res.write(': hello\n\n');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/sessions') {
      const list = [...recent.entries()].map(([userId, evs]) => {
        const last = evs[evs.length - 1];
        return {
          userId,
          lastSeen: last?.ts,
          msgCount: evs.length,
          lastEvent: last,
        };
      });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(list));
      return;
    }

    const m = url.pathname.match(/^\/sessions\/([^/]+)\/history$/);
    if (req.method === 'GET' && m) {
      const userId = decodeURIComponent(m[1]);
      const limit = Math.min(
        parseInt(url.searchParams.get('limit') ?? '50', 10) || 50,
        RECENT_LIMIT,
      );
      const evs = (recent.get(userId) ?? []).slice(-limit);
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(evs));
      return;
    }

    res.writeHead(404).end();
  })
  .listen(PORT);

// === Heartbeat ===============================================================
setInterval(() => {
  const ping = `event: heartbeat\ndata: ${JSON.stringify({ ts: new Date().toISOString() })}\n\n`;
  for (const res of subscribers) {
    try {
      res.write(ping);
    } catch {
      subscribers.delete(res);
    }
  }
}, 15_000);
