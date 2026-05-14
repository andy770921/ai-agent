export interface StoredImage {
  body: ArrayBuffer;
  contentType: string;
}

export interface ImageStore {
  put(key: string, body: ArrayBuffer, contentType: string): Promise<void>;
  get(key: string): Promise<StoredImage | null>;
}

interface ImageMeta {
  contentType?: string;
}

export function createKvImageStore(kv: KVNamespace, ttlSeconds: number): ImageStore {
  return {
    async put(key, body, contentType) {
      await kv.put(key, body, {
        expirationTtl: ttlSeconds,
        metadata: { contentType } satisfies ImageMeta,
      });
    },
    async get(key) {
      const { value, metadata } = await kv.getWithMetadata<ImageMeta>(key, 'arrayBuffer');
      if (!value) return null;
      return {
        body: value,
        contentType: metadata?.contentType ?? 'image/png',
      };
    },
  };
}
