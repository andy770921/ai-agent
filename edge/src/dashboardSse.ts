import type { SidecarClient } from './ports/sidecarClient';

export function handleSessionsStream(_req: Request, sidecar: SidecarClient): Promise<Response> {
  return sidecar.streamEvents();
}
