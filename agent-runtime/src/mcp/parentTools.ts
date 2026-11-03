import { join } from 'node:path';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import { runSubagent } from './subagentRunner.js';
import { playwrightMcp, githubMcp } from './mcpClients.js';

// Playwright MCP only allows writes under its cwd and <cwd>/.playwright-mcp. In the
// container the cwd is WORKDIR /home/node, so this is /home/node/.playwright-mcp;
// locally (scripts/smoke-turn.ts) it's agent-runtime/.playwright-mcp.
const MCP_ROOT = process.cwd();
const SCREENSHOT_DIR = join(MCP_ROOT, '.playwright-mcp');

// Overridable so scripts/smoke-turn.ts can stub delivery outside the container.
const deliverBin = process.env.DELIVER_LINE_IMAGE_BIN ?? '/usr/local/bin/deliver-line-image.sh';

export const taskBrowserTool = createTool({
  id: 'task_browser',
  description:
    'Use the headless browser to fetch, screenshot, click, or extract content from a webpage. ' +
    'Pass a one-paragraph English task description; the subagent decides which browser actions to run.',
  inputSchema: z.object({
    task: z
      .string()
      .describe(
        'What to do in the browser, e.g. "Screenshot the Google homepage and return the PNG path"',
      ),
  }),
  execute: async ({ context, runtimeContext }) => {
    const userId = String(runtimeContext?.get('userId') ?? '');
    const sessionId = String(runtimeContext?.get('sessionId') ?? '');
    return runSubagent({
      userId,
      sessionId,
      parentTraceId: '',
      taskName: 'browser',
      mcpClient: playwrightMcp,
      prompt: context.task,
      systemHint:
        'You are a headless-browser specialist. Use Playwright MCP tools to fulfil the task. ' +
        `When saving screenshots or other files, write to ${SCREENSHOT_DIR}/<name>.png. ` +
        `Playwright MCP only allows writes under ${MCP_ROOT} and ${SCREENSHOT_DIR} — ` +
        '/tmp and other paths will be rejected with "File access denied".',
    });
  },
});

export const taskGithubTool = createTool({
  id: 'task_github',
  description:
    'Read a GitHub repo, summarise a PR, or comment on an issue. Pass a one-paragraph English task description.',
  inputSchema: z.object({ task: z.string() }),
  execute: async ({ context, runtimeContext }) => {
    const userId = String(runtimeContext?.get('userId') ?? '');
    const sessionId = String(runtimeContext?.get('sessionId') ?? '');
    return runSubagent({
      userId,
      sessionId,
      parentTraceId: '',
      taskName: 'github',
      mcpClient: githubMcp,
      prompt: context.task,
      systemHint: 'You are a GitHub specialist. Use GitHub MCP tools to fulfil the task.',
    });
  },
});

export const sendImageTool = createTool({
  id: 'send_image',
  description:
    'Send an image to the user. Provide a local PNG path; the harness uploads it and pushes a LINE image message.',
  inputSchema: z.object({ pngPath: z.string() }),
  execute: async ({ context, runtimeContext }) => {
    const userId = String(runtimeContext?.get('userId') ?? '');
    const { execFile } = await import('node:child_process');
    const out = await new Promise<string>((resolve, reject) =>
      execFile(deliverBin, [userId, context.pngPath], (err, stdout) =>
        err ? reject(err) : resolve(stdout),
      ),
    );
    try {
      return JSON.parse(out);
    } catch {
      return { ok: true, output: out };
    }
  },
});
