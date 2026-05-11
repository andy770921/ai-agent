# agent-runtime

Container image for FEAT-1 — runs `openab-gateway`, `openab` core, Gemini CLI (`--acp`), Playwright MCP, GitHub MCP, and a dashboard sidecar inside one Docker image.

This directory is **not** an npm workspace; it's a Docker build context. Everything here is wired together at runtime via `scripts/entrypoint.sh`.

For the architecture rationale, deployment plan, and per-component design notes, see:
- `../documents/FEAT-1/plans/prd.md`
- `../documents/FEAT-1/development/northflank-container.md`
- `../documents/FEAT-1/development/openab-config.md`
- `../documents/FEAT-1/development/gemini-cli-tools.md`
- `../documents/FEAT-1/development/line-integration.md`
- `../documents/FEAT-1/development/openab-upstream-findings.md` ← read this **first** if you're picking up the work

## Quick local run

```sh
cp .env.example .env  # then fill in real values
docker compose up --build
curl http://localhost:8080/health    # openab-gateway
curl http://localhost:8081/healthz   # sidecar
```

## Files

- `Dockerfile` — multi-stage build: Rust → Node 22 runtime.
- `config/openab.toml` — OpenAB TOML, expanded by `scripts/render-config.sh`.
- `gemini/settings.json` — Gemini CLI settings (mcpServers + sandbox + model).
- `gemini/system.md` — system-prompt override (LINE persona).
- `gemini/policies/feat1.toml` — Policy Engine rules (tool allowlist).
- `scripts/entrypoint.sh` — boot order: render config → gateway → sidecar → openab.
- `scripts/render-config.sh` — env-var interpolation + CSV→TOML-array conversion.
- `scripts/healthz.js` — Node sidecar: `/healthz`, `/events/stream`, `/sessions`.
- `scripts/events-emitter.js` — tails `$GEMINI_TELEMETRY_OUTFILE`, reshapes to `AgentEvent`.
- `scripts/post-screenshot.sh` — uploads PNG to the Cloudflare Worker `/img` endpoint.
- `scripts/send-line-image.sh` — POSTs a LINE image-message via Push API.
- `.northflank/service.yaml` — Northflank service definition.

## Phase 0.3 first

Before promoting v1 to production, run the e2e spike documented in `../documents/FEAT-1/development/phase0-e2e-spike-runbook.md` (TBD). The Gemini telemetry field names that `events-emitter.js` reshapes are derived from upstream docs, not real samples; the first deploy is where we verify them.
