'use client';

import { useCallback, useEffect, useState } from 'react';

const KEY = 'openab.dashboard.token';

export function useDashboardToken() {
  const [token, setTokenState] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setTokenState(localStorage.getItem(KEY));
    setHydrated(true);
  }, []);

  const setToken = useCallback((t: string) => {
    localStorage.setItem(KEY, t);
    setTokenState(t);
  }, []);

  const clear = useCallback(() => {
    localStorage.removeItem(KEY);
    setTokenState(null);
  }, []);

  return { token, setToken, clear, hydrated };
}
