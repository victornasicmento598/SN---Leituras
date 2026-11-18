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
 * Registers the PWA Service Worker (/sw.js) and pre-warms the on-demand modules
 * (Gestão, PDF A4, Backup ZIP) so they are cached and ready for 100% offline use.
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
        if ('serviceWorker' in navigator) {
          await navigator.serviceWorker
            .register('/sw.js', { scope: '/' })
            .catch(() => null);
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
