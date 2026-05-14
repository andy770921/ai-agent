export interface SidecarClient {
  streamEvents(): Promise<Response>;
  listSessions(): Promise<Response>;
  getHistory(userId: string, limit: number): Promise<Response>;
}

export function createHttpSidecarClient(baseUrl: string, token: string): SidecarClient {
  const auth = `Bearer ${token}`;

  return {
    async streamEvents() {
      try {
        const upstream = await fetch(`${baseUrl}/events/stream`, {
          headers: { authorization: auth, accept: 'text/event-stream' },
        });
        if (!upstream.ok || !upstream.body) {
          return new Response('upstream error', { status: 502 });
        }
        return new Response(upstream.body, {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          },
        });
      } catch {
        return new Response('upstream error', { status: 502 });
      }
    },

    async listSessions() {
      return passthrough(
        await safeFetch(`${baseUrl}/sessions`, { headers: { authorization: auth } }),
      );
    },

    async getHistory(userId, limit) {
      const url = `${baseUrl}/sessions/${encodeURIComponent(userId)}/history?limit=${encodeURIComponent(
        String(limit),
      )}`;
      return passthrough(await safeFetch(url, { headers: { authorization: auth } }));
    },
  };
}

async function safeFetch(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    return new Response('upstream error', { status: 502 });
  }
}

function passthrough(r: Response): Response {
  // Preserve upstream content-type so an error response that's text/plain
  // doesn't crash the dashboard's r.json() parser.
  const ct = r.headers.get('content-type') ?? 'application/json';
  return new Response(r.body, {
    status: r.status,
    headers: { 'content-type': ct },
  });
}
