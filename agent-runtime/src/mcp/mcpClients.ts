import { MastraMCPClient } from '@mastra/mcp';

// MastraMCPClient's `env` replaces the subprocess environment entirely.
// Spread process.env as base so the subprocess inherits PATH, HOME, etc.
export const playwrightMcp = new MastraMCPClient({
  name: 'playwright',
  server: {
    command: 'npx',
    args: ['@playwright/mcp', '--browser', 'chromium', '--headless'],
    env: {
      ...process.env,
    } as Record<string, string>,
  },
});

const githubBin =
  process.env.GITHUB_MCP_BIN ??
  (process.platform === 'linux'
    ? '/usr/local/bin/github-mcp-server'
    : 'github-mcp-server');

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
