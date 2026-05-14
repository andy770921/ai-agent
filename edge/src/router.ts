export type RouteHandler<E> = (
  req: Request,
  env: E,
  ctx: ExecutionContext,
  params: Record<string, string>,
) => Promise<Response> | Response;

export interface Route<E> {
  method: string;
  pattern: string;
  handler: RouteHandler<E>;
  cors?: boolean;
}

export interface RouterOptions<E> {
  corsHeaders: (env: E) => Record<string, string>;
  // Path prefixes that should always be CORS-aware: preflight on OPTIONS and
  // CORS-wrapped 404 fallback. Matches the original ad-hoc handler's behavior
  // where every /api/* path responded to OPTIONS, not just known routes.
  corsPathPrefixes?: string[];
}

interface CompiledRoute<E> extends Route<E> {
  regex: RegExp;
  paramNames: string[];
}

export interface Router<E> {
  fetch(req: Request, env: E, ctx: ExecutionContext): Promise<Response>;
}

export function createRouter<E>(routes: Route<E>[], opts: RouterOptions<E>): Router<E> {
  const compiled: CompiledRoute<E>[] = routes.map(compile);
  const corsRoutes = compiled.filter((r) => r.cors);
  const corsPrefixes = opts.corsPathPrefixes ?? [];

  const isCorsPath = (pathname: string): boolean =>
    corsRoutes.some((r) => r.regex.test(pathname)) ||
    corsPrefixes.some((p) => pathname.startsWith(p));

  return {
    async fetch(req, env, ctx) {
      const url = new URL(req.url);

      if (req.method === 'OPTIONS' && isCorsPath(url.pathname)) {
        return new Response(null, { status: 204, headers: opts.corsHeaders(env) });
      }

      for (const route of compiled) {
        if (route.method !== req.method) continue;
        const m = route.regex.exec(url.pathname);
        if (!m) continue;
        const params: Record<string, string> = {};
        route.paramNames.forEach((name, i) => {
          params[name] = decodeURIComponent(m[i + 1] ?? '');
        });
        const res = await route.handler(req, env, ctx, params);
        return route.cors ? withCors(res, opts.corsHeaders(env)) : res;
      }

      const fallback = new Response('not found', { status: 404 });
      return isCorsPath(url.pathname) ? withCors(fallback, opts.corsHeaders(env)) : fallback;
    },
  };
}

function compile<E>(route: Route<E>): CompiledRoute<E> {
  const paramNames: string[] = [];
  const regexSrc = route.pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        paramNames.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { ...route, regex: new RegExp(`^${regexSrc}$`), paramNames };
}

function withCors(response: Response, headers: Record<string, string>): Response {
  const merged = new Headers(response.headers);
  for (const [k, v] of Object.entries(headers)) merged.set(k, v);
  return new Response(response.body, { status: response.status, headers: merged });
}
