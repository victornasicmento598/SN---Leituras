import React, { useState } from 'react';
import { User } from 'firebase/auth';
import {
  AlertTriangle,
  Check,
  Cloud,
  Copy,
  Database,
  FileSpreadsheet,
  FlaskConical,
  FolderArchive,
  LogIn,
  LogOut,
  Menu,
  RefreshCw,
  Settings,
  Smartphone,
} from 'lucide-react';
import {
  CONDOMINIUM_NAME,
  OperatingMode,
  ServiceType,
  TOTAL_UNITS_PER_SERVICE,
  TowerProgressSummary,
  formatTowerNumber,
} from '../types/domain';
import {
  ConnectivityAndOfflineBadge,
  PWAInstallButton,
} from './PWAHeaderControls';
import { ServiceToggleBar } from './ServiceToggleBar';

interface TowersScreenProps {
  mode: OperatingMode;
  onToggleTrainingMode: (nextMode: OperatingMode) => void;
  cycleId: string;
  onChangeCycleId: (newCycleId: string) => void;
  activeService: ServiceType;
  onSelectService: (service: ServiceType) => void;
  towersProgress: TowerProgressSummary[];
  waterTotalRead: number;
  gasTotalRead: number;
  pendingSyncCount: number;
  totalReferencesForService: number;
  offlineReady: boolean;
  firebaseConfigured: boolean;
  activeFirebaseProjectId?: string;
  authErrorCode?: string | null;
  currentUser: User | null;
  onGoogleLogin: () => Promise<void>;
  onGoogleLogout: () => Promise<void>;
  onExplicitSync: () => Promise<void>;
  isSyncing: boolean;
  lastSyncMessage: string | null;
  onSelectTower: (tower: number) => void;
  onOpenManagement: (initialTab?: 'csv' | 'review' | 'order' | 'limits' | 'backup') => void;
  onQuickLoadHomologatedCsv: (service: ServiceType) => Promise<void>;
}

export const TowersScreen: React.FC<TowersScreenProps> = ({
  mode,
  onToggleTrainingMode,
  cycleId,
  onChangeCycleId,
  activeService,
  onSelectService,
  towersProgress,
  waterTotalRead,
  gasTotalRead,
  pendingSyncCount,
  totalReferencesForService,
  offlineReady,
  firebaseConfigured,
  activeFirebaseProjectId,
  authErrorCode,
  currentUser,
  onGoogleLogin,
  onGoogleLogout,
  onExplicitSync,
  isSyncing,
  lastSyncMessage,
  onSelectTower,
  onOpenManagement,
  onQuickLoadHomologatedCsv,
}) => {
  const [copiedUid, setCopiedUid] = useState(false);
  const [copiedDomain, setCopiedDomain] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [loadingQuickCsv, setLoadingQuickCsv] = useState(false);

  const totalRead = towersProgress.reduce((acc, t) => acc + t.readCount, 0);
  const totalLocalOnly = towersProgress.reduce(
    (acc, t) => acc + t.localOnlyCount,
    0
  );
  const totalSynced = towersProgress.reduce((acc, t) => acc + t.syncedCount, 0);
  const totalAlerts = towersProgress.reduce((acc, t) => acc + t.alertCount, 0);
  const totalConflicts = towersProgress.reduce(
    (acc, t) => acc + t.conflictCount,
    0
  );

  const handleCopyUid = async () => {
    if (!currentUser?.uid) return;
    try {
      await navigator.clipboard.writeText(currentUser.uid);
      setCopiedUid(true);
      setTimeout(() => setCopiedUid(false), 2500);
    } catch {
      // ignore clipboard errors
    }
  };

  const handleQuickSeed = async () => {
    setLoadingQuickCsv(true);
    try {
      await onQuickLoadHomologatedCsv(activeService);
    } finally {
      setLoadingQuickCsv(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#F4F6F9] text-[#0F172A]">
      {/* Top Bar matching the field visual reference */}
      <header className="sticky top-0 z-30 bg-[#0A2239] text-white shadow-md">
        <div className="max-w-5xl mx-auto px-4 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMenuOpen((prev) => !prev)}
              aria-label="Abrir menu de ações e modo de operação"
              className="min-h-[44px] min-w-[44px] -ml-2 rounded-xl flex items-center justify-center hover:bg-white/10 active:bg-white/20 transition"
            >
              <Menu className="w-6 h-6" />
            </button>
            <h1 className="text-xl font-extrabold tracking-tight truncate">
              SN - Leituras
            </h1>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <PWAInstallButton />
            <button
              type="button"
              onClick={() => onOpenManagement('review')}
              className="min-h-[44px] px-3.5 py-2 rounded-xl bg-white/15 hover:bg-white/25 text-white font-bold text-xs flex items-center gap-1.5 transition whitespace-nowrap"
            >
              <Settings className="w-4 h-4 shrink-0" />
              <span>Gestão</span>
            </button>
          </div>
        </div>
      </header>

      {/* Expandable quick drawer for cycle selection & Training Mode (available ONLY on initial screen) */}
      {menuOpen && (
        <div className="bg-[#102E4A] text-white border-b border-white/15">
          <div className="max-w-5xl mx-auto px-4 py-4 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold text-slate-300">
                  Modo de Armazenamento Local (IndexedDB)
                </p>
                <p className="text-sm font-bold mt-0.5">
                  {mode === 'real'
                    ? 'Piloto Local / Coleta Real (Banco Principal)'
                    : 'Modo Treinamento (Banco Isolado de Demonstração)'}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    onToggleTrainingMode('real');
                    setMenuOpen(false);
                  }}
                  className={`min-h-[44px] px-3.5 py-2 rounded-xl text-xs font-bold transition ${
                    mode === 'real'
                      ? 'bg-[#E08E00] text-[#0F172A]'
                      : 'bg-white/10 text-white hover:bg-white/20'
                  }`}
                >
                  Piloto Local (Real)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    onToggleTrainingMode('training');
                    setMenuOpen(false);
                  }}
                  className={`min-h-[44px] px-3.5 py-2 rounded-xl text-xs font-bold flex items-center gap-1.5 transition ${
                    mode === 'training'
                      ? 'bg-purple-400 text-[#0F172A]'
                      : 'bg-white/10 text-white hover:bg-white/20'
                  }`}
                >
                  <FlaskConical className="w-4 h-4" />
                  <span>Modo Treinamento</span>
                </button>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-white/10">
              <label className="flex items-center gap-2 text-xs font-bold">
                <span>Ciclo Ativo (YYYY-MM):</span>
                <input
                  type="month"
                  value={cycleId}
                  onChange={(e) => {
                    if (/^\d{4}-\d{2}$/.test(e.target.value)) {
                      onChangeCycleId(e.target.value);
                    }
                  }}
                  className="min-h-[40px] px-3 py-1.5 rounded-lg bg-white text-[#0F172A] font-mono font-bold text-sm"
                />
              </label>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenManagement('csv');
                  }}
                  className="min-h-[40px] px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 text-xs font-bold flex items-center gap-1.5"
                >
                  <FileSpreadsheet className="w-4 h-4" />
                  <span>Importar CSV</span>
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenManagement('backup');
                  }}
                  className="min-h-[40px] px-3 py-1.5 rounded-lg bg-white/15 hover:bg-white/25 text-xs font-bold flex items-center gap-1.5"
                >
                  <FolderArchive className="w-4 h-4" />
                  <span>Restaurar Backup ZIP</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Training Mode isolation banner */}
      {mode === 'training' && (
        <div className="bg-purple-900 text-white px-4 py-2.5">
          <div className="max-w-5xl mx-auto flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs font-bold">
              <FlaskConical className="w-4 h-4 text-purple-300 shrink-0" />
              <span>
                MODO TREINAMENTO ATIVO — Os dados e fotos estão em armazenamento
                separado e não afetam o Piloto Local nem o Firebase.
              </span>
            </div>
            <button
              type="button"
              onClick={() => onToggleTrainingMode('real')}
              className="min-h-[36px] px-3 py-1 rounded-lg bg-white text-purple-950 font-bold text-xs whitespace-nowrap"
            >
              Sair do Treinamento
            </button>
          </div>
        </div>
      )}

      {/* Main Content Container */}
      <main className="flex-1 max-w-5xl w-full mx-auto px-4 py-4 space-y-4">
        {/* Condominium Identity + Offline Indicator matching PNG reference */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-extrabold text-[#0F172A]">
              {CONDOMINIUM_NAME}
            </h2>
            <p className="text-xs font-semibold text-slate-600">
              Ciclo {cycleId} · 28 Torres · 560 unidades por serviço
            </p>
          </div>
          <ConnectivityAndOfflineBadge offlineReady={offlineReady} />
        </div>

        {/* Unified Água / Gás Toggle Bar */}
        <ServiceToggleBar
          activeService={activeService}
          onSelectService={onSelectService}
          waterBadge={`${waterTotalRead}/${TOTAL_UNITS_PER_SERVICE}`}
          gasBadge={`${gasTotalRead}/${TOTAL_UNITS_PER_SERVICE}`}
        />

        {/* Local Storage & Explicit Cloud Sync Status Panel */}
        <section className="rounded-2xl bg-white border border-slate-300 p-3.5 shadow-2xs space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs font-bold text-slate-700">
              <span className="inline-flex items-center gap-1 text-[#0A2239]">
                <Smartphone className="w-4 h-4 text-[#0D8A9E]" />
                <span>
                  Lidas ({activeService === 'water' ? 'Água' : 'Gás'}):{' '}
                  <strong className="font-mono tabular-nums">
                    {totalRead}/{TOTAL_UNITS_PER_SERVICE}
                  </strong>
                </span>
              </span>
              <span aria-hidden="true">·</span>
              <span className="text-amber-800">
                Salvas apenas no aparelho:{' '}
                <strong className="font-mono tabular-nums">
                  {totalLocalOnly}
                </strong>
              </span>
              {mode === 'real' && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-emerald-800">
                    Sincronizadas:{' '}
                    <strong className="font-mono tabular-nums">
                      {totalSynced}
                    </strong>
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="text-slate-700">
                    Fila pendente:{' '}
                    <strong className="font-mono tabular-nums">
                      {pendingSyncCount}
                    </strong>
                  </span>
                </>
              )}
              {totalAlerts > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-red-700">
                    Alertas:{' '}
                    <strong className="font-mono tabular-nums">
                      {totalAlerts}
                    </strong>
                  </span>
                </>
              )}
              {totalConflicts > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="text-red-800 underline">
                    Conflitos:{' '}
                    <strong className="font-mono tabular-nums">
                      {totalConflicts}
                    </strong>
                  </span>
                </>
              )}
            </div>

            {/* Explicit Sync ("Atualizar") and Auth Controls for Real Pilot Mode */}
            {mode === 'real' && (
              <div className="flex flex-wrap items-center gap-2">
                {firebaseConfigured && currentUser ? (
                  <>
                    <button
                      type="button"
                      onClick={onExplicitSync}
                      disabled={isSyncing}
                      className="min-h-[44px] px-4 py-2 rounded-xl bg-[#0A2239] hover:bg-[#13385c] disabled:opacity-60 text-white font-bold text-xs flex items-center gap-2 shadow-xs transition whitespace-nowrap"
                    >
                      <RefreshCw
                        className={`w-4 h-4 shrink-0 ${
                          isSyncing ? 'animate-spin' : ''
                        }`}
                      />
                      <span>
                        {isSyncing
                          ? 'Sincronizando...'
                          : pendingSyncCount > 0
                          ? `Atualizar (${pendingSyncCount} na fila)`
                          : 'Atualizar'}
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={onGoogleLogout}
                      title="Sair da conta Google (mantém dados locais)"
                      className="min-h-[44px] px-3 py-2 rounded-xl border border-slate-300 text-slate-700 hover:bg-slate-100 font-bold text-xs flex items-center gap-1.5"
                    >
                      <LogOut className="w-4 h-4" />
                      <span>Sair</span>
                    </button>
                  </>
                ) : firebaseConfigured ? (
                  <button
                    type="button"
                    onClick={onGoogleLogin}
                    className="min-h-[44px] px-3.5 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-bold text-xs flex items-center gap-1.5 transition whitespace-nowrap"
                  >
                    <LogIn className="w-4 h-4 shrink-0" />
                    <span>Entrar com Google (Coleta em Dupla)</span>
                  </button>
                ) : (
                  <span className="text-xs font-semibold text-slate-600 flex items-center gap-1">
                    <Database className="w-3.5 h-3.5" />
                    <span>Piloto Local (Sem nuvem ativa)</span>
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Authenticated Reader Info + Copy UID helper for Firestore Rules */}
          {mode === 'real' && currentUser && (
            <div className="pt-2.5 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs">
              <div className="flex flex-wrap items-center gap-2 text-slate-700">
                <Cloud className="w-4 h-4 text-[#0D8A9E] shrink-0" />
                <span>
                  Leiturista:{' '}
                  <strong>
                    {currentUser.displayName || currentUser.email}
                  </strong>
                </span>
                <span aria-hidden="true">·</span>
                <span className="font-mono text-[11px] bg-slate-100 px-2 py-0.5 rounded border border-slate-300">
                  UID: {currentUser.uid}
                </span>
              </div>
              <button
                type="button"
                onClick={handleCopyUid}
                className="min-h-[36px] px-2.5 py-1 rounded-lg border border-slate-300 hover:bg-slate-100 font-bold text-xs flex items-center gap-1 text-[#0A2239]"
              >
                {copiedUid ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-700" />
                    <span>UID copiado!</span>
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    <span>Copiar meu UID (p/ regras Firestore)</span>
                  </>
                )}
              </button>
            </div>
          )}

          {lastSyncMessage && (
            <div className="rounded-xl bg-slate-100 border border-slate-300 px-3 py-2 text-xs font-semibold text-slate-800 space-y-2">
              <p>{lastSyncMessage}</p>

              {authErrorCode === 'auth/unauthorized-domain' && (
                <div className="rounded-lg bg-amber-50 border border-amber-400 p-3 text-[#0F172A] space-y-2">
                  <p className="font-extrabold text-amber-950">
                    Como liberar o login Google neste domínio ({typeof window !== 'undefined' ? window.location.hostname : 'sn-leituras.vercel.app'}):
                  </p>
                  <ol className="list-decimal list-inside space-y-1 text-xs text-slate-800">
                    <li>
                      No Console do Firebase do projeto ativo (
                      <code className="bg-white px-1.5 py-0.5 rounded border border-slate-300 font-mono font-bold">
                        {activeFirebaseProjectId || 'projeto-piloto'}
                      </code>
                      ), abra{' '}
                      <strong>
                        Authentication → Settings (Configurações) → Authorized domains (Domínios autorizados)
                      </strong>
                      .
                    </li>
                    <li>
                      Clique em <strong>Add domain (Adicionar domínio)</strong>, cole{' '}
                      <code className="bg-white px-1.5 py-0.5 rounded border border-slate-300 font-mono font-bold">
                        {typeof window !== 'undefined' ? window.location.hostname : 'sn-leituras.vercel.app'}
                      </code>{' '}
                      e salve.
                    </li>
                    <li>
                      <em>Nota:</em> Se você criou um projeto Firebase separado para o piloto (diferente de{' '}
                      <code>{activeFirebaseProjectId}</code>), configure as variáveis{' '}
                      <code>VITE_FIREBASE_*</code> na Vercel em{' '}
                      <strong>Project Settings → Environment Variables</strong> e faça um Redeploy.
                    </li>
                  </ol>
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={async () => {
                        const domain =
                          typeof window !== 'undefined'
                            ? window.location.hostname
                            : 'sn-leituras.vercel.app';
                        try {
                          await navigator.clipboard.writeText(domain);
                          setCopiedDomain(true);
                          setTimeout(() => setCopiedDomain(false), 2500);
                        } catch {
                          // ignore
                        }
                      }}
                      className="min-h-[36px] px-3 py-1.5 rounded-lg bg-[#0A2239] text-white font-bold text-xs flex items-center gap-1.5"
                    >
                      {copiedDomain ? (
                        <>
                          <Check className="w-3.5 h-3.5 text-emerald-300" />
                          <span>Domínio copiado!</span>
                        </>
                      ) : (
                        <>
                          <Copy className="w-3.5 h-3.5" />
                          <span>
                            Copiar domínio ({typeof window !== 'undefined' ? window.location.hostname : 'sn-leituras.vercel.app'})
                          </span>
                        </>
                      )}
                    </button>
                    {activeFirebaseProjectId && (
                      <a
                        href={`https://console.firebase.google.com/project/${activeFirebaseProjectId}/authentication/settings`}
                        target="_blank"
                        rel="noreferrer"
                        className="min-h-[36px] px-3 py-1.5 rounded-lg bg-[#E08E00] text-[#0F172A] font-extrabold text-xs inline-flex items-center"
                      >
                        Abrir Domínios Autorizados no Firebase Console ↗
                      </a>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </section>

        {/* Zero-State CSV Prompt when starting empty in Local Pilot */}
        {totalReferencesForService === 0 && (
          <section className="rounded-2xl bg-amber-50 border-2 border-[#E08E00] p-4 space-y-3">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-6 h-6 text-[#B45309] shrink-0 mt-0.5" />
              <div className="space-y-1">
                <h3 className="text-sm font-extrabold text-[#0F172A]">
                  Ponto de partida ({activeService === 'water' ? 'Água' : 'Gás'})
                  ainda sem CSV de referências anteriores
                </h3>
                <p className="text-xs text-slate-700 leading-relaxed">
                  O Piloto Local começa vazio. Você pode importar seu arquivo CSV
                  real (<code>Bloco;Apartamento;Anterior;Atual</code>), fazer a{' '}
                  <strong>Atualização / Carga Inicial</strong> se o outro
                  aparelho já importou na nuvem, ou carregar o CSV homologado de
                  teste (com Bloco 1, Apto 303, Gás = <code>266,0070</code>).
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={() => onOpenManagement('csv')}
                className="min-h-[44px] px-4 py-2 rounded-xl bg-[#0A2239] text-white font-bold text-xs flex items-center gap-1.5"
              >
                <FileSpreadsheet className="w-4 h-4" />
                <span>Importar meu CSV na Gestão</span>
              </button>
              <button
                type="button"
                onClick={handleQuickSeed}
                disabled={loadingQuickCsv}
                className="min-h-[44px] px-4 py-2 rounded-xl bg-[#E08E00] text-[#0F172A] font-extrabold text-xs flex items-center gap-1.5"
              >
                <span>
                  {loadingQuickCsv
                    ? 'Importando referências...'
                    : `Carregar CSV Homologado de ${
                        activeService === 'water' ? 'Água' : 'Gás (Apto 303 = 266,0070)'
                      }`}
                </span>
              </button>
            </div>
          </section>
        )}

        {/* Section Title matching PNG reference */}
        <div className="flex items-baseline justify-between pt-1">
          <h2 className="text-3xl font-extrabold tracking-tight text-[#0F172A]">
            Torres
          </h2>
          <span className="text-xs font-bold text-slate-600">
            Toque na torre para abrir os 20 apartamentos
          </span>
        </div>

        {/* 28 Towers Grid (3 columns on mobile, 4-7 columns on larger desktop viewports) */}
        <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-7 gap-3 pb-8">
          {towersProgress.map((tp) => {
            const isComplete = tp.readCount === tp.totalUnits;
            const isStarted = tp.readCount > 0 && !isComplete;
            const hasConflict = tp.conflictCount > 0;
            const hasAlert = tp.alertCount > 0;

            let badgeBg = 'bg-[#E2E8F0] text-[#475569]';
            if (hasConflict) {
              badgeBg = 'bg-[#FEE2E2] text-[#991B1B] border border-red-400';
            } else if (isComplete) {
              badgeBg = 'bg-[#DCFCE7] text-[#166534]';
            } else if (isStarted) {
              badgeBg = 'bg-[#FDE68A] text-[#78350F]';
            }

            return (
              <button
                key={tp.tower}
                type="button"
                onClick={() => onSelectTower(tp.tower)}
                className={`group rounded-2xl bg-white border-2 p-3 flex flex-col items-center justify-between min-h-[112px] shadow-2xs active:scale-[0.98] transition ${
                  hasConflict
                    ? 'border-red-600'
                    : isComplete
                    ? 'border-emerald-600'
                    : isStarted
                    ? 'border-[#E08E00]'
                    : 'border-slate-300 hover:border-slate-400'
                }`}
              >
                <div className="w-full flex items-center justify-between text-[11px] font-bold">
                  {tp.localOnlyCount > 0 ? (
                    <span
                      className="text-amber-800 truncate"
                      title={`${tp.localOnlyCount} leitura(s) apenas neste aparelho`}
                    >
                      {tp.localOnlyCount} local
                    </span>
                  ) : tp.syncedCount > 0 ? (
                    <span className="text-emerald-800 truncate">Nuvem</span>
                  ) : (
                    <span className="text-transparent select-none">·</span>
                  )}

                  {hasConflict ? (
                    <span className="text-red-700 font-extrabold">
                      Conflito
                    </span>
                  ) : hasAlert ? (
                    <span className="text-red-700 font-extrabold">
                      {tp.alertCount} alerta{tp.alertCount > 1 ? 's' : ''}
                    </span>
                  ) : null}
                </div>

                <span className="text-3xl font-extrabold font-mono tabular-nums text-[#0F172A] my-1">
                  {formatTowerNumber(tp.tower)}
                </span>

                <div
                  className={`w-full py-1 px-2 rounded-lg text-center font-mono tabular-nums font-bold text-sm ${badgeBg}`}
                >
                  {tp.readCount}/{tp.totalUnits}
                </div>
              </button>
            );
          })}
        </div>
      </main>
    </div>
  );
};
