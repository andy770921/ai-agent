import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { lineWebhookHandler } from './line/webhookHandler.js';
import { sseStreamHandler, sessionsHandler, sessionHistoryHandler } from './observability/sse.js';
import { imageUploadHandler } from './ports/imageStore.js';
import { healthzHandler } from './ports/healthz.js';
import { agentEventBus } from './observability/bus.js';
import { extractMemory } from './memory/extractMemory.js';
import { maybeCreateSkill } from './skills/createSkill.js';

// Side-effect imports: register bus listeners
import './observability/ringBufferSink.js';
import './memory/sessionEndDetector.js';
import './skills/sessionMetrics.js';

const app = new Hono();

app.post('/webhook/line', lineWebhookHandler);
app.get('/events/stream', sseStreamHandler);
app.get('/sessions', sessionsHandler);
app.get('/sessions/:id/history', sessionHistoryHandler);
app.post('/img', imageUploadHandler);
app.get('/healthz', healthzHandler);
app.get('/', (c) => c.text('agent-runtime ok'));

// Session-end pipelines
agentEventBus.on(async (ev) => {
  if (ev.type !== 'session_ended') return;
  Promise.all([
    extractMemory(ev.userId, ev.sessionId),
    maybeCreateSkill(ev.userId, ev.sessionId),
  ]).catch((e) => console.error('session-end pipelines', e));
});

const port = Number(process.env.PORT ?? 7860);
serve({ fetch: app.fetch, port });
console.log(`agent-runtime listening on :${port}`);

// Startup diagnostics — log MCP binary availability
import { existsSync } from 'node:fs';
const mcpBin = '/usr/local/lib/node_modules/@playwright/mcp/cli.js';
const ghBin = '/usr/local/bin/github-mcp-server';
if (process.platform === 'linux') {
  console.log(`playwright-mcp: ${existsSync(mcpBin) ? 'OK' : 'MISSING'} (${mcpBin})`);
  console.log(`github-mcp: ${existsSync(ghBin) ? 'OK' : 'MISSING'} (${ghBin})`);
}

import { flushLangfuse, getLangfuse } from './observability/langfuse.js';

// Initialize Langfuse at startup (logs enabled/disabled status)
getLangfuse();

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, flushing…');
  await flushLangfuse();
  process.exit(0);
});
