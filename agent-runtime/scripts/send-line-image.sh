#!/bin/sh
# Usage: send-line-image.sh <line-userId> <https-image-url>
# Sends a LINE Messaging API image-message via Push API.
# See documents/FEAT-1/development/gemini-cli-tools.md Step 5b.
set -eu
user="${1:?usage: send-line-image.sh <userId> <imageUrl>}"
url="${2:?usage: send-line-image.sh <userId> <imageUrl>}"

: "${LINE_CHANNEL_ACCESS_TOKEN:?LINE_CHANNEL_ACCESS_TOKEN not set}"
case "$url" in
  https://*) ;;
  *) echo "imageUrl must be https://: $url" >&2; exit 2;;
esac

retry_key="$(cat /proc/sys/kernel/random/uuid)"

http_status=$(curl -fsS -o /tmp/line-push.out -w '%{http_code}' \
  -X POST https://api.line.me/v2/bot/message/push \
  -H "Authorization: Bearer ${LINE_CHANNEL_ACCESS_TOKEN}" \
  -H "Content-Type: application/json" \
  -H "X-Line-Retry-Key: ${retry_key}" \
  -d "{\"to\":\"${user}\",\"messages\":[{\"type\":\"image\",\"originalContentUrl\":\"${url}\",\"previewImageUrl\":\"${url}\"}]}" \
  || true)

if [ "${http_status}" != "200" ]; then
  echo "LINE push failed: HTTP ${http_status}" >&2
  cat /tmp/line-push.out >&2 || true
  exit 1
fi
echo "ok"
