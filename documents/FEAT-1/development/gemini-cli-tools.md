# Implementation Plan: Gemini CLI + MCP Tools

## Overview

Configure the Gemini CLI process — the actual brain that OpenAB spawns per session — with two MCP servers that give it superpowers:

1. **Playwright MCP** — drives Chromium for "screenshot https://example.com" type tasks.
2. **GitHub access** — read-only on any repo, `pull_requests:write` on a curated list. Two valid implementations evaluated below.

Plus the Gemini CLI itself needs:
- A pinned `GEMINI_API_KEY` (Google AI Studio free tier).
- A system prompt that makes it act like a polite LINE assistant rather than a coding companion (the default Gemini CLI persona is "I am here to help you write code").
- A small post-tool-use convention: after Playwright screenshots, the agent must `PUT` the image to the Cloudflare Worker and return the `https://<worker>/img/<uuid>.png` URL so the LINE gateway can attach it to a reply.

## Files to Create / Modify

> Lives inside this monorepo at `agent-runtime/` (top-level folder, not an npm workspace).
> Layout updated per `openab-upstream-findings.md` — `system.md` replaces `system-prompt.md`,
> tool gating moves to a TOML policy file, and a second helper `send-line-image.sh` is
> added because OpenAB does not relay images (the agent calls LINE Push API directly).

```
agent-runtime/
├── gemini/
│   ├── settings.json                # NEW — Gemini CLI mcpServers + sandbox + model
│   ├── system.md                    # NEW — LINE-shaped system-prompt override
│   │                                #       (lives at /home/node/.gemini/system.md
│   │                                #       in the container; fully replaces the
│   │                                #       built-in coding-assistant prompt)
│   └── policies/
│       └── feat1.toml               # NEW — User-tier Policy Engine TOML.
│                                    #       Allow only post-screenshot.sh +
│                                    #       send-line-image.sh; deny every other
│                                    #       shell command and unknown MCP server.
└── scripts/
    ├── post-screenshot.sh           # NEW — PUTs PNG to CF Worker /img, prints URL
    └── send-line-image.sh           # NEW — POSTs LINE Push API image message
                                     #       (needs LINE_CHANNEL_ACCESS_TOKEN in env)
```

## Step-by-Step Implementation

### Step 0: ~~Verify Gemini CLI ACP compatibility~~ — RESOLVED

> **Resolved in `openab-upstream-findings.md` §5 and §10.** Confirmed:
> - `gemini --acp` is native (the flag is documented in `gemini --help` and in `bundle/docs/cli/acp-mode.md`).
> - The OpenAB upstream `Dockerfile.gemini` itself ships `@google/gemini-cli@0.40.1` with `args = ["--acp"]`.
> - Verified the offline parts (install, `--help`, bundled docs) on `v0.41.2` against node 22.
>
> The remaining piece is the live ACP round-trip (sending `initialize` over stdio and getting a response) — that's in Phase 0.3, alongside the rest of the e2e spike.

### Step 1: Decide GitHub integration path

| Option | How it works | Pros | Cons |
|--------|--------------|------|------|
| **A. GitHub MCP server** (`github/github-mcp-server`) | Official MCP server; Gemini calls structured tools (`list_pulls`, `get_pull`, `create_pull_request_review_comment`, etc.) | Type-safe tool schema; Gemini understands intents better; clean audit log of tool calls | More moving parts; another binary in the image; tool surface is broad and needs allowlisting |
| **B. `gh` CLI as a shell tool** | Gemini's built-in shell tool runs `gh pr view 123 --repo owner/foo`, `gh pr comment ...`, etc. | Already installed (Step 2 of `northflank-container.md`); no MCP wiring; tiny config | No structured schema, more brittle prompts; harder to constrain to "PR-only" actions |

**Decision:** **Option A (GitHub MCP server)** for v1. The structured tool schema is what gives us a clean audit + the ability to enumerate "agent attempted to call X" in logs. Keep `gh` available as a fallback that we can flip to via config without rebuilding the image.

### Step 2: Add GitHub MCP server to the image

**File:** `agent-runtime/Dockerfile` (extend the install step from `northflank-container.md` Step 2)

**Changes:**

```dockerfile
# GitHub MCP server (Go binary). Pin a release.
# NOTE: v1.0.x changed the asset naming convention — the version number is no
# longer embedded in the tarball filename.
ARG GH_MCP_VERSION=1.0.4
RUN curl -fsSL "https://github.com/github/github-mcp-server/releases/download/v${GH_MCP_VERSION}/github-mcp-server_Linux_x86_64.tar.gz" \
    | tar -xz -C /tmp \
 && mv /tmp/github-mcp-server /usr/local/bin/github-mcp-server \
 && rm -rf /tmp/*
```

**Rationale:** prebuilt Go binary; ~15 MB. Pinning the version is non-negotiable.

### Step 3: Author Gemini CLI settings

**File:** `agent-runtime/gemini/settings.json`

> **Schema correction (per `openab-upstream-findings.md` §10).** The previous draft of this step used `tools.core` / `tools.exclude` / `tools.allowed` / `tools.sandbox` JSON keys. Those keys **do not exist** in Gemini CLI v0.41.x — they were copied from an outdated v0.3.x reference and never updated. The actual current schema, taken from `node_modules/@google/gemini-cli/bundle/docs/cli/settings.md` v0.41.2:
>
> - `mcpServers` is the only correct place to declare MCP servers (unchanged).
> - `model.name` replaces the top-level `model` key.
> - Tool gating now lives in **TOML policy files** under `~/.gemini/policies/` — see Step 3b below.
> - Sandbox is configured via `tools.sandboxAllowedPaths` + `tools.sandboxNetworkAccess` + `security.toolSandboxing` (boolean). The `tools.sandbox = "docker"` value never existed.
> - `systemInstructionFile` is not a valid setting — system-prompt override lives at `~/.gemini/system.md` (see Step 4).
>
> Both findings were verified by installing `@google/gemini-cli@0.41.2` and reading its bundled docs; the offline test logs are summarised in `openab-upstream-findings.md` §10.

**Changes (target file `/home/node/.gemini/settings.json` inside the container):**

```json
{
  "model": {
    "name": "gemini-2.5-flash"
  },
  "general": {
    "defaultApprovalMode": "default"
  },
  "tools": {
    "useRipgrep": true,
    "truncateToolOutputThreshold": 40000,
    "sandboxNetworkAccess": false
  },
  "security": {
    "toolSandboxing": true,
    "disableYoloMode": true,
    "disableAlwaysAllow": true,
    "enablePermanentToolApproval": false
  },
  "output": {
    "format": "text"
  },
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["-y", "@playwright/mcp@latest", "--browser", "chromium", "--headless"],
      "env": {}
    },
    "github": {
      "command": "github-mcp-server",
      "args": ["stdio", "--toolsets=repos,issues,pull_requests"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_PERSONAL_ACCESS_TOKEN}"
      }
    }
  }
}
```

**Rationale:**
- **`model.name = "gemini-2.5-flash"`** — Flash has a higher free-tier RPM and is plenty for chat + tool routing. Flip to `gemini-2.5-pro` for hard reasoning; Flash keeps us inside the free quota during normal use.
- **`general.defaultApprovalMode = "default"`** — required for the Policy Engine to actually evaluate. `"plan"` would force read-only mode (we'd lose Playwright + GitHub writes); `"auto_edit"` auto-approves edit tools (we don't want that).
- **`security.toolSandboxing = true` + `security.disableYoloMode = true` + `security.disableAlwaysAllow = true`** — these are the new sandbox controls. Together they prevent both flag-based (`--yolo`) and runtime ("Allow for all future sessions") escapes from the policy. The OpenAB container is the outer trust boundary; this is the inner one.
- **`tools.sandboxNetworkAccess = false`** — Gemini CLI's per-tool sandbox should not get arbitrary outbound HTTP. MCP servers run as separate processes and have their own network access; this only affects the built-in `run_shell_command`.
- **No `tools.core` / `tools.exclude` / `tools.allowed` keys** — those don't exist. Tool gating is in `policies/feat1.toml` (Step 3b).
- **MCP env passthrough:** `mcpServers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN = "${GITHUB_PERSONAL_ACCESS_TOKEN}"`. The env var name on the right is what OpenAB inherits / `[agent].env` exports; the name on the left is what `github-mcp-server` expects. The agent process itself never sees the token — only the spawned MCP server does.
- **Playwright MCP runs `--headless`** with Chromium only (skip Firefox/WebKit to save RAM and startup time).
- **GitHub MCP toolsets restricted** to `repos,issues,pull_requests`. We deliberately omit `actions`, `code_scanning`, etc. so the agent can't trigger workflows or admin operations.
- **`@playwright/mcp@latest`** — the global install in the Dockerfile pins a specific version (Step 2 of `northflank-container.md`); the `latest` here is just the launcher hint.

> **Defense-in-depth secret placement:** even with sandboxing on, never put `LINE_CHANNEL_ACCESS_TOKEN` in any `mcpServers.*.env` block — it must reach `send-line-image.sh` via the **agent process env** (set in `openab.toml` `[agent].env`), so MCP servers do not see it. Same for `CF_UPLOAD_SECRET` used by `post-screenshot.sh`. OpenAB inherits env from the container process; without an explicit `[agent].env` line, none of these vars reach the agent — keep that boundary tight.

### Step 3b: Author Policy Engine rules

**File:** `agent-runtime/gemini/policies/feat1.toml`

> **New step.** The Gemini CLI Policy Engine (per `bundle/docs/reference/policy-engine.md`) loads every `.toml` file in `~/.gemini/policies/`. Each rule states a `decision` (`allow` / `deny` / `ask_user`) plus a `priority`. **Deny rules also remove the tool from the model's context**, so the agent doesn't even know the tool exists — better security and lower token cost than `ask_user`. Final priority = tier base + `toml_priority/1000`; User tier base is 4, so all our rules end up at `4.xxx` — Admin policies (tier 5) can still override us if the operator ever installs them.

**Changes:**

```toml
# === Shell allowlist — only two scripts may run ===
[[rule]]
toolName      = "run_shell_command"
commandPrefix = "/usr/local/bin/post-screenshot.sh"
decision      = "allow"
priority      = 800

[[rule]]
toolName      = "run_shell_command"
commandPrefix = "/usr/local/bin/send-line-image.sh"
decision      = "allow"
priority      = 800

# Catch-all: every other shell command is rejected (and hidden from the model).
[[rule]]
toolName    = "run_shell_command"
decision    = "deny"
priority    = 100
denyMessage = "Only post-screenshot.sh and send-line-image.sh are permitted; everything else is hidden."

# === Built-in tools the LINE bot does not need ===
[[rule]]
toolName = "web_fetch"
decision = "deny"
priority = 800

[[rule]]
toolName = "web_search"
decision = "deny"
priority = 800

# save_memory writes to ~/.gemini/GEMINI.md — we don't want cross-session memory in v1.
[[rule]]
toolName = "save_memory"
decision = "deny"
priority = 800

# === MCP allowlist ===
[[rule]]
mcpName  = "playwright"
decision = "allow"
priority = 700

[[rule]]
mcpName  = "github"
decision = "allow"
priority = 700

# Any other MCP server (now or future) is denied by default.
[[rule]]
mcpName  = "*"
decision = "deny"
priority = 100
denyMessage = "Only playwright and github MCP servers are whitelisted."
```

**Rationale:**
- **`commandPrefix` matches from the start of the `command` argument.** A request like `run_shell_command(command="/usr/local/bin/post-screenshot.sh /tmp/x.png")` matches the allow rule above; `run_shell_command(command="cat /etc/passwd")` falls through to the catch-all deny.
- **Built-in tools explicit deny vs. silent absence.** Even though the policy could let the default `ask_user` apply, explicit `deny` rules (a) document our intent in code, (b) remove the tools from context (smaller prompts, no temptation), (c) survive a future upstream change to defaults.
- **MCP wildcard catch-all.** A future doc edit that adds a new `mcpServers` entry without a corresponding allow rule will be silently denied — fail-closed, exactly what we want.
- **Path: `User` tier.** We deliberately install at `~/.gemini/policies/` rather than the Admin tier (`/etc/gemini-cli/policies/`) because the Admin tier requires `chmod 755` + UID 0 ownership checks that complicate the container build. The Admin tier is the correct location if we ever want operator-enforced policy that an end user can't override; for v1, User tier is fine because there's only one "user" (the container).

### Step 4: System prompt override

**File:** `agent-runtime/gemini/system.md` (renamed from `system-prompt.md`)

> **File-name + delivery mechanism correction (per `openab-upstream-findings.md` §10.4).** The previous draft pointed `settings.json` at `systemInstructionFile = "/etc/openab/system-prompt.md"`. That key doesn't exist. Gemini CLI's actual system-prompt override is the file `~/.gemini/system.md` — it's a **full replacement** of the built-in coding-assistant prompt (which is what we want for a LINE persona). `GEMINI.md` is the additive variant; we don't use it here because we want to drop the coding-assistant defaults entirely.
>
> **Image-reply mechanism correction (per `openab-upstream-findings.md` §4).** The previous draft told the model to emit `IMG <url>` on its own line and expected the OpenAB LINE gateway to parse the prefix and convert the message to a LINE `image`. **That parser does not exist in the upstream gateway.** OpenAB only relays text; for images, the agent has to call the LINE Push API directly. So the new instruction is: read `sender_context.sender_id`, upload the PNG via `post-screenshot.sh`, then call `send-line-image.sh <userId> <url>`.

**Changes:**

```markdown
You are a personal assistant talking to one user over LINE.

# Behavior
- Be concise. LINE replies are read on phones — short paragraphs, no markdown headers.
- Do not narrate your tool use. Just do the work and answer.
- LINE replies are single-shot per turn — the OpenAB LINE gateway delivers exactly
  one text reply when you finish. The gateway automatically uses the free
  replyMessage path while the LINE replyToken is fresh (~50s) and falls back to
  pushMessage afterwards; you do not need to worry about which.
- Do not promise "I'll send an update shortly" or "working on it…"; there is no
  interim-reply tool. Keep slow tasks under ~50s where possible.

# How to read who you're talking to
Every incoming message arrives with a `<sender_context>` JSON block carrying:

    {
      "schema": "openab.sender.v1",
      "sender_id": "<LINE userId, e.g. U1234...>",
      "sender_name": "...",
      "channel": "line",
      "channel_id": "<LINE chatId>",
      ...
    }

Whenever you need to push a LINE image (or any out-of-band content), use
`sender_id` as the target. Never invent or echo userIds from prior turns.

# Tools
- For browser tasks (screenshot, fetch a page, click something): use the `playwright` MCP tools.
- For GitHub tasks (read repo, summarize PR, comment on PR): use the `github` MCP tools.
- To send a LINE image back to the user, do this two-step exactly:
    1. /usr/local/bin/post-screenshot.sh <local-png-path>
       This prints a public HTTPS URL like https://<worker>.workers.dev/img/<uuid>.png.
    2. /usr/local/bin/send-line-image.sh <sender_id> <url-from-step-1>
       This POSTs a LINE Push API image message to that user.
  After both steps succeed, your text reply should be a short confirmation
  (e.g. "Screenshot above ⤴"). Do not paste the URL or the userId into the
  text reply — only the image goes via the Push API; the text goes via the
  normal OpenAB reply channel.

# Limits
- You CANNOT push to default branches (main/master). Do not even attempt; the
  GitHub PAT lacks permission and you will only frustrate the user.
- You CANNOT install software, modify the host filesystem, or execute shell
  outside `/usr/local/bin/post-screenshot.sh` and `/usr/local/bin/send-line-image.sh`.
- When in doubt, ask the user a clarifying question rather than guessing.
```

**Rationale:**
- A LINE-shaped persona produces much better UX than the default Gemini CLI coding-assistant prompt.
- Spelling out the two-step image-send pattern is far more reliable than hoping the model figures out it needs to call two shell scripts.
- The `IMG <url>` convention was removed because OpenAB upstream does not parse it — it would simply appear as literal text in the LINE reply. The new pattern uses LINE's actual Push API and matches OpenAB's documented "agent calls platform API directly" model (per `bundle/docs/sendimages.md` upstream).
- Stating limits up-front saves a round-trip where the agent tries something, gets a 403 or a Policy-Engine deny, and has to apologize.
- The interim-message instruction was previously written as "use the `line.sendInterim` tool" — that tool does **not** exist in the LINE Messaging API and is not exposed as an MCP tool. Removed.

### Step 5: Screenshot upload helper

**File:** `agent-runtime/scripts/post-screenshot.sh`

**Changes:**

```sh
#!/bin/sh
# Usage: post-screenshot.sh <local-path>
# Uploads to the Cloudflare Worker /img endpoint and prints the public URL on stdout.
set -eu
src="${1:?usage: post-screenshot.sh <path>}"
ext="${src##*.}"
case "$ext" in png|jpg|jpeg) ;; *) echo "unsupported ext: $ext" >&2; exit 2;; esac
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
```

**Rationale:**
- Tiny, predictable shell script. The Gemini agent's job is "call this with a path, then feed the printed URL into `send-line-image.sh`."
- Uses kernel UUID for uniqueness, no Node/Python dep, no external libs.

### Step 5b: LINE Push API image helper

**File:** `agent-runtime/scripts/send-line-image.sh`

> **New helper (per `openab-upstream-findings.md` §4).** OpenAB's LINE gateway only relays text. To deliver an image, the agent has to call LINE's Push API directly using the userId from `sender_context`. The agent has the `LINE_CHANNEL_ACCESS_TOKEN` in its process env (configured in `openab.toml` `[agent].env`); the script reads it from there. This is the same security tradeoff that upstream `bundle/docs/sendimages.md` documents: passing the platform token through `[agent].env` exposes it to the agent's process tree, which is acceptable when the container is the trust boundary and the token is scoped to a single LINE channel.

**Changes:**

```sh
#!/bin/sh
# Usage: send-line-image.sh <line-userId> <https-image-url>
# POSTs a LINE Messaging API image message via Push API.
# Requires LINE_CHANNEL_ACCESS_TOKEN in env.
set -eu
user="${1:?usage: send-line-image.sh <userId> <imageUrl>}"
url="${2:?usage: send-line-image.sh <userId> <imageUrl>}"

: "${LINE_CHANNEL_ACCESS_TOKEN:?LINE_CHANNEL_ACCESS_TOKEN not set}"
case "$url" in
  https://*) ;;
  *) echo "imageUrl must be https://: $url" >&2; exit 2;;
esac

# X-Line-Retry-Key dedupes server-side retries (RFC 4122 UUID).
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
```

**Rationale:**
- **`X-Line-Retry-Key`** is LINE's own dedup header (per LINE Messaging API docs). Even if the agent runs this script twice for the same screenshot, LINE will only deliver the image once.
- **`originalContentUrl == previewImageUrl`** is acceptable per LINE's docs; building a proper preview thumbnail is v2.
- **Strict `https://` check** stops the agent from passing a local file path or `http://` URL (LINE rejects those, and validating up-front gives a clearer error).
- **Exit status is meaningful.** The Policy Engine allows this script unconditionally, but a non-200 from LINE bubbles back as a tool error so the agent can apologize in the text reply.

### Step 6: Wire env vars into the spawned Gemini process

The Northflank service env (Step 7 of `northflank-container.md`) exposes the following at the container level. From there, OpenAB's `[agent].env` in `openab.toml` decides what reaches the Gemini process (OpenAB calls `env_clear()` first, so anything not listed in `[agent].env` is invisible to the agent).

| Container env | Reaches agent? | Reaches MCP servers? | Used by |
|---|---|---|---|
| `GEMINI_API_KEY` | ✅ via `[agent].env` | ❌ | Gemini CLI itself (Google AI Studio auth) |
| `GITHUB_PERSONAL_ACCESS_TOKEN` | ✅ via `[agent].env` | ✅ via `mcpServers.github.env` | The github-mcp-server subprocess only — Gemini never reads it |
| `LINE_CHANNEL_ACCESS_TOKEN` | ✅ via `[agent].env` | ❌ | `send-line-image.sh` script only |
| `CF_UPLOAD_SECRET` | ✅ via `[agent].env` | ❌ | `post-screenshot.sh` script only |
| `CF_IMG_BASE_URL` | ✅ via `[agent].env` | ❌ | `post-screenshot.sh` script only |
| `OPENAB_*` / `NORTHFLANK_*` / `DASHBOARD_*` / `LINE_CHANNEL_SECRET` | ❌ | ❌ | Outer container processes only — never visible to the agent |

**Rationale:** keep env-var name conventions explicit at the boundary; never let the user wonder which name to set, and never let a non-essential secret reach the agent's process tree. OpenAB's `env_clear()` is the enforcement; this table is the spec.

### Step 7: Constrain Gemini's RPM at the application layer

The free Google AI Studio tier on `gemini-2.5-flash` allows ~15 RPM. With ≤5 invited users we should never hit it during normal use — but a polite "I'm rate-limited, try again in a minute" is much better than a stack trace. Two options:

- **A.** Catch 429s from Gemini in the OpenAB harness, translate to a friendly LINE message. (Requires OpenAB support — check upstream.)
- **B.** Add a tiny pre-flight rate limiter in the LINE gateway plugin (token bucket per user).

**Decision:** **(A) if OpenAB exposes a hook; otherwise (B) deferred to v1.5.** Don't block v1 release on this; surface 429s as raw error replies for the first week, then iterate.

## Testing Steps

1. **Settings parse:** start Gemini CLI inside the container with the mounted config:
   `docker run --rm openab-line-agent gemini /mcp list` — expect both `playwright` and `github` to appear and connect.
2. **Policy parse:** `docker run --rm openab-line-agent gemini -p "say hi" --output-format json` — expect a clean run. Then `docker run --rm openab-line-agent gemini -p "run cat /etc/passwd" --output-format json` — expect the Policy Engine to deny (the model will refuse or the tool call will fail with `denyMessage`).
3. **Playwright MCP smoke:** in an ACP session, prompt "screenshot example.com to /tmp/x.png" → expect `/tmp/x.png` to exist.
4. **GitHub MCP smoke:** prompt "list the 3 most recent open PRs in <test-repo>" → expect a structured response.
5. **GitHub blast-radius test:** prompt "push a commit to main of <test-repo>" → expect Gemini to refuse (system prompt) AND if it tries, GitHub returns 403 (PAT scope).
6. **post-screenshot.sh smoke:** `bash post-screenshot.sh /tmp/x.png` → URL printed → `curl <URL>` → bytes back.
7. **send-line-image.sh smoke:** with a real LINE userId on the allowlist and a valid image URL, `bash send-line-image.sh U... https://...` → image arrives in LINE within ~2s.
8. **End-to-end via LINE:** "screenshot https://example.com" from LINE → expect an image LINE message within ~15s **AND** a brief text confirmation right after.
9. **Telemetry outfile sanity:** with `GEMINI_TELEMETRY_OUTFILE=/tmp/gem.jsonl GEMINI_TELEMETRY_ENABLED=true GEMINI_TELEMETRY_TARGET=local`, run any ACP session and `wc -l /tmp/gem.jsonl` after — should be non-zero, JSON lines including tool-call entries. This validates the structured event source the dashboard depends on.

## Dependencies

- Must complete before: `openab-config.md` (`[agent].env` references the var names defined here); `northflank-container.md` (the Dockerfile COPYs these files into `/home/node/.gemini/` and installs the MCP binaries).
- Depends on: `cloudflare-webhook.md` (post-screenshot.sh targets the Worker's `/img` route).

## Notes

- **Why not give Gemini direct LINE API access for the text reply too?** OpenAB's gateway already does the hybrid replyToken/pushMessage thing for text. We only call LINE Push API directly for images because OpenAB explicitly does not relay them (see `bundle/docs/sendimages.md` upstream).
- **Why `--toolsets=repos,issues,pull_requests`?** GitHub MCP server has many toolsets; restricting reduces both the prompt-context cost and the blast radius if the model misunderstands intent.
- **PAT scope precision:** the fine-grained PAT must be configured in GitHub UI as:
  - Read access to **all** repos: `metadata`, `contents`, `pull_requests`, `issues` (read).
  - Write access on a curated list: `pull_requests` (write).
  - **No** `actions`, `administration`, `secrets`, `workflows`.
- **Two layers of tool gating.** The Policy Engine is the *inner* layer (the model can't even see denied tools). The OpenAB container + `env_clear()` is the *outer* layer (even a hypothetical Policy bypass can't reach secrets we haven't exported). Both layers need to break for an exfiltration.
- **Future:** add a Confluence MCP, Slack MCP, and a "personal-notes" file MCP in v2. The pattern is identical: bake the binary into the image, add an entry under `mcpServers`, add an `mcpName = "X" allow` rule to `policies/feat1.toml`.
