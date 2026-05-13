#!/bin/sh
# Boots the FEAT-1 agent-runtime container.
# See documents/FEAT-1/development/northflank-container.md Step 5
# and documents/FEAT-2/development/hf-spaces-migration.md.
set -eu

# ===== 1. Validate required env (fail-fast on misconfig) =====================
# Gateway-only:
: "${LINE_CHANNEL_SECRET:?missing}"
: "${LINE_CHANNEL_ACCESS_TOKEN:?missing}"
: "${GATEWAY_TOKEN:?missing}"
# OpenAB / agent:
: "${GEMINI_API_KEY:?missing}"
: "${GITHUB_TOKEN:?missing}"
: "${CF_UPLOAD_SECRET:?missing}"
: "${CF_IMG_BASE_URL:?missing}"
# Dashboard sidecar:
: "${DASHBOARD_INGEST_TOKEN:?missing}"

# openab-gateway requires at least one platform env to be defined even if only
# LINE is enabled. Set a harmless placeholder for Telegram so it boots; if
# TELEGRAM_BOT_TOKEN is already set by the operator, keep it.
export TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-disabled-for-line-only-deploy}"

# ===== 2. Render OpenAB TOML =================================================
/usr/local/bin/render-config.sh /etc/openab/openab.toml /tmp/openab.toml

# ===== 3. Start openab-gateway (background) ==================================
GATEWAY_LISTEN="${GATEWAY_LISTEN:-0.0.0.0:8080}" \
LINE_CHANNEL_SECRET="$LINE_CHANNEL_SECRET" \
LINE_CHANNEL_ACCESS_TOKEN="$LINE_CHANNEL_ACCESS_TOKEN" \
GATEWAY_TOKEN="$GATEWAY_TOKEN" \
TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN" \
  openab-gateway &
gw_pid=$!

# ===== 4. Start the Node sidecar (background) ================================
GEMINI_TELEMETRY_OUTFILE="${GEMINI_TELEMETRY_OUTFILE:-/var/log/openab/gemini-events.jsonl}" \
DASHBOARD_INGEST_TOKEN="$DASHBOARD_INGEST_TOKEN" \
  node /usr/local/bin/healthz.js &
hz_pid=$!

# ===== 4b. Start HF Spaces reverse proxy if HF_SPACE=1 =====================
if [ "${HF_SPACE:-}" = "1" ]; then
  node /usr/local/bin/hf-proxy.js &
  echo "hf-proxy started on :7860" >&2
fi

# ===== 5. Wait for the gateway to bind, then start openab core (NOT exec) ===
# Cold Rust binaries can take 20+ seconds to bind. Wait up to 60s.
for i in $(seq 1 120); do
  if curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1; then
    echo "openab-gateway up after ${i} half-seconds" >&2
    break
  fi
  if [ "$i" = "120" ]; then
    echo "openab-gateway never bound on :8080; aborting" >&2
    kill -TERM "$gw_pid" "$hz_pid" 2>/dev/null || true
    exit 1
  fi
  sleep 0.5
done

# Start openab core in the background so the trap below can reach it.
# (Using `exec` would replace this shell and lose the trap, so SIGTERM
# would not propagate to the gateway/sidecar children.)
openab run -c /tmp/openab.toml &
ab_pid=$!

# Propagate SIGTERM/SIGINT to every child so the orchestrator's stop signal
# kills the gateway, sidecar, and core cleanly.
trap 'kill -TERM $gw_pid $hz_pid $ab_pid 2>/dev/null || true; wait' TERM INT

# Wait for openab core; exit with its status. If gateway or sidecar dies first,
# `wait` returns its status — that's still the right thing to surface.
wait "$ab_pid"
exit_code=$?
kill -TERM "$gw_pid" "$hz_pid" 2>/dev/null || true
wait 2>/dev/null || true
exit "$exit_code"
