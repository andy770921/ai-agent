import { MastraMCPClient } from '@mastra/mcp';

export const playwrightMcp = new MastraMCPClient({
  name: 'playwright',
  server: {
    command: 'npx',
    args: ['@playwright/mcp', '--browser', 'chromium', '--headless'],
    env: {
      ...(process.env.PLAYWRIGHT_BROWSERS_PATH
        ? {
            PLAYWRIGHT_BROWSERS_PATH:
              process.env.PLAYWRIGHT_BROWSERS_PATH,
          }
        : {}),
    },
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
      GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN ?? '',
    },
  },
});
