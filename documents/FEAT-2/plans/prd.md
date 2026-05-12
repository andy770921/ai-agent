# FEAT-2: Migrate agent-runtime from Northflank to Hugging Face Spaces

## Problem

The agent-runtime container was originally designed to deploy on Northflank
(`nf-compute-100-2`, 1 vCPU / 2 GB, ~$24/mo). However, Northflank requires a
credit card even for its free tier. The goal is to find a **free,
no-credit-card** hosting platform for the Docker container.

## Research summary

Platforms evaluated (May 2026):

| Platform              | Credit card | Free tier RAM | Always-on? | Verdict                              |
| --------------------- | ----------- | ------------- | ---------- | ------------------------------------ |
| Oracle Cloud Free VPS | YES         | 24 GB ARM     | Yes        | Best specs, but card required        |
| Northflank            | YES         | -             | Yes        | Original host; card required         |
| Fly.io                | YES         | -             | -          | No free tier for new users           |
| Railway               | YES         | -             | -          | Card required, 30-day trial          |
| Google Cloud          | YES         | 1 GB          | -          | Card for verification                |
| AWS Free Tier         | YES         | 1 GB          | 12 months  | Card required                        |
| **HF Spaces (Docker)**| **NO**      | **16 GB**     | 48 h*      | **Selected** — generous, free, no card |
| Koyeb                 | NO          | 512 MB        | Yes        | Too little RAM for multi-process     |
| Render                | NO          | 512 MB        | 15 min*    | Sleeps too aggressively for webhooks |
| Back4App              | NO          | 256 MB        | 600 h/mo   | Too little RAM and hours             |
| Sealos Cloud          | NO          | 4 GB          | Unclear    | Unclear if permanent free tier       |

\* Sleeps after the stated idle period; mitigated with a keep-alive cron.

## Decision

**Hugging Face Spaces (Docker SDK)** — 2 vCPU, 16 GB RAM, native Docker
support, no credit card, free forever (not a trial).

HF Space: `https://huggingface.co/spaces/andy770921/ai-agent`
Public URL: `https://andy770921-ai-agent.hf.space`

## Key constraints and mitigations

### 1. Single exposed port (7860)

HF Spaces only exposes one port externally. The agent-runtime has two internal
services:

- `openab-gateway` on `:8080` — LINE webhook receiver
- Node sidecar on `:8081` — dashboard SSE + REST endpoints

**Solution:** A lightweight Node.js reverse proxy (`hf-proxy.js`) listens on
`:7860` and routes by URL path:

- `/webhook/*`, `/health` → `:8080` (gateway)
- `/` → plain-text status page listing all endpoints (also satisfies HF health check)
- everything else → `:8081` (sidecar, requires `Bearer` token)

The proxy is only started when `HF_SPACE=1` is set, so the same Dockerfile
works for other deployment targets.

### 2. Sleep after 48 hours of inactivity

HF Spaces free tier puts the container to sleep after 48 hours with no HTTP
traffic.

**Solution:** A GitHub Actions cron job pings the Space URL every 12 hours:

```yaml
schedule:
  - cron: '0 */12 * * *'
```

### 3. Ephemeral storage

Container filesystem resets on restart. This is acceptable because:

- Session state is in-memory and short-lived (Gemini CLI sessions)
- Images are uploaded to Cloudflare KV (external)
- Telemetry events are in-memory ring buffers (dashboard sidecar)

### 4. Cloudflare Worker URL update

The edge Worker previously pointed to two separate Northflank hostnames
(`:8080` and `:8081`). With the single-port proxy, both `GATEWAY_BASE_URL` and
`SIDECAR_BASE_URL` now point to the same HF Spaces URL.

## Cost impact

| Component         | Before (Northflank) | After (HF Spaces) |
| ----------------- | ------------------- | ------------------ |
| Container hosting | ~$24/mo             | $0                 |
| Cloudflare Worker | $5/mo               | $5/mo              |
| **Total**         | **~$29/mo**         | **$5/mo**          |

## References

- [Hugging Face Spaces Docker SDK docs](https://huggingface.co/docs/hub/spaces-sdks-docker)
- [HF Spaces sleep behavior](https://huggingface.co/docs/hub/spaces-overview)
- [Keep-alive pattern with GitHub Actions](https://dev.to/0xkoji/prevent-hugging-face-spaces-from-sleeping-with-github-actions-agent-browser-2p4f)
