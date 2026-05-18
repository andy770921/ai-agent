const BASE = 'https://api.line.me/v2/bot/message';

async function call(path: string, body: unknown) {
  const r = await fetch(`${BASE}/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  if (!r.ok)
    throw new Error(`LINE ${path} ${r.status}: ${await r.text()}`);
  return r.json();
}

export const lineReply = (replyToken: string, text: string) =>
  call('reply', { replyToken, messages: [{ type: 'text', text }] });

export const linePush = (to: string, text: string) =>
  call('push', { to, messages: [{ type: 'text', text }] });

export const linePushImage = (
  to: string,
  originalContentUrl: string,
  previewImageUrl: string,
) =>
  call('push', {
    to,
    messages: [{ type: 'image', originalContentUrl, previewImageUrl }],
  });
