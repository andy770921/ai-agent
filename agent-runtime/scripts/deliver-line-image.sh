#!/bin/sh
# Usage: deliver-line-image.sh <line-userId> <local-image-path>
#
# Uploads <local-image-path> to the Worker /img endpoint, then sends a LINE
# image message via Push API to <line-userId>. One operation, one status.
#
# Exit codes:
#   0  delivered (image uploaded and pushed to LINE)
#   1  argument / env / upload failed (nothing to clean up)
#   2  upload succeeded but LINE push failed (orphan key logged to stderr;
#      KV TTL will clean it up automatically)
#
# Stdout on success: a single JSON line, e.g.
#   {"ok":true,"imageUrl":"https://.../img/abc123.png"}
set -eu

user="${1:-}"
src="${2:-}"
if [ -z "${user}" ] || [ -z "${src}" ]; then
  echo "usage: deliver-line-image.sh <line-userId> <local-image-path>" >&2
  exit 1
fi
if [ ! -f "${src}" ]; then
  echo "no such file: ${src}" >&2
  exit 1
fi

: "${CF_UPLOAD_SECRET:?CF_UPLOAD_SECRET not set}"
: "${CF_IMG_BASE_URL:?CF_IMG_BASE_URL not set}"
: "${LINE_CHANNEL_ACCESS_TOKEN:?LINE_CHANNEL_ACCESS_TOKEN not set}"

ext="${src##*.}"
case "$ext" in
  png|jpg|jpeg) ;;
  *) echo "unsupported ext: $ext" >&2; exit 1;;
esac

ct="image/${ext}"
[ "$ext" = "jpg" ] && ct="image/jpeg"

uuid="$(cat /proc/sys/kernel/random/uuid)"
key="${uuid}.${ext}"
image_url="${CF_IMG_BASE_URL}/img/${key}"

# === 1. Upload to Worker KV ===
# --retry-all-errors + --retry-connrefused make curl retry transient TLS /
# connection failures (e.g. SSL_ERROR_SYSCALL / HTTP 000), which are otherwise
# surfaced to the user as "unable to send the image" on a single network blip.
upload_status=$(curl -sS -o /tmp/deliver-upload.out -w '%{http_code}' \
  --retry 3 --retry-delay 2 --retry-all-errors --retry-connrefused \
  --connect-timeout 10 --max-time 60 \
  -X PUT \
  -H "Authorization: Bearer ${CF_UPLOAD_SECRET}" \
  -H "Content-Type: ${ct}" \
  --data-binary "@${src}" \
  "${image_url}" \
  || echo "000")

case "${upload_status}" in
  2*) ;;
  *)
    echo "upload failed: HTTP ${upload_status}" >&2
    cat /tmp/deliver-upload.out >&2 || true
    exit 1
    ;;
esac

# === 2. Push to LINE ===
# Safe to retry: X-Line-Retry-Key makes the push idempotent on LINE's side.
retry_key="$(cat /proc/sys/kernel/random/uuid)"
push_status=$(curl -sS -o /tmp/deliver-push.out -w '%{http_code}' \
  --retry 3 --retry-delay 2 --retry-all-errors --retry-connrefused \
  --connect-timeout 10 --max-time 30 \
  -X POST https://api.line.me/v2/bot/message/push \
  -H "Authorization: Bearer ${LINE_CHANNEL_ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "X-Line-Retry-Key: ${retry_key}" \
  -d "{\"to\":\"${user}\",\"messages\":[{\"type\":\"image\",\"originalContentUrl\":\"${image_url}\",\"previewImageUrl\":\"${image_url}\"}]}" \
  || echo "000")

if [ "${push_status}" != "200" ]; then
  echo "LINE push failed: HTTP ${push_status}" >&2
  echo "orphan key=${key} (KV TTL will clean up)" >&2
  cat /tmp/deliver-push.out >&2 || true
  exit 2
fi

printf '{"ok":true,"imageUrl":"%s"}\n' "${image_url}"
