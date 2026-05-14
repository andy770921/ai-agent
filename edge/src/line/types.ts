export interface LineEvent {
  type?: string;
  replyToken?: string;
  webhookEventId?: string;
  deliveryContext?: { isRedelivery?: boolean };
  source?: { userId?: string };
}

export interface LinePayload {
  events?: LineEvent[];
}
