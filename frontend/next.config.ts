import path from 'path';
import type { NextConfig } from 'next';

// FEAT-1: frontend is deployed as a Cloudflare Pages static export hosting the
// `/dashboard` views. Set `BUILD_TARGET=pages` for the export-style build.
// The default build still runs Next.js in SSR mode (useful for `npm run dev`
// against the dashboard locally); no rewrites are needed because the dashboard
// always talks to the Cloudflare Worker via `NEXT_PUBLIC_WORKER_URL` directly.
const isPagesBuild = process.env.BUILD_TARGET === 'pages';

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.join(__dirname, '../'),
  transpilePackages: ['lodash-es'],
  eslint: {
    ignoreDuringBuilds: true,
  },
  ...(isPagesBuild
    ? {
        output: 'export' as const,
        images: { unoptimized: true },
        trailingSlash: true,
      }
    : {}),
};

export default nextConfig;
