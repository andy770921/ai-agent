import type { SidecarClient } from './ports/sidecarClient';

export function handleSessionsList(_req: Request, sidecar: SidecarClient): Promise<Response> {
  return sidecar.listSessions();
}

export function handleSessionsHistory(
  req: Request,
  sidecar: SidecarClient,
  userId: string,
): Promise<Response> {
  const u = new URL(req.url);
  const limit = parseInt(u.searchParams.get('limit') ?? '50', 10) || 50;
  return sidecar.getHistory(userId, limit);
}
