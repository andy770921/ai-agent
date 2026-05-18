// Runs after `npm install` in this workspace.
// Skippable via PLAYWRIGHT_SKIP_BROWSER_INSTALL=1 (CI, Dockerfile build).
const { execSync } = require('node:child_process');

function run(cmd, label) {
  console.log(`[install-mcp-deps] ${label}`);
  try {
    execSync(cmd, { stdio: 'inherit' });
  } catch {
    console.warn(
      `[install-mcp-deps] ${label} FAILED — continuing. ` +
        `task_browser will return graceful error until fixed.`,
    );
  }
}

if (process.env.PLAYWRIGHT_SKIP_BROWSER_INSTALL) {
  console.log(
    '[install-mcp-deps] PLAYWRIGHT_SKIP_BROWSER_INSTALL set — skipping',
  );
  process.exit(0);
}

run(
  'npx playwright install chromium',
  'installing Chromium for Playwright MCP',
);
