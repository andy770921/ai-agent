export interface ForwardResult {
  ok: boolean;
  status: number;
}

export interface GatewayForwarder {
  forward(rawBody: string, sigHeader: string, idempotencyKey: string): Promise<ForwardResult>;
}

export function createHttpGatewayForwarder(baseUrl: string): GatewayForwarder {
  return {
    async forward(rawBody, sigHeader, idempotencyKey) {
      try {
        const r = await fetch(`${baseUrl}/webhook/line`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'X-Line-Signature': sigHeader,
            'idempotency-key': idempotencyKey,
          },
          body: rawBody,
        });
        return { ok: r.ok, status: r.status };
      } catch {
        return { ok: false, status: 0 };
      }
    },
  };
}
