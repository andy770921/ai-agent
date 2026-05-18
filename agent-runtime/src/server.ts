import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { lineWebhookHandler } from './line/webhookHandler.js';
import {
  sseStreamHandler,
  sessionsHandler,
  sessionHistoryHandler,
} from './observability/sse.js';
import { imageUploadHandler } from './ports/imageStore.js';
import { healthzHandler } from './ports/healthz.js';
import { curatorHandler } from './curator/handler.js';
import { flushQueue } from './db/writeQueue.js';
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
app.post('/admin/curator', curatorHandler);

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

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, flushing write queue…');
  await flushQueue();
  process.exit(0);
});
