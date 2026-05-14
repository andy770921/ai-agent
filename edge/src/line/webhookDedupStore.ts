export type ClaimResult = 'claimed' | 'duplicate';

export interface WebhookDedupStore {
  claim(eventId: string): Promise<ClaimResult>;
  markDelivered(eventIds: string[]): Promise<void>;
}

export function createKvWebhookDedupStore(kv: KVNamespace, ttlSeconds: number): WebhookDedupStore {
  return {
    async claim(eventId) {
      const key = `evt:${eventId}`;
      const seen = await kv.get(key);
      if (seen) return 'duplicate';
      await kv.put(key, 'processing', { expirationTtl: ttlSeconds });
      return 'claimed';
    },
    async markDelivered(eventIds) {
      await Promise.all(
        eventIds.map((id) => kv.put(`evt:${id}`, 'delivered', { expirationTtl: ttlSeconds })),
      );
    },
  };
}
