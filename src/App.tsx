import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { User } from 'firebase/auth';
import { RotateCcw } from 'lucide-react';
import { ApartmentsScreen } from './components/ApartmentsScreen';
import { ErrorBoundary } from './components/ErrorBoundary';
import ManagementScreen, {
  type ManagementTab,
} from './components/ManagementScreen';
import { ReadingScreen } from './components/ReadingScreen';
import { TowersScreen } from './components/TowersScreen';
import {
  applyCsvImportAtomically,
  computeTowersProgress,
  ensureTrainingDatabaseSeeded,
  getAllDraftsForCycle,
  getOrInitCycleSettings,
  getReadingsForCycleService,
  getReferencesForCycleService,
  getSyncQueueForCycle,
} from './db/indexedDb';
import {
  activeFirebaseConfig,
  isFirebaseConfigured,
  signInWithGooglePilot,
  signOutPilot,
  subscribeToPilotAuth,
  testConnection,
} from './firebase/config';
import { executeExplicitIncrementalSync } from './firebase/syncEngine';
import { useOfflineReadiness } from './pwa/usePWAInstall';
import {
  CollectionOrderMode,
  CycleSettingsRecord,
  DEFAULT_ALERT_LIMITS,
  DraftRecord,
  OperatingMode,
  ReadingRecord,
  ReferenceRecord,
  SEQUENTIAL_APARTMENTS,
  ServiceType,
  formatTowerCode,
  formatTowerNumber,
} from './types/domain';
import {
  generateHomologatedPilotCsv,
  parseAndAnalyzeStartingCsv,
} from './utils/csvEngine';

type ScreenView = 'towers' | 'apartments' | 'reading' | 'management';

export default function App() {
  const [mode, setMode] = useState<OperatingMode>(() => {
    try {
      return localStorage.getItem('sn_leituras_mode') === 'training'
        ? 'training'
        : 'real';
    } catch {
      return 'real';
    }
  });

  const [cycleId, setCycleId] = useState<string>(() => {
    try {
      return localStorage.getItem('sn_leituras_cycle') || '2026-11';
    } catch {
      return '2026-11';
    }
  });

  const [activeService, setActiveService] = useState<ServiceType>(() => {
    try {
      return localStorage.getItem('sn_leituras_service') === 'water'
        ? 'water'
        : 'gas';
    } catch {
      return 'gas';
    }
  });

  const [orderMode, setOrderMode] = useState<CollectionOrderMode>('sequential');
  const [view, setView] = useState<ScreenView>('towers');
  const [selectedTower, setSelectedTower] = useState<number>(1);
  const [selectedApartment, setSelectedApartment] = useState<string>('101');
  const [managementTab, setManagementTab] = useState<ManagementTab>('review');
  const [managementOrderTower, setManagementOrderTower] = useState<
    number | undefined
  >(undefined);

  // Local IndexedDB lightweight cache state
  const [settings, setSettings] = useState<CycleSettingsRecord>({
    id: cycleId,
    condominiumId: 'campos-do-sul',
    cycleId,
    ...DEFAULT_ALERT_LIMITS,
    physicalOrders: {},
    revision: 0,
    revisionToken: '',
    baseRevisionToken: '',
    updatedByUid: 'local',
    updatedByName: 'Piloto Local',
    updatedAt: '',
    cursors: {},
    syncStatus: 'local_only',
  });

  const [waterReferences, setWaterReferences] = useState<
    Map<string, ReferenceRecord>
  >(() => new Map());
  const [gasReferences, setGasReferences] = useState<
    Map<string, ReferenceRecord>
  >(() => new Map());
  const [waterReadings, setWaterReadings] = useState<
    Map<string, ReadingRecord>
  >(() => new Map());
  const [gasReadings, setGasReadings] = useState<Map<string, ReadingRecord>>(
    () => new Map()
  );
  const [draftsMap, setDraftsMap] = useState<Map<string, DraftRecord>>(
    () => new Map()
  );
  const [pendingSyncCount, setPendingSyncCount] = useState<number>(0);

  // Firebase Auth & Sync State (Optional / Dual-reader)
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [isSyncing, setIsSyncing] = useState<boolean>(false);
  const [lastSyncMessage, setLastSyncMessage] = useState<string | null>(null);

  // All modules (Field, Management, PDF, ZIP) are bundled at top level for 100% offline readiness
  const prewarmModules = useCallback(async () => {
    return Promise.resolve();
  }, []);

  const { offlineReady } = useOfflineReadiness(prewarmModules);

  // Subscribe to Firebase Auth state (zero Firestore reads!)
  useEffect(() => {
    const unsub = subscribeToPilotAuth((u) => {
      setCurrentUser(u);
    });
    return () => unsub();
  }, []);

  // Load all lightweight metadata exclusively from IndexedDB (Cache-First, zero Firestore calls!)
  const refreshLocalState = useCallback(async () => {
    if (mode === 'training') {
      await ensureTrainingDatabaseSeeded(cycleId);
    }

    const [
      loadedSettings,
      wRefs,
      gRefs,
      wReads,
      gReads,
      allDrafts,
      queueItems,
    ] = await Promise.all([
      getOrInitCycleSettings(mode, cycleId),
      getReferencesForCycleService(mode, cycleId, 'water'),
      getReferencesForCycleService(mode, cycleId, 'gas'),
      getReadingsForCycleService(mode, cycleId, 'water'),
      getReadingsForCycleService(mode, cycleId, 'gas'),
      getAllDraftsForCycle(mode, cycleId),
      getSyncQueueForCycle(mode, cycleId),
    ]);

    setSettings(loadedSettings);
    setWaterReferences(wRefs);
    setGasReferences(gRefs);
    setWaterReadings(wReads);
    setGasReadings(gReads);

    const dMap = new Map<string, DraftRecord>();
    for (const d of allDrafts) {
      dMap.set(d.unitKey, d);
    }
    setDraftsMap(dMap);
    setPendingSyncCount(queueItems.length);
  }, [mode, cycleId]);

  useEffect(() => {
    refreshLocalState();
  }, [refreshLocalState]);

  const handleChangeMode = (nextMode: OperatingMode) => {
    setMode(nextMode);
    setView('towers');
    try {
      localStorage.setItem('sn_leituras_mode', nextMode);
    } catch {
      // ignore
    }
  };

  const handleChangeCycleId = (nextCycle: string) => {
    setCycleId(nextCycle);
    try {
      localStorage.setItem('sn_leituras_cycle', nextCycle);
    } catch {
      // ignore
    }
  };

  const handleSelectService = (svc: ServiceType) => {
    setActiveService(svc);
    try {
      localStorage.setItem('sn_leituras_service', svc);
    } catch {
      // ignore
    }
  };

  const authorUid =
    mode === 'training'
      ? 'treino_uid'
      : currentUser?.uid || 'leiturista_local';
  const authorName =
    mode === 'training'
      ? 'Leiturista Treino'
      : currentUser?.displayName ||
        currentUser?.email ||
        'Leiturista (Piloto Local)';

  const [authErrorCode, setAuthErrorCode] = useState<string | null>(null);

  const handleGoogleLogin = async () => {
    setLastSyncMessage(null);
    setAuthErrorCode(null);
    try {
      const user = await signInWithGooglePilot();
      setLastSyncMessage(
        `Autenticado como ${user.displayName || user.email} (UID: ${
          user.uid
        }). Toque em "Atualizar" para sincronizar.`
      );
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      const hostname =
        typeof window !== 'undefined'
          ? window.location.hostname
          : 'sn-leituras.vercel.app';
      if (rawMsg.includes('auth/unauthorized-domain')) {
        setAuthErrorCode('auth/unauthorized-domain');
        setLastSyncMessage(
          `O domínio "${hostname}" ainda não está autorizado no Firebase Authentication.`
        );
      } else if (rawMsg.includes('auth/popup-blocked')) {
        setAuthErrorCode('auth/popup-blocked');
        setLastSyncMessage(
          'O navegador bloqueou a janela pop-up do login Google. Permita pop-ups para este site e tente novamente.'
        );
      } else if (rawMsg.includes('auth/popup-closed-by-user')) {
        setLastSyncMessage('A janela de login Google foi fechada antes de concluir.');
      } else {
        setLastSyncMessage(`Falha no login Google: ${rawMsg}`);
      }
    }
  };

  const handleGoogleLogout = async () => {
    await signOutPilot();
    setLastSyncMessage(
      'Sessão Google encerrada. Os dados continuam disponíveis no aparelho.'
    );
  };

  /**
   * Explicit "Atualizar" synchronization button:
   * - Validates Firestore connectivity
   * - Pushes pending queue items WITHOUT pre-reads (rules validate revision)
   * - Pulls incremental deltas for settings, references (including CSV re-imports), and readings
   *   using full composite server cursors `{ seconds, nanoseconds, docId }`
   */
  const handleExplicitSync = async () => {
    if (mode !== 'real') return;
    setIsSyncing(true);
    setLastSyncMessage(null);
    try {
      await testConnection();
      const summary = await executeExplicitIncrementalSync(cycleId);
      await refreshLocalState();

      const parts: string[] = [];
      parts.push(
        `Enviados: ${summary.pushedReadings} leitura(s), ${summary.pushedReferences} lote(s) CSV, ${summary.pushedSettings} config`
      );
      parts.push(
        `Recebidos no delta: ${summary.pulledReadings} leitura(s), ${summary.pulledReferenceTowers} torre(s) CSV, ${summary.pulledSettings} config`
      );
      if (summary.recalculatedLocalReadingsFromCsvDelta > 0) {
        parts.push(
          `${summary.recalculatedLocalReadingsFromCsvDelta} leitura(s) recalculada(s) após reimportação de CSV`
        );
      }
      if (summary.conflictsDetected > 0) {
        parts.push(
          `${summary.conflictsDetected} conflito(s) preservado(s) com ambas as versões e fotos`
        );
      }
      setLastSyncMessage(`Sincronização incremental concluída — ${parts.join(' · ')}.`);
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : String(err);
      if (
        rawMsg.includes('permission-denied') ||
        rawMsg.includes('Missing or insufficient permissions')
      ) {
        setLastSyncMessage(
          `Acesso bloqueado pelas regras do Firestore. Cadastre seu UID (${
            currentUser?.uid || 'não autenticado'
          }) na lista fixa de 2 UIDs em firestore.rules e publique as regras.`
        );
      } else {
        setLastSyncMessage(`Erro na sincronização: ${rawMsg}`);
      }
      await refreshLocalState();
    } finally {
      setIsSyncing(false);
    }
  };

  const handleQuickLoadHomologatedCsv = async (service: ServiceType) => {
    const csvContent = generateHomologatedPilotCsv(service);
    const existingRefs = service === 'water' ? waterReferences : gasReferences;
    const existingReads = service === 'water' ? waterReadings : gasReadings;

    const preview = parseAndAnalyzeStartingCsv({
      csvContent,
      sourceFileName: `homologado_${service}_${cycleId}.csv`,
      service,
      cycleId,
      existingReferences: existingRefs,
      existingReadings: existingReads,
      limits: settings,
    });

    await applyCsvImportAtomically({
      mode,
      cycleId,
      service,
      sourceFileName: preview.sourceFileName,
      validRows: preview.validRows,
      applyToImpactedReadings: true,
      limits: settings,
      authorUid,
      authorName,
    });

    await refreshLocalState();
  };

  const activeReferencesMap =
    activeService === 'water' ? waterReferences : gasReferences;
  const activeReadingsMap =
    activeService === 'water' ? waterReadings : gasReadings;

  const towersProgress = useMemo(
    () =>
      computeTowersProgress(
        cycleId,
        activeService,
        activeReferencesMap,
        activeReadingsMap
      ),
    [cycleId, activeService, activeReferencesMap, activeReadingsMap]
  );

  // Ordered apartments for currently selected tower
  const orderedApartmentsForSelectedTower = useMemo(() => {
    const customOrder =
      settings.physicalOrders?.[formatTowerCode(selectedTower)];
    if (
      activeService === 'gas' &&
      orderMode === 'physical' &&
      Array.isArray(customOrder) &&
      customOrder.length === SEQUENTIAL_APARTMENTS.length
    ) {
      return customOrder;
    }
    return SEQUENTIAL_APARTMENTS;
  }, [activeService, orderMode, settings.physicalOrders, selectedTower]);

  // Most recent unsaved draft across the cycle (so user can resume with 1 tap on reopen!)
  const latestPendingDraft = useMemo(() => {
    if (draftsMap.size === 0) return null;
    const list = Array.from(draftsMap.values());
    list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return list[0];
  }, [draftsMap]);

  return (
    <ErrorBoundary>
      {/* Top Resumption Banner when reopening app with an unsaved draft */}
      {latestPendingDraft && view !== 'reading' && (
        <div className="bg-amber-100 border-b-2 border-[#E08E00] px-4 py-2.5 text-[#0F172A]">
          <div className="max-w-5xl mx-auto flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2 font-bold">
              <RotateCcw className="w-4 h-4 text-[#B45309] shrink-0" />
              <span>
                Rascunho em aberto encontrado no aparelho: Torre{' '}
                {formatTowerNumber(latestPendingDraft.tower)} • Apto{' '}
                {latestPendingDraft.apartment} (
                {latestPendingDraft.service === 'water' ? 'Água' : 'Gás'})
              </span>
            </div>
            <button
              type="button"
              onClick={() => {
                handleSelectService(latestPendingDraft.service);
                setSelectedTower(latestPendingDraft.tower);
                setSelectedApartment(latestPendingDraft.apartment);
                setView('reading');
              }}
              className="min-h-[36px] px-3 py-1 rounded-lg bg-[#0A2239] text-white font-extrabold text-xs"
            >
              Retomar Rascunho Agora
            </button>
          </div>
        </div>
      )}

      {view === 'towers' && (
        <TowersScreen
          mode={mode}
          onToggleTrainingMode={handleChangeMode}
          cycleId={cycleId}
          onChangeCycleId={handleChangeCycleId}
          activeService={activeService}
          onSelectService={handleSelectService}
          towersProgress={towersProgress}
          waterTotalRead={waterReadings.size}
          gasTotalRead={gasReadings.size}
          pendingSyncCount={pendingSyncCount}
          totalReferencesForService={activeReferencesMap.size}
          offlineReady={offlineReady}
          firebaseConfigured={isFirebaseConfigured}
          activeFirebaseProjectId={activeFirebaseConfig.projectId}
          authErrorCode={authErrorCode}
          currentUser={currentUser}
          onGoogleLogin={handleGoogleLogin}
          onGoogleLogout={handleGoogleLogout}
          onExplicitSync={handleExplicitSync}
          isSyncing={isSyncing}
          lastSyncMessage={lastSyncMessage}
          onSelectTower={(tower) => {
            setSelectedTower(tower);
            setView('apartments');
          }}
          onOpenManagement={(tab) => {
            setManagementTab(tab || 'review');
            setManagementOrderTower(undefined);
            setView('management');
          }}
          onQuickLoadHomologatedCsv={handleQuickLoadHomologatedCsv}
        />
      )}

      {view === 'apartments' && (
        <ApartmentsScreen
          mode={mode}
          cycleId={cycleId}
          tower={selectedTower}
          activeService={activeService}
          onSelectService={handleSelectService}
          orderMode={orderMode}
          onChangeOrderMode={setOrderMode}
          configuredPhysicalOrder={
            settings.physicalOrders?.[formatTowerCode(selectedTower)]
          }
          referencesMap={activeReferencesMap}
          readingsMap={activeReadingsMap}
          draftsMap={draftsMap}
          currentUserUid={authorUid}
          onBackToTowers={() => setView('towers')}
          onSelectApartment={(apt) => {
            setSelectedApartment(apt);
            setView('reading');
          }}
          onOpenManagementOrderConfig={(tower) => {
            setManagementTab('order');
            setManagementOrderTower(tower);
            setView('management');
          }}
          onOpenManagement={() => {
            setManagementTab('review');
            setManagementOrderTower(undefined);
            setView('management');
          }}
        />
      )}

      {view === 'reading' && (
        <ReadingScreen
          mode={mode}
          cycleId={cycleId}
          tower={selectedTower}
          apartment={selectedApartment}
          orderedApartments={orderedApartmentsForSelectedTower}
          service={activeService}
          limits={settings}
          reference={activeReferencesMap.get(
            `${cycleId}_${activeService}_${formatTowerCode(
              selectedTower
            )}_A${selectedApartment}`
          )}
          existingReading={activeReadingsMap.get(
            `${cycleId}_${activeService}_${formatTowerCode(
              selectedTower
            )}_A${selectedApartment}`
          )}
          allTowerReadings={activeReadingsMap}
          authorUid={authorUid}
          authorName={authorName}
          onBackToApartments={() => setView('apartments')}
          onSavedAndNavigateNext={(nextApt) => {
            if (nextApt) {
              setSelectedApartment(nextApt);
            } else {
              setView('apartments');
            }
          }}
          onRefreshState={refreshLocalState}
        />
      )}

      {view === 'management' && (
        <ManagementScreen
          mode={mode}
          initialTab={managementTab}
          initialOrderTower={managementOrderTower}
          cycleId={cycleId}
          activeService={activeService}
          onSelectService={handleSelectService}
          settings={settings}
          waterReferences={waterReferences}
          gasReferences={gasReferences}
          waterReadings={waterReadings}
          gasReadings={gasReadings}
          authorUid={authorUid}
          authorName={authorName}
          onBackToField={() => setView('towers')}
          onOpenReadingFromManagement={(svc, t, apt) => {
            handleSelectService(svc);
            setSelectedTower(t);
            setSelectedApartment(apt);
            setView('reading');
          }}
          onRefreshState={refreshLocalState}
        />
      )}
    </ErrorBoundary>
  );
}
