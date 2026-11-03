// Local smoke test: run real turns through runTurn() against the configured
// DEFAULT_MODEL on OpenRouter and the real Playwright MCP — everything except LINE.
//
//   cd agent-runtime && npm run smoke
//
// Needs OPEN_ROUTER_API_KEY in agent-runtime/.env (loaded via --env-file).
// The real deliver-line-image.sh only runs in the container (it reads
// /proc/sys/kernel/random/uuid), so send_image is pointed at a stub that checks
// the screenshot exists and is a PNG instead of pushing it to LINE.
// See documents/FEAT-6/development/free-tier.md.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CASE_TIMEOUT_MS = 180_000;

const CASES = [
  { name: 'greeting', message: 'Hi', expectImage: false },
  {
    name: 'screenshot',
    message: 'Please help me screenshot the Google home page image for me',
    expectImage: true,
  },
];

// Must be set before parentTools.ts is imported (it reads the env at load time).
const sentLog = join(tmpdir(), `smoke-send-image-${process.pid}.log`);
const stub = join(tmpdir(), `smoke-deliver-${process.pid}.sh`);
writeFileSync(
  stub,
  `#!/bin/sh
[ -f "$2" ] || { echo "no such file: $2" >&2; exit 1; }
echo "$2" >> "${sentLog}"
printf '{"ok":true,"stub":true,"path":"%s"}\\n' "$2"
`,
);
chmodSync(stub, 0o755);
process.env.DELIVER_LINE_IMAGE_BIN = stub;

const { runTurn } = await import('../src/agent/runTurn.js');
const { DEFAULT_MODEL } = await import('../src/config/agentConfig.js');
const { agentEventBus } = await import('../src/observability/bus.js');
const { flushLangfuse } = await import('../src/observability/langfuse.js');

const toolEvents: string[] = [];
agentEventBus.on((ev) => {
  if (ev.type === 'tool_call') toolEvents.push(`${ev.toolName} call`);
  if (ev.type === 'tool_result')
    toolEvents.push(`${ev.toolName} ${ev.ok ? 'ok' : `failed: ${ev.error}`}`);
});

function sentImages(): string[] {
  return existsSync(sentLog) ? readFileSync(sentLog, 'utf8').split('\n').filter(Boolean) : [];
}

function isPng(path: string): boolean {
  const magic = readFileSync(path).subarray(0, 8);
  return magic.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

console.log(`[smoke] model: ${DEFAULT_MODEL}`);
let failures = 0;

for (const c of CASES) {
  console.log(`\n[smoke] ===== ${c.name}: ${JSON.stringify(c.message)}`);
  toolEvents.length = 0;
  const before = sentImages().length;
  const problems: string[] = [];
  const started = Date.now();

  try {
    const result = await Promise.race([
      runTurn({ userId: 'smoke-test', userMessage: c.message, sessionId: `smoke-${c.name}` }),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`timed out after ${CASE_TIMEOUT_MS} ms`)),
          CASE_TIMEOUT_MS,
        ),
      ),
    ]);
    const images = sentImages().slice(before);
    console.log(`[smoke] reply (${Date.now() - started} ms): ${JSON.stringify(result.reply)}`);
    console.log(`[smoke] parent tool calls: ${result.toolCallCount}`);
    console.log(`[smoke] subagent events: ${toolEvents.join(' | ') || '(none)'}`);
    console.log(`[smoke] send_image paths: ${images.join(', ') || '(none)'}`);

    if (!result.reply.trim()) problems.push('empty reply');
    if (c.expectImage) {
      if (!toolEvents.includes('task_browser ok')) problems.push('task_browser did not succeed');
      if (images.length === 0) problems.push('send_image was not called');
      else if (!images.every(isPng)) problems.push('send_image got a file that is not a PNG');
    } else {
      if (result.toolCallCount > 0)
        problems.push(`expected no tool calls, got ${result.toolCallCount}`);
      if (images.length > 0) problems.push('send_image was called for a greeting');
    }
  } catch (err) {
    problems.push(`runTurn threw: ${String((err as Error)?.message ?? err)}`);
  }

  if (problems.length) failures += 1;
  console.log(`[smoke] ${problems.length ? `FAIL — ${problems.join('; ')}` : 'PASS'}`);
}

await flushLangfuse();
console.log(`\n[smoke] ${failures ? `${failures} case(s) failed` : 'all cases passed'}`);
// MCP child processes keep the event loop alive; exit explicitly.
process.exit(failures ? 1 : 0);
