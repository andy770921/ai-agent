import Link from 'next/link';

export default function Home() {
  return (
    <main style={{ padding: '32px 24px', maxWidth: 720, margin: '0 auto' }}>
      <h1>OpenAB LINE agent — dashboard host</h1>
      <p>
        This Next.js app is deployed as a static export to Cloudflare Pages and hosts the FEAT-1
        agent dashboard.
      </p>
      <p>
        <Link href="/dashboard">→ Open the dashboard</Link>
      </p>
    </main>
  );
}
