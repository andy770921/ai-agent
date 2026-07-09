'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useDashboardToken } from '@/hooks/useDashboardToken';

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { token, clear, hydrated } = useDashboardToken();
  const pathname = usePathname();
  const router = useRouter();
  const isLogin = pathname?.endsWith('/login') || pathname?.endsWith('/login/');

  useEffect(() => {
    if (!hydrated) return;
    if (!token && !isLogin) {
      router.replace('/dashboard/login');
    }
  }, [hydrated, token, isLogin, router]);

  return (
    <div style={{ maxWidth: 920, margin: '0 auto', padding: '16px 20px' }}>
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          borderBottom: '1px solid #eee',
          paddingBottom: 8,
          marginBottom: 16,
        }}
      >
        <nav>
          <Link href="/dashboard" style={{ marginRight: 12 }}>
            Live feed
          </Link>
          <Link href="/dashboard/sessions">Sessions</Link>
        </nav>
        {token && (
          <button
            type="button"
            onClick={() => {
              clear();
              router.replace('/dashboard/login');
            }}
          >
            Sign out
          </button>
        )}
      </header>
      {children}
    </div>
  );
}
