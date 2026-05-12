# Hugging Face Spaces Migration — Implementation Guide

This document covers the code changes, configuration steps, and deployment
workflow for migrating the agent-runtime container from Northflank to
Hugging Face Spaces.

## Files changed

### New files

| File | Purpose |
| ---- | ------- |
| `agent-runtime/scripts/hf-proxy.js` | Reverse proxy consolidating `:8080` + `:8081` → `:7860` (HF's required port) |
| `agent-runtime/hf-README.md` | HF Space metadata (`sdk: docker`, `app_port: 7860`); copied to `README.md` in the HF repo during sync |
| `.github/workflows/hf-sync.yml` | GitHub Actions: auto-sync `agent-runtime/` to HF on push + 12-hour keep-alive cron |

### Modified files

| File | Change |
| ---- | ------ |
| `agent-runtime/Dockerfile` | Added `COPY scripts/hf-proxy.js` and `EXPOSE 7860` |
| `agent-runtime/scripts/entrypoint.sh` | Added step 4b: start `hf-proxy.js` when `HF_SPACE=1` env is set |
| `edge/wrangler.toml` | Changed `GATEWAY_BASE_URL` and `SIDECAR_BASE_URL` from Northflank URLs to `https://andy770921-ai-agent.hf.space` |
| `edge/.dev.vars.example` | Removed "Northflank" from comment |

### Removed files

| File | Reason |
| ---- | ------ |
| `agent-runtime/.northflank/service.yaml` | Northflank IaC no longer needed |

### Updated docs

| File | Change |
| ---- | ------ |
| `README.md` | Replaced all Northflank references with HF Spaces; updated architecture diagram, deploy steps, cost section |
| `CLAUDE.md` | Replaced Northflank references; updated deploy section and project overview |
| `package.json` | Updated description |
| `agent-runtime/README.md` | Updated deploy target references |
| `agent-runtime/scripts/entrypoint.sh` | Updated comments (removed Northflank references) |

## How the reverse proxy works

```
                    :7860 (hf-proxy.js)
                      │
          ┌───────────┴───────────┐
          │                       │
  /webhook/*, /health      everything else
          │                       │
          ▼                       ▼
    :8080 (gateway)        :8081 (sidecar)
```

The proxy is activated by the `HF_SPACE=1` environment variable. When not set,
the container behaves exactly as before (gateway on 8080, sidecar on 8081).

## How the GitHub Actions workflow works

The workflow `.github/workflows/hf-sync.yml` has two jobs:

### `sync` (on push to `main` touching `agent-runtime/**`, or manual dispatch)

1. Checks out the GitHub repo
2. Clones the HF Space repo (`https://huggingface.co/spaces/andy770921/ai-agent`)
3. Clears old content, copies `agent-runtime/*` as the repo root
4. Overwrites `README.md` with `hf-README.md` (HF metadata frontmatter)
5. Commits and pushes → HF auto-rebuilds the Docker image

### `keep-alive` (every 12 hours via cron)

1. Sends an HTTP request to `https://andy770921-ai-agent.hf.space/`
2. If the Space is sleeping, this wakes it up
3. Resets the 48-hour inactivity timer

## Setup steps

### 1. GitHub repo secrets

Go to GitHub → Settings → Secrets and variables → Actions:

| Secret | Value |
| ------ | ----- |
| `HF_TOKEN` | Hugging Face Access Token with `write` permission (generate at huggingface.co/settings/tokens) |

### 2. HF Space secrets

Go to HF Space → Settings → Repository secrets. Add every env var the
container needs, plus the HF-specific one:

| Variable | Purpose |
| -------- | ------- |
| `HF_SPACE` | Set to `1` — enables the reverse proxy on :7860 |
| `LINE_CHANNEL_SECRET` | LINE webhook HMAC verification |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Messaging API |
| `GATEWAY_TOKEN` | openab ↔ gateway WebSocket auth |
| `LINE_ALLOWED_USER_IDS` | Comma-separated allowlist |
| `GEMINI_API_KEY` | Gemini CLI |
| `GITHUB_TOKEN` | GitHub MCP PAT |
| `CF_UPLOAD_SECRET` | Screenshot upload bearer |
| `CF_IMG_BASE_URL` | Worker URL for image uploads |
| `DASHBOARD_INGEST_TOKEN` | Sidecar auth bearer |

### 3. Cloudflare Worker

Update the two URL variables in Cloudflare Dashboard (or rely on
`wrangler.toml` `[vars]` after removing Dashboard overrides):

| Variable | New value |
| -------- | --------- |
| `GATEWAY_BASE_URL` | `https://andy770921-ai-agent.hf.space` |
| `SIDECAR_BASE_URL` | `https://andy770921-ai-agent.hf.space` |

Then redeploy: `cd edge && wrangler deploy`

### 4. Verify

1. Push a change to `agent-runtime/` on `main` → check GitHub Actions runs the sync job
2. Check HF Space build log at `https://huggingface.co/spaces/andy770921/ai-agent`
3. `curl https://andy770921-ai-agent.hf.space/` → should return `ok`
4. `curl https://andy770921-ai-agent.hf.space/health` → gateway health
5. Send a LINE message → verify the full webhook → agent → reply flow
