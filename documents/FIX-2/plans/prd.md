# PRD: Gemini CLI Tool Routing — Model Ignores Playwright MCP

## Problem Statement

The LINE agent (Gemini CLI running inside the HF Spaces container) has Playwright
MCP tools configured and allowed, yet the model consistently ignores them.  When a
user asks for a screenshot or any browser task, the model reaches for built-in tools
(`web_fetch`, `google_web_search`, `run_shell_command`, `list_directory`) instead of
the Playwright MCP tools (`browser_navigate`, `browser_take_screenshot`, etc.).

This results in degraded user experience: the agent appears "incapable" of browser
tasks despite having the correct tooling installed.

## Root Cause Analysis

Three independent issues combine to produce the observed behaviour:

### 1. Policy Engine `deny` is ineffective in ACP mode

Gemini CLI's Policy Engine (`~/.gemini/policies/tool-allowlist.toml`) sets `deny`
rules for unwanted built-in tools.  However, in `--acp` mode (spawned by OpenAB),
deny decisions are **not hard blocks**.  Instead they are forwarded as ACP permission
prompts to the host (OpenAB), which **auto-approves every request** with
`proceed_once`:

```
auto-respond permission title="pip list"
  outcome={"outcome":{"optionId":"proceed_once","outcome":"selected"}}
```

Evidence from HF container logs confirms that `run_shell_command` (for `pip list`,
`ls -la`, `command -v …`), `web_fetch`, and `google_web_search` all execute
successfully despite policy deny rules.

### 2. Tool name mismatch in policy

The policy file denies `web_search`:

```toml
[[rule]]
toolName = "web_search"
decision = "deny"
priority = 800
```

But the actual Gemini CLI built-in tool is named `google_web_search`.  The rule
never matches, so the tool is never even "denied" (not that deny would help — see
issue 1).

### 3. Model prefers familiar built-in tools over MCP tools

The Gemini Flash model sees **all** tool schemas (built-in + MCP) in its context.
With 30+ tools available, it defaults to the familiar built-in tools it was trained
on (`web_fetch`, `run_shell_command`) rather than MCP tools it has less exposure to
(`browser_navigate`, `browser_take_screenshot`).

The current system prompt (`system.md`) contains only a single vague line:

```
- For browser tasks (screenshot, fetch a page, click something): use the `playwright` MCP tools.
```

This is insufficient to override the model's built-in preference.

### Contributing factor: `GEMINI_CLI_TRUST_WORKSPACE=true`

The `openab.toml` agent env sets `GEMINI_CLI_TRUST_WORKSPACE=true`.  This may relax
policy enforcement further.  Removing it could tighten security but may break Gemini
CLI's workspace file access (e.g., reading `system.md`).  Noted for investigation
but kept as-is for FIX-2 to limit blast radius.

### Contributing factor: `sandboxNetworkAccess: true`

The current `settings.json` has `sandboxNetworkAccess: true`, diverging from the
FEAT-1 baseline (`false`).  This allows `run_shell_command` sandbox to make outbound
HTTP calls.  Combined with the policy bypass, this increases the attack surface.
Kept as-is for FIX-2 but flagged for future tightening.

## Solution Overview

**FIX-2 is a partial, best-effort fix.**  The permanent solution is the FEAT-4
Mastra rewrite, which will strip unwanted tool schemas from the model context
entirely.  FIX-2 works within the constraints of the current OpenAB + Gemini CLI
stack:

1. **Strengthen the system prompt** — explicitly enumerate the Playwright tool names,
   provide a concrete screenshot workflow, and explicitly prohibit the built-in
   alternatives using numbered rules with consequence statements.
2. **Fix the policy file** — correct tool name mismatches and add missing deny rules
   so the policy is at least *correct* (even if not fully effective in ACP mode today).
   This positions us for future Gemini CLI versions that may respect deny in ACP mode.

## User Stories

1. As a LINE user, I want the agent to take a webpage screenshot when I ask, so that
   I receive an actual image instead of a text-based workaround.
2. As a LINE user, I want the agent to navigate and interact with web pages using
   Playwright, so that it can perform browser-based tasks reliably.
3. As an operator, I want the policy file to use correct tool names, so that if a
   future Gemini CLI version hard-blocks denied tools in ACP mode, the rules take
   effect immediately.

## Implementation Decisions

### Modules

- **`gemini/system.md`** (system prompt): Add explicit Playwright tool list,
  concrete workflow examples, and a "prohibited tools" section.
- **`gemini/policies/tool-allowlist.toml`** (policy engine): Fix `web_search` →
  `google_web_search`, add `list_directory` deny, add `read_file` / `edit_file`
  deny rules for any other built-in filesystem tools the model might reach for.

### Architecture

No architectural changes.  This fix is entirely in configuration files (system
prompt + policy TOML).  The permanent solution is the FEAT-4 Mastra rewrite, which
will give us programmatic control over which tool schemas are sent to the model
(stripping unwanted tools from context entirely, not just denying them at execution
time).

### Files Changed

| File | Change |
|------|--------|
| `agent-runtime/gemini/system.md` | Rewrite `# Tools` section |
| `agent-runtime/gemini/policies/tool-allowlist.toml` | Fix tool names + add deny rules |

## Testing Strategy

### Positive tests

1. **Deploy to HF Spaces** and send a LINE message: "Please screenshot google.com
   for me."
2. **Verify in Langfuse** that the trace shows `browser_navigate` +
   `browser_take_screenshot` tool calls (not `web_fetch` or `run_shell_command`).
3. **Verify the LINE reply** contains an actual screenshot image delivered via
   `deliver-line-image.sh`.

### Negative tests

4. Send: "Run `ls -la` for me." — agent should decline.
5. Send: "Search the web for latest news." — agent should use `browser_navigate` to
   a search engine, not `google_web_search`.
6. Send: "Use web_fetch to get https://example.com" — agent should refuse and
   suggest Playwright instead.
7. Send: "Read the file /etc/passwd" — agent should refuse.

### Langfuse verification

Filter traces by tool name.  Expected: `browser_navigate`, `browser_take_screenshot`
present.  Unexpected: `web_fetch`, `google_web_search`, `list_directory` absent.

### Rollback plan

If Playwright tools stop working after deployment:
1. `git revert` the FIX-2 commit on `main`.
2. HF Spaces auto-redeploys via `.github/workflows/hf-sync.yml`.
3. Estimated rollback time: ~5 minutes.

## Out of Scope

- **Fixing OpenAB's auto-approve behaviour**: This is an upstream limitation.
  OpenAB auto-responds `proceed_once` to all ACP permission prompts.  A proper fix
  would require OpenAB to respect Gemini CLI policy decisions, which is outside our
  control.
- **Stripping tool schemas from model context**: The Policy Engine `deny` hides
  the tool from the model in interactive mode but not in ACP mode.  Programmatic
  schema stripping requires the FEAT-4 Mastra rewrite.
- **Quota exhaustion errors**: The `gemini-3-flash-preview` daily quota limit is a
  Google-side constraint unrelated to tool routing.

## Status

- [x] Planning
- [ ] In Development
- [ ] Complete
