# =============================================================================
# FEAT-1 agent-runtime container
# Mirrors the architecture documented in documents/FEAT-1/development/
#   - northflank-container.md (historical)
#   - openab-config.md
#   - gemini-cli-tools.md
#
# Three foreground processes run inside this container (via entrypoint.sh):
#   1. openab-gateway   :8080   public  — LINE webhook + WebSocket for openab
#   2. openab           -       -       — outbound-only ACP harness
#   3. healthz.js       :8081   public  — dashboard endpoints (sidecar)
# Gemini CLI is spawned per session by openab; Playwright + github-mcp-server
# subprocesses are spawned per tool call by Gemini.
# =============================================================================

# === Stage 1: Build openab + openab-gateway from upstream source ===========
FROM rust:1.95-slim-bookworm AS openab-build
RUN apt-get update && apt-get install -y --no-install-recommends \
      pkg-config libssl-dev ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
ARG OPENAB_REF=main
WORKDIR /src
RUN git clone --depth 1 --branch ${OPENAB_REF} https://github.com/openabdev/openab.git .
# Upstream is NOT a single Cargo workspace — `openab` is the root crate and
# `openab-gateway` is a sibling crate under `gateway/`. Build both separately.
RUN cargo build --release --bin openab
RUN cargo build --release --manifest-path gateway/Cargo.toml --bin openab-gateway

# === Stage 2: Runtime ======================================================
FROM node:22-bookworm-slim

# Runtime deps:
# - ca-certificates, curl  — HTTPS + deliver-line-image.sh
# - procps, tini           — process supervision
# - ripgrep                — used by Gemini CLI's file search
# - gettext-base           — envsubst for render-config.sh
# - Chromium runtime libs  — Playwright installs Chromium binaries; we provide
#                            the system libraries it links against.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl procps ripgrep tini gettext-base \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libxkbcommon0 \
      libatspi2.0-0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
      libasound2 libpangocairo-1.0-0 libpango-1.0-0 libcairo2 \
 && rm -rf /var/lib/apt/lists/*

# --- Gemini CLI (pinned, matches upstream openab Dockerfile.gemini family) ---
ARG GEMINI_CLI_VERSION=0.41.2
RUN npm install -g @google/gemini-cli@${GEMINI_CLI_VERSION} --retry 3

# --- Playwright MCP + Chromium browser (pinned, downloaded at build time) ---
ARG PLAYWRIGHT_MCP_VERSION=0.0.30
RUN npm install -g @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} --retry 3
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx --yes playwright install chromium \
 && chmod -R a+rX /ms-playwright

# --- GitHub MCP server (Go binary release) ---
ARG GH_MCP_VERSION=1.0.4
RUN curl -fsSL "https://github.com/github/github-mcp-server/releases/download/v${GH_MCP_VERSION}/github-mcp-server_Linux_x86_64.tar.gz" \
    | tar -xz -C /tmp \
 && mv /tmp/github-mcp-server /usr/local/bin/github-mcp-server \
 && rm -rf /tmp/github-mcp-server*

# --- Langfuse SDK for sidecar observability (optional — enabled by env) ---
RUN mkdir -p /opt/sidecar \
 && cd /opt/sidecar \
 && npm init -y \
 && npm install langfuse@3 --save
ENV NODE_PATH=/opt/sidecar/node_modules

# --- gh CLI (operator fallback; not exposed to the agent by default policy) ---
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# --- Copy OpenAB binaries from the build stage ---
COPY --from=openab-build /src/target/release/openab                 /usr/local/bin/openab
COPY --from=openab-build /src/gateway/target/release/openab-gateway /usr/local/bin/openab-gateway

# --- Copy configs and prep /home/node/.gemini/ ---
RUN mkdir -p /home/node/.gemini/policies /var/lib/openab/sessions /var/log/openab /etc/openab \
 && chown -R node:node /home/node/.gemini /var/lib/openab/sessions /var/log/openab
COPY config/openab.toml /etc/openab/openab.toml
COPY mcp/servers.json              /etc/openab/mcp-servers.json
COPY --chown=node:node gemini/settings.json        /home/node/.gemini/settings.json
COPY --chown=node:node gemini/system.md            /home/node/.gemini/system.md
COPY --chown=node:node gemini/policies/tool-allowlist.toml  /home/node/.gemini/policies/tool-allowlist.toml

# --- Copy scripts ---
COPY scripts/entrypoint.sh        /usr/local/bin/entrypoint.sh
COPY scripts/render-config.sh     /usr/local/bin/render-config.sh
COPY scripts/render-mcp-config.sh /usr/local/bin/render-mcp-config.sh
COPY scripts/healthz.js           /usr/local/bin/healthz.js
COPY scripts/events-emitter.js    /usr/local/bin/events-emitter.js
COPY scripts/hf-proxy.js          /usr/local/bin/hf-proxy.js
COPY scripts/lib/                 /usr/local/bin/lib/
COPY scripts/deliver-line-image.sh /usr/local/bin/deliver-line-image.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
             /usr/local/bin/render-config.sh \
             /usr/local/bin/render-mcp-config.sh \
             /usr/local/bin/deliver-line-image.sh

# --- Runtime contract ---
ENV NODE_ENV=production \
    HOME=/home/node \
    OPENAB_CONFIG=/etc/openab/openab.toml \
    OPENAB_SESSION_DIR=/var/lib/openab/sessions

EXPOSE 7860 8080 8081
VOLUME ["/var/lib/openab/sessions"]

HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8080/health || exit 1

USER node
WORKDIR /home/node
ENTRYPOINT ["tini", "--", "/usr/local/bin/entrypoint.sh"]
