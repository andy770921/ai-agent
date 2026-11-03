// Keep-alive for the agent-runtime HF Space, driven by the Worker's Cron
// Trigger (see `[triggers]` in wrangler.toml).
//
// HF Spaces' free tier sleeps a Space after 48 h without traffic. This used to
// be a GitHub Actions schedule, but GitHub auto-disables schedules in public
// repos after 60 days without repo activity; Cloudflare crons have no such
// rule. See documents/FIX-3.

const TIMEOUT_MS = 30_000;

/**
 * GET `${baseUrl}/healthz` and throw unless it answers 2xx with `{ ok: true }`.
 * Throwing (rather than logging) marks the cron invocation as failed in
 * Cloudflare's logs, so a sleeping or broken Space is visible.
 */
export async function pingAgentRuntime(baseUrl: string): Promise<void> {
  const url = `${baseUrl}/healthz`;

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`keep-alive: ${url} unreachable: ${(err as Error).message}`);
  }
  if (!res.ok) {
    throw new Error(`keep-alive: ${url} returned HTTP ${res.status}`);
  }

  // A 200 that isn't our JSON (e.g. an HF interstitial page) is not healthy.
  const body = (await res.json().catch(() => null)) as { ok?: unknown; uptime?: unknown } | null;
  if (body?.ok !== true) {
    throw new Error(`keep-alive: ${url} returned an unexpected body`);
  }
  console.log(`keep-alive: ${url} ok (uptime ${String(body.uptime)}s)`);
}
