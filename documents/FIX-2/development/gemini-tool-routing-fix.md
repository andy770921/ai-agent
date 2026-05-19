# Implementation Plan: Gemini Tool Routing Fix

## Overview

Fix the Gemini CLI agent's tool routing so it uses Playwright MCP tools for browser
tasks instead of defaulting to built-in tools (`web_fetch`, `google_web_search`,
`run_shell_command`).  Two configuration files are modified; no code changes.

## Files to Modify

### System Prompt

- `agent-runtime/gemini/system.md`
  - Rewrite `# Tools` section with explicit Playwright tool names
  - Add concrete screenshot workflow
  - Add explicit "Prohibited tools" section
  - Purpose: Override model's default preference for built-in tools

### Policy Engine

- `agent-runtime/gemini/policies/tool-allowlist.toml`
  - Fix `web_search` → `google_web_search` (name mismatch)
  - Add `list_directory` deny rule
  - Purpose: Correct the policy for future Gemini CLI versions that may enforce
    deny in ACP mode

## Step-by-Step Implementation

### Step 1: Rewrite `# Tools` section in system.md

**File:** `agent-runtime/gemini/system.md`

**Current content (lines 28-38):**

```markdown
# Tools
- For browser tasks (screenshot, fetch a page, click something): use the `playwright` MCP tools.
- For GitHub tasks (read repo, summarize PR, comment on PR): use the `github` MCP tools.
- To send a LINE image back to the user, run exactly:
    /usr/local/bin/deliver-line-image.sh <sender_id> <local-png-path>
  This uploads the image and pushes it to the user in one step; on success
  it prints a JSON line like `{"ok":true,"imageUrl":"…"}`. After it
  succeeds, your text reply should be a short confirmation (e.g.
  "Screenshot above ⤴"). Do not paste the URL or the userId into the
  text reply — only the image goes via the Push API; the text goes via the
  normal OpenAB reply channel.
```

**New content:**

```markdown
# Tools

## Browser (Playwright MCP) — ALWAYS use for web tasks
For ANY task involving web pages, screenshots, URL fetching, or browsing, you MUST
use these Playwright MCP tools.  NEVER fall back to built-in tools.

Key tools:
- `browser_navigate` — open a URL in headless Chromium
- `browser_take_screenshot` — capture the visible page as a PNG file
- `browser_snapshot` — get the page accessibility tree (structured text)
- `browser_click` / `browser_fill_form` / `browser_type` — interact with elements
- `browser_evaluate` — execute JavaScript in the page context

### Screenshot workflow
1. Call `browser_navigate` with the target URL.
2. Call `browser_take_screenshot` to capture the page.
3. Run `/usr/local/bin/deliver-line-image.sh <sender_id> <screenshot-path>` to push
   the image to the user.
4. Reply with a short confirmation (e.g. "Screenshot above ⤴").

### Fetching page content
Use `browser_navigate` then `browser_snapshot` to read page content.  Do NOT use
`web_fetch`.

## GitHub (MCP)
- For GitHub tasks (read repo, summarize PR, comment on PR): use the `github` MCP
  tools.

## LINE image delivery
To send a LINE image back to the user, run exactly:

    /usr/local/bin/deliver-line-image.sh <sender_id> <local-png-path>

This uploads the image and pushes it to the user in one step; on success it prints
`{"ok":true,"imageUrl":"…"}`.  After it succeeds, your text reply should be a short
confirmation.  Do not paste the URL or userId into the text reply.

## Prohibited tools — NEVER use these

If you call any prohibited tool, the system will reject it with an error.
Do not attempt workarounds.  Use the recommended alternative or tell the user
the action is not supported.

1. **web_fetch** — blocked.  ALWAYS use `browser_navigate` + `browser_snapshot`
   instead.
2. **google_web_search** — blocked.  Use `browser_navigate` to a search engine
   if needed.
3. **run_shell_command** — DANGEROUS.  The ONLY permitted command is:
   `/usr/local/bin/deliver-line-image.sh <sender_id> <path>`.
   Every other shell command is forbidden.
4. **list_directory** — no filesystem browsing allowed.
5. **save_memory** — not useful in this session-scoped agent.
```

**Rationale:** The model needs explicit tool names, a concrete workflow, and hard
prohibitions to override its default preference for built-in tools.  A vague
"use playwright MCP tools" is insufficient.

### Step 2: Fix tool name and add deny rules in policy

**File:** `agent-runtime/gemini/policies/tool-allowlist.toml`

**Changes:**

1. Rename `web_search` → `google_web_search` (lines 27-29)
2. Add `list_directory` deny rule

**Current (lines 27-29):**

```toml
[[rule]]
toolName = "web_search"
decision = "deny"
priority = 800
```

**New:**

```toml
[[rule]]
toolName = "google_web_search"
decision = "deny"
priority = 800
```

**Add after `save_memory` deny (after line 34):**

```toml
[[rule]]
toolName = "list_directory"
decision = "deny"
priority = 800
```

**Rationale:** The policy should use the correct Gemini CLI tool names.  Even though
deny is ineffective in ACP mode today, having correct rules means they'll work if a
future Gemini CLI version respects deny in ACP mode.

### Step 3: Update `# Limits` section in system.md

**File:** `agent-runtime/gemini/system.md`

**Current (lines 40-45):**

```markdown
# Limits
- You CANNOT push to default branches (main/master). Do not even attempt; the
  GitHub PAT lacks permission and you will only frustrate the user.
- You CANNOT install software, modify the host filesystem, or execute shell
  outside `/usr/local/bin/deliver-line-image.sh`.
- When in doubt, ask the user a clarifying question rather than guessing.
```

**New:**

```markdown
# Limits
- You CANNOT push to default branches (main/master). Do not even attempt; the
  GitHub PAT lacks permission and you will only frustrate the user.
- You CANNOT install software, modify the host filesystem, or execute shell
  commands.  The ONLY shell command you may run is
  `/usr/local/bin/deliver-line-image.sh`.
- Do NOT call `web_fetch`, `google_web_search`, `list_directory`, or
  `save_memory`.  They are blocked.  Use Playwright MCP tools instead.
- When in doubt, ask the user a clarifying question rather than guessing.
```

**Rationale:** Reinforce the prohibition in `# Limits` so the model encounters the
constraint in two separate sections, increasing compliance.

## Testing Steps

### Positive tests

1. Deploy updated container to HF Spaces (push to main triggers
   `.github/workflows/hf-sync.yml`).
2. Send LINE message: "Please screenshot google.com for me."
3. Check Langfuse trace — expect `browser_navigate` + `browser_take_screenshot`
   tool calls.
4. Verify LINE reply contains an image (not a text workaround).

### Negative tests

5. Send: "Run `ls -la` for me." — agent should decline.
6. Send: "Search the web for latest news." — agent should use
   `browser_navigate` to a search engine, not `google_web_search`.
7. Send: "Use web_fetch to get https://example.com" — agent should refuse.
8. Send: "Read the file /etc/passwd" — agent should refuse.

### Deployment verification

After HF Spaces rebuilds, verify the files are in place by checking HF container
logs for:
- `render-mcp-config: merged MCP servers` (confirms MCP config loaded)
- `mcp_servers_count` in the `gemini_cli.config` telemetry event (confirms
  Playwright + GitHub MCP servers registered)

## Dependencies

- None.  This is a standalone configuration fix.
- Superseded by: FEAT-4 (Mastra rewrite) which will strip tool schemas from context
  entirely.

## Rollback Plan

If Playwright tools stop working after deployment:
1. `git revert` the FIX-2 commit on `main`.
2. HF Spaces auto-redeploys via `.github/workflows/hf-sync.yml`.
3. Estimated rollback time: ~5 minutes.

## Notes

- **FIX-2 is a partial, best-effort fix.**  The permanent solution is FEAT-4
  (Mastra rewrite) which will strip tool schemas from the model context entirely.
- The `GEMINI_CLI_TRUST_WORKSPACE=true` env var in `openab.toml` may also
  contribute to policy bypass.  Removing it could tighten security but may break
  Gemini CLI's workspace file access.  Noted for future investigation but out of
  scope for FIX-2.
- The policy engine's deny-in-ACP-mode behaviour may change in future Gemini CLI
  releases.  Monitor upstream changelogs.
- `read_file` and `edit_file` built-in tools are not observed in current traces.
  If they appear in future Langfuse traces, add deny rules for them too.
- `sandboxNetworkAccess: true` in `settings.json` diverges from the FEAT-1
  baseline (`false`).  Flagged for future tightening but kept as-is for FIX-2.
- Playwright tool names (`browser_navigate`, `browser_take_screenshot`, etc.) are
  based on @playwright/mcp@0.0.30 (pinned in Dockerfile).  Verify if upgrading.
