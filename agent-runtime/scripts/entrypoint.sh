#!/bin/sh
# FEAT-4 agent-runtime entrypoint.
# Single Node process — no OpenAB, no sidecar, no reverse proxy.
set -eu

# ===== Validate required env (fail-fast on misconfig) =====================
: "${LINE_CHANNEL_SECRET:?missing}"
: "${LINE_CHANNEL_ACCESS_TOKEN:?missing}"
: "${SUPABASE_URL:?missing}"
: "${SUPABASE_SERVICE_KEY:?missing}"
: "${DASHBOARD_INGEST_TOKEN:?missing}"
: "${CF_UPLOAD_SECRET:?missing}"
: "${CF_IMG_BASE_URL:?missing}"

echo "===== Application Startup at $(date '+%Y-%m-%d %H:%M:%S') ====="

# ===== Start the single Node process ======================================
# Absolute path: container's WORKDIR is /home/node so the runtime cwd is
# writable for MCP, but the app code lives at /app.
exec node --enable-source-maps /app/dist/server.js
