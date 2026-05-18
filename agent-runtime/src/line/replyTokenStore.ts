interface Entry {
  token: string;
  expiresAt: number;
}

const store = new Map<string, Entry>();
const TTL_MS = 50_000;

export function rememberReplyToken(userId: string, token: string) {
  store.set(userId, { token, expiresAt: Date.now() + TTL_MS });
}

export function consumeReplyToken(userId: string): string | null {
  const e = store.get(userId);
  if (!e) return null;
  store.delete(userId);
  return e.expiresAt > Date.now() ? e.token : null;
}
