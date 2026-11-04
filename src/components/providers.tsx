'use client';

import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ThemeProvider, useTheme } from 'next-themes';
import { Toaster } from 'sonner';
import { useEffect, useState } from 'react';
import { AuthProvider } from './auth-provider';
import { initCrossTabSync } from '@/lib/cache-manager';

function ThemeSurfaceSync() {
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const isDark = resolvedTheme === 'dark';
    const bg = isDark ? '#090d16' : '#f7f7fc';
    document.documentElement.style.backgroundColor = bg;
    document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
    document.body.style.backgroundColor = bg;

    const metas = document.querySelectorAll('meta[name="theme-color"]');
    if (metas.length > 0) {
      metas.forEach((meta) => meta.setAttribute('content', bg));
    } else {
      const meta = document.createElement('meta');
      meta.name = 'theme-color';
      meta.content = bg;
      document.head.appendChild(meta);
    }
  }, [resolvedTheme]);

  return null;
}

function CrossTabSyncListener() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const cleanup = initCrossTabSync((message) => {
      if (message.type === 'CATEGORY_CAPS_UPDATED') {
        queryClient.invalidateQueries({ queryKey: ['category_caps'] });
        queryClient.invalidateQueries({ queryKey: ['overview'] });
        queryClient.invalidateQueries({ queryKey: ['budget'] });
      } else if (message.type === 'SETTINGS_UPDATED') {
        queryClient.invalidateQueries({ queryKey: ['user_profile'] });
        queryClient.invalidateQueries({ queryKey: ['overview'] });
      } else if (
        message.type === 'MUTATION_QUEUED' ||
        message.type === 'SYNC_COMPLETED' ||
        message.type === 'SWR_CACHE_INVALIDATED'
      ) {
        queryClient.invalidateQueries({ queryKey: ['sheet'] });
        queryClient.invalidateQueries({ queryKey: ['months'] });
        queryClient.invalidateQueries({ queryKey: ['overview'] });
      }
    });

    return () => {
      cleanup();
    };
  }, [queryClient]);

  return null;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 5 * 60 * 1000, // 5 minutes cache
            gcTime: 15 * 60 * 1000, // 15 minutes garbage collection
            refetchOnWindowFocus: false,
            refetchOnMount: false,
            refetchOnReconnect: false,
          },
        },
      })
  );

  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
      <ThemeSurfaceSync />
      <Toaster position="top-right" richColors />
      <QueryClientProvider client={queryClient}>
        <CrossTabSyncListener />
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
