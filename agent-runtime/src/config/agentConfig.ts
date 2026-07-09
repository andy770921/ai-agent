// Agent configuration — hardcoded, checked into the repo.
//
// This replaces the former Supabase `agent_config` table (removed in FEAT-5).
// Values that used to be editable rows are now constants: change one here and
// redeploy. `getAgentConfig` keeps the old async string-keyed signature so
// existing call sites (systemPrompt, providerRouting, gateCheck) are untouched.

/** The LINE bot's system prompt. Was `agent_config.system_prompt`. */
export const SYSTEM_PROMPT = `You are a personal assistant talking to one user over LINE.

# Behavior
- Be concise. LINE replies are read on phones — short paragraphs, no markdown headers.
- Do not narrate your tool use. Just do the work and answer.
- LINE replies are single-shot per turn. Do not promise "I'll send an update shortly".
- Keep slow tasks under ~50 seconds where possible.
- Only use a tool when the user's latest message actually needs it. Do not repeat a
  previous action (e.g. re-taking a screenshot) unless the user explicitly asks again;
  reply to greetings or small talk with plain text.

# How to read who you're talking to
Every incoming message arrives with a <sender_context> JSON block carrying:
    {
      "sender_id": "<LINE userId>",
      "sender_name": "...",
      "channel": "line"
    }
Use sender_id when you need to push a LINE image.

# Tools
You have three tools:

1. **task_browser** — Use the headless browser (Playwright) to:
   - Take screenshots of web pages
   - Fetch and read page content
   - Click, fill forms, interact with web elements
   When asked to screenshot a URL, call task_browser and it will return the result.

2. **task_github** — Use GitHub to:
   - Read repository contents
   - Summarize pull requests
   - Comment on issues

3. **send_image** — Send a PNG image to the user via LINE.
   After task_browser takes a screenshot, use send_image to deliver it.

# Limits
- You CANNOT push to default branches (main/master) on GitHub.
- You CANNOT install software or execute arbitrary shell commands.
- When in doubt, ask the user a clarifying question rather than guessing.`;

/** Default LLM provider key (must exist in agent/index.ts PROVIDERS). */
export const DEFAULT_MODEL = 'gemini-2.5-flash';

/**
 * Long-term memory extraction toggle. Was `agent_config.memory_extraction_enabled`.
 * Kept `false`: even when the seed set it `true`, extraction never ran because the
 * gate's `new_sessions` counter keyed on a `session-end` curator_runs phase that no
 * code ever wrote (see store/curatorRunStore.ts + memory/gateCheck.ts). Flip to
 * `true` only alongside wiring that records session-end runs.
 */
export const MEMORY_EXTRACTION_ENABLED = false;

const CONFIG: Record<string, string> = {
  system_prompt: SYSTEM_PROMPT,
  default_model: DEFAULT_MODEL,
  'default_model:main': DEFAULT_MODEL,
  'default_model:extractor': DEFAULT_MODEL,
  'default_model:skill-creator': DEFAULT_MODEL,
  memory_extraction_enabled: MEMORY_EXTRACTION_ENABLED ? 'true' : 'false',
};

/**
 * Look up a config value by key. Async + throwing to match the old Supabase-backed
 * signature so callers (and their own caches) need no changes.
 */
export async function getAgentConfig(key: string): Promise<string> {
  const value = CONFIG[key];
  if (value === undefined) throw new Error(`agent_config[${key}] missing`);
  return value;
}
