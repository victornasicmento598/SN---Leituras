import React, { useState } from 'react';
import { CheckCircle2, Download, Smartphone, Wifi, WifiOff } from 'lucide-react';
import { useOnlineStatus, usePWAInstall } from '../pwa/usePWAInstall';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={install}
        className="min-h-[44px] px-3.5 py-2 rounded-xl bg-[#E08E00] text-[#0F172A] font-bold text-xs flex items-center gap-1.5 shadow-sm hover:bg-[#c97e00] active:scale-[0.98] transition whitespace-nowrap shrink-0"
      >
        <Download className="w-4 h-4 shrink-0" />
        <span>Instalar App</span>
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className="min-h-[44px] px-3 py-2 rounded-xl bg-white/15 text-white border border-white/25 font-semibold text-xs flex items-center gap-1.5 hover:bg-white/25 transition whitespace-nowrap shrink-0"
        >
          <Smartphone className="w-4 h-4 shrink-0" />
          <span>Instalar no iPhone</span>
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
            <div className="w-full max-w-sm rounded-2xl bg-white p-6 text-[#0F172A] shadow-xl">
              <h3 className="text-lg font-bold">
                Instalar SN - Leituras no iPhone / iPad
              </h3>
              <p className="mt-2 text-sm text-slate-700 leading-relaxed">
                1. Toque no botão <strong>Compartilhar</strong> na barra do Safari.
                <br />
                2. Role para baixo e toque em{' '}
                <strong>Adicionar à Tela de Início</strong>.
              </p>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="mt-5 w-full min-h-[44px] rounded-xl bg-[#0A2239] text-white font-bold text-sm"
              >
                Entendi
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  return null;
};

export const ConnectivityAndOfflineBadge: React.FC<{
  offlineReady: boolean;
}> = ({ offlineReady }) => {
  const isOnline = useOnlineStatus();

  return (
    <div className="flex flex-wrap items-center gap-2">
      {!isOnline ? (
        <div
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#FEF3C7] text-[#92400E] border border-[#F59E0B] font-bold text-xs whitespace-nowrap shrink-0"
          title="Modo Offline ativo: usando dados salvos no IndexedDB"
        >
          <WifiOff className="w-4 h-4 shrink-0" />
          <span>Offline</span>
        </div>
      ) : (
        <div
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl bg-emerald-50 text-emerald-800 border border-emerald-300 font-semibold text-xs whitespace-nowrap shrink-0"
          title="Conexão de rede disponível"
        >
          <Wifi className="w-3.5 h-3.5 shrink-0" />
          <span>Online</span>
        </div>
      )}

      {offlineReady && (
        <div
          className="inline-flex items-center gap-1 text-xs font-semibold text-slate-700 whitespace-nowrap"
          title="Módulos de Coleta, Gestão, PDF e ZIP preparados para uso sem internet"
        >
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-700 shrink-0" />
          <span>Pronto para uso offline</span>
        </div>
      )}
    </div>
  );
};
