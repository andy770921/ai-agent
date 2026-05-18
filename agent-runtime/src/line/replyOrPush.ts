import { consumeReplyToken } from './replyTokenStore.js';
import { lineReply, linePush } from './lineClient.js';

export async function replyOrPush(userId: string, text: string) {
  const token = consumeReplyToken(userId);
  if (token) {
    try {
      await lineReply(token, text);
      return;
    } catch {
      /* fall through to push */
    }
  }
  await linePush(userId, text);
}
