# =============================================================================
# FEAT-4 agent-runtime container
# Single Node 22 process running Mastra agent with Hono HTTP server.
# See documents/FEAT-4/development/cutover-execution.md
#
# One foreground process:
#   node dist/server.js  :7860  — LINE webhook, dashboard SSE, healthz
# Playwright + github-mcp-server are spawned per tool call by Mastra subagents.
# =============================================================================

# === Stage 1: Build (includes devDeps for TypeScript compilation) ============
FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json ./
# --ignore-scripts: postinstall downloads Chromium (for local dev only);
# in Docker, Chromium is installed globally above.
RUN npm install --ignore-scripts

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# === Stage 2: Runtime ========================================================
FROM node:22-bookworm-slim

# Runtime system deps:
# - ca-certificates, curl  — HTTPS + deliver-line-image.sh
# - procps, tini           — process supervision
# - Chromium runtime libs  — Playwright installs Chromium binaries; we provide
#                            the system libraries it links against.
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl procps tini \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libxkbcommon0 \
      libatspi2.0-0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
      libasound2 libpangocairo-1.0-0 libpango-1.0-0 libcairo2 \
 && rm -rf /var/lib/apt/lists/*

# --- Playwright MCP + Chromium browser (pinned, downloaded at build time) ---
ARG PLAYWRIGHT_MCP_VERSION=0.0.75
RUN npm install -g @playwright/mcp@${PLAYWRIGHT_MCP_VERSION} --retry 3
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# Install Chromium using the playwright-core that ships *with*
# @playwright/mcp, not a fresh `npx playwright`. Playwright 1.57 switched
# the "chromium" channel to Chrome-for-Testing builds, and
# @playwright/mcp@0.0.75 pins playwright-core@1.61.0-alpha-1778188671000,
# which expects a specific browser revision under
# PLAYWRIGHT_BROWSERS_PATH. A `npx --yes playwright install chromium`
# resolves to the latest playwright on npm and can drop a mismatched
# revision, leaving MCP unable to locate the binary at launch
# ("Browser 'chrome-for-testing' is not installed").
#
# `cd`-ing into the MCP package directory makes npx resolve
# playwright-core from ./node_modules/.bin/, pinning it to MCP's exact
# version. This mirrors the official microsoft/playwright-mcp Dockerfile
# at https://github.com/microsoft/playwright-mcp/blob/v0.0.75/Dockerfile
# `--no-shell` skips the chrome-headless-shell binary; MCP's --headless
# mode uses the full chrome-for-testing build instead.
#
# Also: MCP creates per-session cache dirs (e.g.
# /ms-playwright/mcp-chrome-for-testing-<hash>) at navigation time, so
# PLAYWRIGHT_BROWSERS_PATH must be writable by the non-root `node` user —
# not just readable.
RUN cd /usr/local/lib/node_modules/@playwright/mcp \
 && npx --yes playwright-core install --no-shell chromium \
 && chmod -R a+rwX /ms-playwright \
 && chmod -R a+rX /usr/local/lib/node_modules/@playwright

# --- GitHub MCP server (Go binary release) ---
ARG GH_MCP_VERSION=1.0.4
RUN curl -fsSL "https://github.com/github/github-mcp-server/releases/download/v${GH_MCP_VERSION}/github-mcp-server_Linux_x86_64.tar.gz" \
    | tar -xz -C /tmp \
 && mv /tmp/github-mcp-server /usr/local/bin/github-mcp-server \
 && rm -rf /tmp/github-mcp-server*

# --- gh CLI (operator fallback) ---
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# --- App: production dependencies only ---
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --ignore-scripts

# --- App: compiled TypeScript from build stage ---
COPY --from=build /app/dist/ dist/

# --- Scripts ---
COPY scripts/entrypoint.sh        /usr/local/bin/entrypoint.sh
COPY scripts/deliver-line-image.sh /usr/local/bin/deliver-line-image.sh
RUN chmod +x /usr/local/bin/entrypoint.sh \
             /usr/local/bin/deliver-line-image.sh

# --- Runtime contract ---
ENV NODE_ENV=production \
    HOME=/home/node

EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
    CMD curl -fsS http://127.0.0.1:7860/healthz || exit 1

USER node
WORKDIR /app
ENTRYPOINT ["tini", "--", "/usr/local/bin/entrypoint.sh"]
