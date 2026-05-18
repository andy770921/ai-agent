# Implementation Plan: Container, Deploy, and Cutover

## Overview

Rewrites the Dockerfile to a single Node 22 image. Removes Rust build
stage, `openab.toml`, the JSON-to-MCP-config renderer, `hf-proxy.js`,
and the entire Gemini Policy Engine. Adds the new TS app's `npm ci`
+ `tsc` build, plus Mastra's MCP runtime requirements (kept Chromium
for Playwright; removed Gemini CLI). Cutover swaps HF Space repos in
one push.

## Files to Modify

- `agent-runtime/Dockerfile` — major rewrite
- `agent-runtime/docker-compose.yml` — update env vars + ports
- `agent-runtime/.env.example` — replace with new vars from
  `design-decisions.md` §3 + agent-core.md step 1
- `agent-runtime/hf-README.md` — kept; update content
- `.github/workflows/hf-sync.yml` — kept as-is
- Files to DELETE (after the new image is verified in staging):
  - `agent-runtime/config/openab.toml`
  - `agent-runtime/mcp/servers.json`
  - `agent-runtime/gemini/` (entire dir)
  - `agent-runtime/scripts/render-config.sh`
  - `agent-runtime/scripts/render-mcp-config.sh`
  - `agent-runtime/scripts/events-emitter.js`
  - `agent-runtime/scripts/hf-proxy.js`
  - `agent-runtime/scripts/entrypoint.sh`
  - `agent-runtime/scripts/healthz.js`
  - `agent-runtime/scripts/lib/` (entire dir; ported to `src/observability/`)

## Step-by-Step Implementation

### Step 1: New Dockerfile

**File:** `agent-runtime/Dockerfile`

```dockerfile
# =============================================================================
# FEAT-4 agent-runtime — single Node 22 process. No Rust, no Gemini CLI.
# See documents/FEAT-4/plans/{prd,design-decisions}.md
# =============================================================================

FROM node:22-bookworm-slim AS deps
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl procps ripgrep tini \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libxkbcommon0 \
      libatspi2.0-0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
      libasound2 libpangocairo-1.0-0 libpango-1.0-0 libcairo2 \
 && rm -rf /var/lib/apt/lists/*

# Chromium binary for Playwright MCP. The `@playwright/mcp` npm package
# itself is a runtime dep in agent-runtime/package.json and gets pulled
# by `npm ci` in the build stage — no global install needed.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# Skip the postinstall download since this Docker layer will do it
# explicitly to bake Chromium into the image (not the runtime).
ENV PLAYWRIGHT_SKIP_BROWSER_INSTALL=1
RUN npx --yes playwright install chromium && chmod -R a+rX /ms-playwright

# GitHub MCP (still needed; binary release)
ARG GH_MCP_VERSION=1.0.4
RUN curl -fsSL "https://github.com/github/github-mcp-server/releases/download/v${GH_MCP_VERSION}/github-mcp-server_Linux_x86_64.tar.gz" \
    | tar -xz -C /tmp \
 && mv /tmp/github-mcp-server /usr/local/bin/github-mcp-server \
 && rm -rf /tmp/github-mcp-server*

# === Build stage ============================================================
FROM deps AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY agent-runtime/package.json agent-runtime/
RUN npm ci --workspaces --include-workspace-root
COPY shared/ shared/
COPY agent-runtime/ agent-runtime/
RUN npm run build --workspace=@repo/shared
RUN npm run build --workspace=@repo/agent-runtime

# === Runtime stage ==========================================================
FROM deps AS runtime
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/shared/dist ./shared/dist
COPY --from=build /app/agent-runtime/dist ./agent-runtime/dist
COPY --from=build /app/agent-runtime/package.json ./agent-runtime/
COPY agent-runtime/scripts/deliver-line-image.sh /usr/local/bin/deliver-line-image.sh
RUN chmod +x /usr/local/bin/deliver-line-image.sh

ENV NODE_ENV=production \
    HOME=/home/node \
    PORT=7860

EXPOSE 7860

USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=30s --retries=3 \
    CMD curl -fsS http://127.0.0.1:7860/healthz || exit 1
ENTRYPOINT ["tini", "--", "node", "--enable-source-maps", "agent-runtime/dist/server.js"]
```

**Rationale:** Three stages: `deps` (system libs + Chromium + GitHub
MCP binary), `build` (workspace `npm ci` pulls `@playwright/mcp`,
`tsc`), `runtime` (copy dist + minimal layer). Final image should be
~1.5 GB (Chromium alone is ~300 MB; Node base is ~150 MB; deps ~200
MB; everything else < 500 MB).

**Local dev parity:** `agent-runtime/package.json` has
`@playwright/mcp` as a runtime dep + a `postinstall` script that
downloads Chromium for dev machines. See
`acceptance-tests.md` §"Step 3: Local dev — Playwright + Chromium
without Docker" for the script and the opt-out env var
(`PLAYWRIGHT_SKIP_BROWSER_INSTALL=1`, which is what this Dockerfile
sets to avoid double-downloading).

### Step 2: Compose for local dev

**File:** `agent-runtime/docker-compose.yml`

```yaml
services:
  agent-runtime:
    build: .
    ports: ["7860:7860"]
    env_file: .env
    environment:
      - NODE_ENV=development
    volumes:
      - ./src:/app/agent-runtime/src
    command: ["npm", "run", "dev", "--workspace=@repo/agent-runtime"]
```

For local Supabase, run `npx supabase start` in a side shell — don't
bundle Postgres into compose (too heavy for HF Spaces dev parity).

### Step 3: `.env.example`

**File:** `agent-runtime/.env.example`

```bash
# LINE
LINE_CHANNEL_SECRET=
LINE_CHANNEL_ACCESS_TOKEN=
LINE_ALLOWED_USER_IDS=             # comma-separated; empty = allow all

# LLM providers (at minimum one; default selected via agent_config.default_model)
GEMINI_API_KEY=
ANTHROPIC_API_KEY=
OPENAI_API_KEY=

# GitHub MCP
GITHUB_TOKEN=

# Image upload (existing edge worker /img endpoint)
CF_UPLOAD_SECRET=
CF_IMG_BASE_URL=

# Dashboard
DASHBOARD_INGEST_TOKEN=
DASHBOARD_TOKEN=

# Curator cron
CURATOR_TOKEN=

# Supabase
SUPABASE_URL=https://<ref>.supabase.co
SUPABASE_SERVICE_KEY=

# Langfuse
LANGFUSE_SECRET_KEY=
LANGFUSE_PUBLIC_KEY=
LANGFUSE_BASE_URL=https://jp.cloud.langfuse.com
```

Drop: `GATEWAY_TOKEN`, all `OPENAB_*`, all `GEMINI_TELEMETRY_*`,
`GEMINI_CLI_TRUST_WORKSPACE`.

### Step 4: Cutover playbook

Cutover happens in week 5. Pre-flight: all 9 Success Criteria from the
PRD pass on a staging HF Space.

1. **Staging verification** (T-3 days)
   - Deploy new image to a side HF Space named
     `andy770921-ai-agent-v2`.
   - Point the LINE Messaging API webhook URL at v2 for a test channel
     (NOT the production channel).
   - Run the acceptance fixtures (see PRD §"Testing Strategy" + each
     module's "Testing Steps").
   - Watch Langfuse: every turn produces a trace with subagent
     sub-traces.

2. **Backup capture** (T-1 day)
   - Snapshot the current production HF Space repo to a branch
     `pre-feat-4` in the Space.
   - Export the existing `agent_config` from FEAT-1 if any (there isn't
     — config is in files today).

3. **Cutover** (T-0)
   - Push the new image (via `git push hf main` from local
     `agent-runtime/` clone of the HF Space repo).
   - Wait for HF Space rebuild to go green (~5 min).
   - Flip LINE webhook URL to production HF Space.
   - Run **all 9 Success Criteria** against the live bot using the
     real LINE channel. Document timestamps.

4. **Decommission** (T+1 day)
   - Delete the staging HF Space.
   - In the main repo: delete the `agent-runtime/` files listed in
     "Files to Modify" → "Files to DELETE".
   - Open the cleanup PR with title `chore(agent-runtime): remove FEAT-1 leftovers post-FEAT-4`.

5. **Rollback procedure** (if needed within 24 h)
   - In HF Space repo, `git revert <feat-4-commit> && git push`.
   - HF Space rebuilds the old image; LINE webhook stays pointed at the
     same URL (no change needed at LINE side).
   - Old `openab` + Gemini stack resumes; no data loss because FEAT-4
     persistence is additive (we never deleted old Docker volume; just
     stopped using it).

## Testing Steps

1. Local: `docker compose up --build`, hit `curl
   http://localhost:7860/healthz` → 200.
2. Local: simulate a signed LINE webhook payload → expect 200 + a
   logged Mastra turn.
3. Staging HF Space: 9 PRD Success Criteria pass.
4. Production: same 9 + the Playwright bug regression test
   (`screenshot google.com`).

## Dependencies

- Must complete after ALL other implementation plans
- Depends on: every other dev doc in this folder

## Notes

- HF Space repo lives at
  `https://huggingface.co/spaces/andy770921/ai-agent` (per FEAT-2). The
  cutover deploys to the same Space; the staging Space is a temporary
  fork.
- The image must stay ≤ 1.8 GB to meet PRD Success Criterion #8. If
  builds exceed: first prune devDependencies in the runtime stage; if
  still over, split Playwright into a sidecar service (would require a
  new HF Space and SSH between them — punt to FEAT-4.1).
- The Cloudflare Worker (`edge/`) does **not** need to change for
  FEAT-4 cutover — webhook forwarding URL stays the same; only the HF
  Space content changes.
