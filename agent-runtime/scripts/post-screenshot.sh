#!/bin/sh
# Usage: post-screenshot.sh <local-path>
# Uploads to the Cloudflare Worker /img endpoint and prints the public URL.
set -eu
src="${1:?usage: post-screenshot.sh <path>}"
ext="${src##*.}"
case "$ext" in
  png|jpg|jpeg) ;;
  *) echo "unsupported ext: $ext" >&2; exit 2;;
esac

: "${CF_UPLOAD_SECRET:?CF_UPLOAD_SECRET not set}"
: "${CF_IMG_BASE_URL:?CF_IMG_BASE_URL not set}"

uuid="$(cat /proc/sys/kernel/random/uuid)"
key="${uuid}.${ext}"
ct="image/${ext}"
[ "$ext" = "jpg" ] && ct="image/jpeg"

curl -fsS -X PUT \
  -H "Authorization: Bearer ${CF_UPLOAD_SECRET}" \
  -H "Content-Type: ${ct}" \
  --data-binary "@${src}" \
  "${CF_IMG_BASE_URL}/img/${key}" >/dev/null

echo "${CF_IMG_BASE_URL}/img/${key}"
