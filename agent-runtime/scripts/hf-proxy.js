// Lightweight reverse proxy for Hugging Face Spaces.
// HF only exposes port 7860 externally; this proxy routes requests to the
// correct internal service based on URL path.
//   /webhook/* , /health  -> openab-gateway :8080
//   everything else       -> Node sidecar   :8081

const http = require('node:http');

const PROXY_PORT = 7860;
const GATEWAY = { host: '127.0.0.1', port: 8080 };
const SIDECAR = { host: '127.0.0.1', port: 8081 };

function pickTarget(url) {
  if (url === '/health' || url.startsWith('/webhook')) return GATEWAY;
  return SIDECAR;
}

const server = http.createServer((req, res) => {
  // Root path: status page for HF Space UI + HF health-check.
  if (req.url === '/') {
    const status = [
      'openab-agent-runtime',
      '',
      'Public endpoints (no auth):',
      '  GET  /health          — gateway health check',
      '  GET  /healthz         — sidecar health check',
      '',
      'LINE webhook (HMAC signature):',
      '  POST /webhook/line    — LINE Platform webhook',
      '',
      'Dashboard API (Bearer token):',
      '  GET  /events/stream   — SSE event stream',
      '  GET  /sessions        — active session list',
      '  GET  /sessions/:userId/history — session history',
    ].join('\n');
    res.writeHead(200, { 'content-type': 'text/plain' }).end(status);
    return;
  }

  const target = pickTarget(req.url);

  const proxyReq = http.request(
    {
      hostname: target.host,
      port: target.port,
      path: req.url,
      method: req.method,
      headers: req.headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end('Bad Gateway');
  });

  req.pipe(proxyReq);
});

server.listen(PROXY_PORT, () => {
  console.log(`hf-proxy listening on :${PROXY_PORT}`);
});
