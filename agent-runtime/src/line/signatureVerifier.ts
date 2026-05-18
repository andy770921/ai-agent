import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifyLineSignature(
  rawBody: string,
  signature: string,
  channelSecret: string,
): boolean {
  const expected = createHmac('sha256', channelSecret)
    .update(rawBody)
    .digest('base64');
  try {
    return timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature),
    );
  } catch {
    return false;
  }
}
