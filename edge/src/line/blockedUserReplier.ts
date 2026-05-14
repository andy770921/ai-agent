import type { LineEvent } from './types';

export interface BlockedUserReplier {
  notifyBlocked(events: LineEvent[]): Promise<void>;
}

const BLOCKED_MESSAGE =
  'This service is currently unavailable. A team member will assist you shortly.';

export function createLineReplyBlockedUserReplier(accessToken: string): BlockedUserReplier {
  return {
    async notifyBlocked(events) {
      for (const ev of events) {
        if (!ev.replyToken || ev.type === 'follow' || ev.type === 'unfollow') continue;
        try {
          await fetch('https://api.line.me/v2/bot/message/reply', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${accessToken}`,
            },
            body: JSON.stringify({
              replyToken: ev.replyToken,
              messages: [{ type: 'text', text: BLOCKED_MESSAGE }],
            }),
          });
        } catch (err) {
          console.error('reply to blocked user failed', err);
        }
      }
    },
  };
}
