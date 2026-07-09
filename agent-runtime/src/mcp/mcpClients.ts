import { MastraMCPClient } from '@mastra/mcp';

// MastraMCPClient's `env` replaces the subprocess environment entirely.
// Spread process.env as base so the subprocess inherits PATH, HOME, etc.
//
// In Docker (linux), use `node` + absolute path to cli.js to bypass all
// npx/symlink/global-prefix issues. On macOS, use npx for local dev.
const isDocker = process.platform === 'linux';

export const playwrightMcp = new MastraMCPClient({
  name: 'playwright',
  server: {
    command: isDocker ? 'node' : 'npx',
    args: isDocker
      ? [
          '/usr/local/lib/node_modules/@playwright/mcp/cli.js',
          '--browser',
          'chromium',
          '--headless',
        ]
      : ['@playwright/mcp', '--browser', 'chromium', '--headless'],
    env: {
      ...process.env,
    } as Record<string, string>,
  },
});

const githubBin =
  process.env.GITHUB_MCP_BIN ??
  (process.platform === 'linux' ? '/usr/local/bin/github-mcp-server' : 'github-mcp-server');

export const githubMcp = new MastraMCPClient({
  name: 'github',
  server: {
    command: githubBin,
    args: ['stdio', '--toolsets=repos,issues,pull_requests'],
    env: {
      ...process.env,
      GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN ?? '',
    } as Record<string, string>,
  },
});
