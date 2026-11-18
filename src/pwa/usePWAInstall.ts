import { useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

export function usePWAInstall() {
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isIOS, setIsIOS] = useState(false);

  useEffect(() => {
    const isStandalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone ===
        true;
    setIsInstalled(isStandalone);

    const userAgent = window.navigator.userAgent.toLowerCase();
    const isIOSDevice = /iphone|ipad|ipod/.test(userAgent);
    setIsIOS(isIOSDevice);

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setIsInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);

    return () => {
      window.removeEventListener(
        'beforeinstallprompt',
        handleBeforeInstallPrompt
      );
      window.removeEventListener('appinstalled', handleAppInstalled);
    };
  }, []);

  const install = async () => {
    if (!deferredPrompt) return false;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setIsInstalled(true);
      setDeferredPrompt(null);
      return true;
    }
    return false;
  };

  return {
    isInstallable: Boolean(deferredPrompt),
    isInstalled,
    isIOS,
    install,
  };
}

export function useOnlineStatus(): boolean {
  const [isOnline, setIsOnline] = useState<boolean>(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    const onOnline = () => setIsOnline(true);
    const onOffline = () => setIsOnline(false);

    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);

    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  return isOnline;
}

/**
 * Manages PWA Service Worker (/sw.js) and cleans up stale cache versions so
 * old Service Workers never interfere with module loading.
 */
export function useOfflineReadiness(
  prewarmLazyModules: () => Promise<void>
): { offlineReady: boolean; preparingOffline: boolean } {
  const [offlineReady, setOfflineReady] = useState<boolean>(() => {
    try {
      return localStorage.getItem('sn_leituras_offline_ready') === 'true';
    } catch {
      return false;
    }
  });
  const [preparingOffline, setPreparingOffline] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;

    async function prepare() {
      setPreparingOffline(true);
      try {
        // Clean up any legacy v1/v2 cache buckets immediately
        if (typeof window !== 'undefined' && 'caches' in window) {
          const keys = await window.caches.keys().catch(() => [] as string[]);
          await Promise.all(
            keys
              .filter((k) => k !== 'sn-leituras-cache-v3')
              .map((k) => window.caches.delete(k).catch(() => false))
          );
        }

        if ('serviceWorker' in navigator) {
          if (import.meta.env.DEV) {
            // In Vite dev mode, unregister any previously installed Service Worker
            // so it never intercepts unbundled /src/* requests
            const registrations = await navigator.serviceWorker
              .getRegistrations()
              .catch(() => []);
            await Promise.all(
              registrations.map((reg) => reg.unregister().catch(() => false))
            );
          } else {
            const reg = await navigator.serviceWorker
              .register('/sw.js', { scope: '/' })
              .catch(() => null);
            if (reg) {
              await reg.update().catch(() => {});
            }
          }
        }

        await prewarmLazyModules();
        if (!cancelled) {
          setOfflineReady(true);
          try {
            localStorage.setItem('sn_leituras_offline_ready', 'true');
          } catch {
            // ignore storage errors
          }
        }
      } finally {
        if (!cancelled) {
          setPreparingOffline(false);
        }
      }
    }

    prepare();

    return () => {
      cancelled = true;
    };
  }, [prewarmLazyModules]);

  return { offlineReady, preparingOffline };
}
