import { describe, it, expect } from 'vitest';
import { requireDashboardToken } from '../src/auth';
import type { Env } from '../src/env';

const envFixture: Env = {
  IMG_BUCKET: {} as R2Bucket,
  WEBHOOK_DEDUP: {} as KVNamespace,
  GATEWAY_BASE_URL: 'https://gw',
  SIDECAR_BASE_URL: 'https://sc',
  DASHBOARD_ORIGIN: 'https://dash',
  LINE_CHANNEL_SECRET: 'secret',
  LINE_ALLOWED_USER_IDS: '',
  CF_UPLOAD_SECRET: 'cf',
  DASHBOARD_INGEST_TOKEN: 'ingest',
  DASHBOARD_TOKEN: 'dashtoken',
};

describe('requireDashboardToken', () => {
  it('returns undefined when bearer matches', () => {
    const req = new Request('https://x/api/x', {
      headers: { authorization: 'Bearer dashtoken' },
    });
    expect(requireDashboardToken(req, envFixture)).toBeUndefined();
  });

  it('returns 401 when bearer is missing', () => {
    const req = new Request('https://x/api/x');
    const res = requireDashboardToken(req, envFixture);
    expect(res?.status).toBe(401);
  });

  it('returns 401 when bearer is wrong', () => {
    const req = new Request('https://x/api/x', {
      headers: { authorization: 'Bearer nope' },
    });
    const res = requireDashboardToken(req, envFixture);
    expect(res?.status).toBe(401);
  });
});
