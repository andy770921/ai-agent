import { describe, it, expect } from 'vitest';
import { createKvWebhookDedupStore } from '../../src/line/webhookDedupStore';

interface Entry {
  value: string;
  ttl: number;
}

function makeKv(): { kv: KVNamespace; store: Map<string, Entry> } {
  const store = new Map<string, Entry>();
  const kv = {
    async get(key: string) {
      return store.get(key)?.value ?? null;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      store.set(key, { value, ttl: opts?.expirationTtl ?? 0 });
    },
  } as unknown as KVNamespace;
  return { kv, store };
}

describe('createKvWebhookDedupStore', () => {
  it('claim() returns "claimed" the first time and "duplicate" the second time', async () => {
    const { kv } = makeKv();
    const dedup = createKvWebhookDedupStore(kv, 60);

    expect(await dedup.claim('evt-1')).toBe('claimed');
    expect(await dedup.claim('evt-1')).toBe('duplicate');
  });

  it('initial claim writes the "processing" sentinel with TTL', async () => {
    const { kv, store } = makeKv();
    const dedup = createKvWebhookDedupStore(kv, 60);
    await dedup.claim('abc');
    expect(store.get('evt:abc')?.value).toBe('processing');
    expect(store.get('evt:abc')?.ttl).toBe(60);
  });

  it('markDelivered overwrites with the "delivered" sentinel', async () => {
    const { kv, store } = makeKv();
    const dedup = createKvWebhookDedupStore(kv, 60);
    await dedup.claim('id1');
    await dedup.markDelivered(['id1']);
    expect(store.get('evt:id1')?.value).toBe('delivered');
  });
});
