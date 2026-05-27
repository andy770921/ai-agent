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

// Local dev only. Production browsers are installed in the Dockerfile via
// @playwright/mcp's bundled playwright-core to avoid version skew (see
// documents/FIX-2/development/gemini-tool-routing-fix.md issue 15).
// Locally we still use the registry-resolved playwright-core because
// @playwright/mcp is downloaded on-demand by npx and isn't pinned here;
// a dev who hits version skew can re-run with PLAYWRIGHT_SKIP_BROWSER_INSTALL=1
// then run `npx -p @playwright/mcp@<docker-version> playwright-core install --no-shell chromium`.
run(
  'npx --yes playwright-core install --no-shell chromium',
  'installing Chromium for Playwright MCP (local dev)',
);
