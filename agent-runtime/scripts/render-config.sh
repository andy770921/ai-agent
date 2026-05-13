#!/bin/sh
# Renders /etc/openab/openab.toml -> /tmp/openab.toml at boot.
# See documents/FEAT-1/development/openab-config.md Step 3.
set -eu
template="${1:?usage: render-config.sh <template> <out>}"
out="${2:?usage: render-config.sh <template> <out>}"

# Pass an explicit allowlist to envsubst so unrelated $VAR-looking strings in
# the template (e.g. inside future comments) are left alone.
envsubst '${GATEWAY_TOKEN} ${GEMINI_API_KEY} ${GITHUB_TOKEN} ${LINE_CHANNEL_ACCESS_TOKEN} ${CF_UPLOAD_SECRET} ${CF_IMG_BASE_URL}' \
  < "$template" > "$out"
