#!/bin/sh
# Renders /etc/openab/openab.toml -> /tmp/openab.toml at boot.
# OpenAB natively expands ${VAR} in TOML; we add a derived LINE_ALLOWED_USER_IDS_TOML
# that converts the comma-separated allowlist env into a TOML list literal.
# See documents/FEAT-1/development/openab-config.md Step 3.
set -eu
template="${1:?usage: render-config.sh <template> <out>}"
out="${2:?usage: render-config.sh <template> <out>}"

# Build TOML list literal from the comma-separated env var, e.g.
#   "U1,U2 ,U3" -> ["U1","U2","U3"]
# Empty/absent -> [] (which OpenAB's auto-detect treats as "allow all").
ids="${LINE_ALLOWED_USER_IDS:-}"
inner="$(
  printf '%s' "$ids" | awk -v RS=',' '
    BEGIN { sep = "" }
    {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "")
      if ($0 != "") {
        printf "%s\"%s\"", sep, $0
        sep = ","
      }
    }
  '
)"
LINE_ALLOWED_USER_IDS_TOML="[${inner}]"
export LINE_ALLOWED_USER_IDS_TOML

# Pass an explicit allowlist to envsubst so unrelated $VAR-looking strings in
# the template (e.g. inside future comments) are left alone.
envsubst '${GATEWAY_TOKEN} ${GEMINI_API_KEY} ${GITHUB_TOKEN} ${LINE_CHANNEL_ACCESS_TOKEN} ${CF_UPLOAD_SECRET} ${CF_IMG_BASE_URL} ${LINE_ALLOWED_USER_IDS_TOML}' \
  < "$template" > "$out"
