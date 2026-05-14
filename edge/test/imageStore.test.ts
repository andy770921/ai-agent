import { describe, it, expect } from 'vitest';
import { createKvImageStore, type ImageStore } from '../src/ports/imageStore';

interface InMemoryEntry {
  value: ArrayBuffer;
  metadata: { contentType?: string };
  ttl: number;
}

function makeKv(): { kv: KVNamespace; store: Map<string, InMemoryEntry> } {
  const store = new Map<string, InMemoryEntry>();
  const kv = {
    async put(
      key: string,
      value: ArrayBuffer,
      opts?: { expirationTtl?: number; metadata?: { contentType?: string } },
    ) {
      store.set(key, {
        value,
        metadata: opts?.metadata ?? {},
        ttl: opts?.expirationTtl ?? 0,
      });
    },
    async getWithMetadata<M>(key: string) {
      const entry = store.get(key);
      if (!entry) return { value: null, metadata: null };
      return { value: entry.value, metadata: entry.metadata as M };
    },
  } as unknown as KVNamespace;
  return { kv, store };
}

function imageStore(): { fs: ImageStore; store: Map<string, InMemoryEntry> } {
  const { kv, store } = makeKv();
  return { fs: createKvImageStore(kv, 100), store };
}

describe('createKvImageStore', () => {
  it('round-trips bytes + content-type', async () => {
    const { fs } = imageStore();
    const body = new TextEncoder().encode('png-bytes').buffer as ArrayBuffer;
    await fs.put('abc.png', body, 'image/png');
    const out = await fs.get('abc.png');
    expect(out?.contentType).toBe('image/png');
    expect(new TextDecoder().decode(out!.body)).toBe('png-bytes');
  });

  it('returns null for an unknown key', async () => {
    const { fs } = imageStore();
    expect(await fs.get('missing.png')).toBeNull();
  });

  it('falls back to image/png when metadata is absent', async () => {
    const { fs, store } = imageStore();
    const body = new TextEncoder().encode('x').buffer as ArrayBuffer;
    store.set('legacy.png', { value: body, metadata: {}, ttl: 0 });
    const out = await fs.get('legacy.png');
    expect(out?.contentType).toBe('image/png');
  });

  it('forwards the configured TTL to KV.put', async () => {
    const { fs, store } = imageStore();
    await fs.put('ttl.png', new TextEncoder().encode('x').buffer as ArrayBuffer, 'image/png');
    expect(store.get('ttl.png')?.ttl).toBe(100);
  });
});
