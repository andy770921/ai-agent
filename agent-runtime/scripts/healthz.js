// Node sidecar — owns the dashboard endpoints on :8081.
//
// Wires the events-emitter child process into an AgentEventBus, attaches
// three sinks (ring buffer, SSE fan-out, optional Langfuse), and exposes
// HTTP routes that delegate to the ring buffer + fan-out for queries.

const http = require('node:http');
const { spawn } = require('node:child_process');

const { createAgentEventBus } = require('./lib/agentEventBus');
const { createRingBufferSink } = require('./lib/ringBufferSink');
const { createSseFanoutSink } = require('./lib/sseFanoutSink');
const { createLangfuseSink } = require('./lib/langfuseSink');
const { createJsonLineDecoder } = require('./lib/jsonLineDecoder');

const PORT = 8081;
const DASHBOARD_TOKEN = process.env.DASHBOARD_INGEST_TOKEN;
if (!DASHBOARD_TOKEN) {
  console.error('DASHBOARD_INGEST_TOKEN missing — sidecar refusing to start');
  process.exit(1);
}

// === Sinks ==================================================================
const ringBuffer = createRingBufferSink({ limit: 200 });
const sseFanout = createSseFanoutSink();

let langfuseSink = null;
let langfuseInstance = null;
try {
  if (process.env.LANGFUSE_SECRET_KEY) {
    const Langfuse = require('langfuse').default;
    langfuseInstance = new Langfuse({
      secretKey: process.env.LANGFUSE_SECRET_KEY,
      publicKey: process.env.LANGFUSE_PUBLIC_KEY,
      baseUrl: process.env.LANGFUSE_BASE_URL,
    });
    langfuseSink = createLangfuseSink({ langfuse: langfuseInstance });
    console.error('langfuse: enabled');
  }
} catch (e) {
  console.error('langfuse: init failed —', e.message);
}

const bus = createAgentEventBus({
  sinks: [ringBuffer, sseFanout, ...(langfuseSink ? [langfuseSink] : [])],
});

// === Events emitter child ===================================================
const emitter = spawn('node', ['/usr/local/bin/events-emitter.js'], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
emitter.on('exit', (code) => {
  console.error('events-emitter exited', code);
});

const decoder = createJsonLineDecoder((line) => {
  try {
    bus.publish(JSON.parse(line));
  } catch {
    // skip non-JSON
  }
});
emitter.stdout.on('data', (chunk) => decoder.push(chunk.toString('utf8')));

// === HTTP routes ============================================================
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
      const unsubscribe = sseFanout.subscribe(res);
      req.on('close', unsubscribe);
      res.write(': hello\n\n');
      return;
    }

    if (req.method === 'GET' && url.pathname === '/sessions') {
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(ringBuffer.listSessions()));
      return;
    }

    const m = url.pathname.match(/^\/sessions\/([^/]+)\/history$/);
    if (req.method === 'GET' && m) {
      const userId = decodeURIComponent(m[1]);
      const limit = parseInt(url.searchParams.get('limit') ?? '50', 10) || 50;
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(ringBuffer.getHistory(userId, limit)));
      return;
    }

    res.writeHead(404).end();
  })
  .listen(PORT);

// === Heartbeat + Langfuse flush =============================================
setInterval(() => {
  sseFanout.heartbeat();
  if (langfuseInstance) langfuseInstance.flushAsync().catch(() => {});
}, 15_000);

// === Graceful shutdown (flush Langfuse before exit) =========================
process.on('SIGTERM', async () => {
  if (langfuseInstance) {
    try {
      await langfuseInstance.shutdownAsync();
    } catch {
      /* best-effort */
    }
  }
  process.exit(0);
});
