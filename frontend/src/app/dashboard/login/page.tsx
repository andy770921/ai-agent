'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useDashboardToken } from '@/hooks/useDashboardToken';

export default function LoginPage() {
  const { setToken } = useDashboardToken();
  const router = useRouter();
  const [value, setValue] = useState('');

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!value.trim()) return;
        setToken(value.trim());
        router.replace('/dashboard');
      }}
    >
      <h1>Dashboard sign-in</h1>
      <p>Paste the dashboard bearer token to access live agent activity.</p>
      <input
        type="password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="DASHBOARD_TOKEN"
        autoComplete="off"
        style={{ display: 'block', padding: 8, width: '100%', maxWidth: 480, margin: '12px 0' }}
      />
      <button type="submit">Save</button>
    </form>
  );
}
