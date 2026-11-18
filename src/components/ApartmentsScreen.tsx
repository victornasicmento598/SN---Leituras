import React, { useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ChevronRight,
  Download,
  FileText,
  Settings,
  Smartphone,
  UserCheck,
} from 'lucide-react';
import {
  CollectionOrderMode,
  DraftRecord,
  OperatingMode,
  ReadingRecord,
  ReferenceRecord,
  SEQUENTIAL_APARTMENTS,
  ServiceType,
  buildUnitKey,
  formatTowerCode,
  formatTowerNumber,
} from '../types/domain';
import {
  generateTowerBackupZip,
  triggerBlobDownload,
} from '../utils/backupZipEngine';
import {
  formatAlertLabel,
  formatCurrencyBrl,
  formatDecimal4,
} from '../utils/consumptionEngine';
import { generateTowerA4ColorPdfBlob } from '../utils/pdfReportEngine';
import { ServiceToggleBar } from './ServiceToggleBar';

interface ApartmentsScreenProps {
  mode: OperatingMode;
  cycleId: string;
  tower: number;
  activeService: ServiceType;
  onSelectService: (service: ServiceType) => void;
  orderMode: CollectionOrderMode;
  onChangeOrderMode: (mode: CollectionOrderMode) => void;
  configuredPhysicalOrder: string[] | undefined;
  referencesMap: Map<string, ReferenceRecord>;
  readingsMap: Map<string, ReadingRecord>;
  draftsMap: Map<string, DraftRecord>;
  currentUserUid: string;
  onBackToTowers: () => void;
  onSelectApartment: (apartment: string) => void;
  onOpenManagementOrderConfig: (tower: number) => void;
  onOpenManagement: () => void;
}

export const ApartmentsScreen: React.FC<ApartmentsScreenProps> = ({
  mode,
  cycleId,
  tower,
  activeService,
  onSelectService,
  orderMode,
  onChangeOrderMode,
  configuredPhysicalOrder,
  referencesMap,
  readingsMap,
  draftsMap,
  currentUserUid,
  onBackToTowers,
  onSelectApartment,
  onOpenManagementOrderConfig,
  onOpenManagement,
}) => {
  const [authorFilter, setAuthorFilter] = useState<'all' | 'mine'>('all');
  const [isGeneratingZip, setIsGeneratingZip] = useState(false);
  const [isGeneratingPdf, setIsGeneratingPdf] = useState(false);
  const [pdfProgressLabel, setPdfProgressLabel] = useState<string | null>(null);
  const [backupMessage, setBackupMessage] = useState<string | null>(null);

  const hasCustomPhysicalOrder =
    Array.isArray(configuredPhysicalOrder) &&
    configuredPhysicalOrder.length === SEQUENTIAL_APARTMENTS.length;

  // Use physical order only when Gás is selected, user picked 'physical', and order is configured
  const orderedApartments: readonly string[] =
    activeService === 'gas' &&
    orderMode === 'physical' &&
    hasCustomPhysicalOrder
      ? configuredPhysicalOrder!
      : SEQUENTIAL_APARTMENTS;

  const filteredApartments = orderedApartments.filter((apt) => {
    if (authorFilter === 'all') return true;
    const unitId = buildUnitKey(cycleId, activeService, tower, apt);
    const reading = readingsMap.get(unitId);
    if (!reading) return false;
    return (
      reading.createdByUid === currentUserUid ||
      reading.updatedByUid === currentUserUid
    );
  });

  const handleTowerBackupZip = async () => {
    setIsGeneratingZip(true);
    setBackupMessage(null);
    try {
      const res = await generateTowerBackupZip({
        mode,
        cycleId,
        service: activeService,
        towers: [tower],
      });
      triggerBlobDownload(res.zipBlob, res.fileName);
      setBackupMessage(
        `Backup ZIP gerado (${res.readingsCount} leitura(s), ${res.photosCount} foto(s)): ${res.fileName}`
      );
    } catch (err) {
      setBackupMessage(
        err instanceof Error
          ? `Erro ao gerar backup: ${err.message}`
          : 'Erro ao gerar backup da torre.'
      );
    } finally {
      setIsGeneratingZip(false);
    }
  };

  const handleTowerPdfReport = async () => {
    setIsGeneratingPdf(true);
    setPdfProgressLabel('Iniciando PDF colorido...');
    setBackupMessage(null);
    try {
      const res = await generateTowerA4ColorPdfBlob({
        mode,
        cycleId,
        service: activeService,
        tower,
        referencesMap,
        readingsMap,
        onProgress: (p) => {
          setPdfProgressLabel(
            `PDF (${p.currentReadingIndex}/${p.totalReadings} • ${p.embeddedPhotosCount} fotos)`
          );
        },
      });
      triggerBlobDownload(res.pdfBlob, res.fileName);
      setBackupMessage(
        `Relatório PDF A4 Colorido gerado (${res.embeddedPhotosCount} foto(s) incluída(s)): ${res.fileName}`
      );
    } catch (err) {
      setBackupMessage(
        err instanceof Error
          ? `Erro ao gerar PDF: ${err.message}`
          : 'Erro ao gerar PDF da torre.'
      );
    } finally {
      setIsGeneratingPdf(false);
      setPdfProgressLabel(null);
    }
  };

  let readCount = 0;
  let localOnlyCount = 0;
  let conflictCount = 0;
  for (const apt of SEQUENTIAL_APARTMENTS) {
    const r = readingsMap.get(buildUnitKey(cycleId, activeService, tower, apt));
    if (r) {
      readCount++;
      if (r.syncStatus === 'local_only') localOnlyCount++;
      if (r.syncStatus === 'conflict') conflictCount++;
    }
  }

  return (
    <div className="min-h-screen flex flex-col bg-[#F4F6F9] text-[#0F172A]">
      {/* Top Bar matching the middle screen of the PNG reference */}
      <header className="sticky top-0 z-30 bg-[#0A2239] text-white shadow-md">
        <div className="max-w-3xl mx-auto px-4 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={onBackToTowers}
              aria-label="Voltar para Torres"
              className="min-h-[44px] min-w-[44px] -ml-2 rounded-xl flex items-center justify-center hover:bg-white/10 active:bg-white/20 transition"
            >
              <ArrowLeft className="w-6 h-6" />
            </button>
            <h1 className="text-xl font-extrabold tracking-tight truncate">
              Torre {formatTowerNumber(tower)}
            </h1>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs font-mono font-bold bg-white/15 px-2.5 py-1 rounded-lg">
              {readCount}/20
            </span>
            <button
              type="button"
              onClick={onOpenManagement}
              className="min-h-[44px] px-3 py-2 rounded-xl bg-white/15 hover:bg-white/25 text-white font-bold text-xs flex items-center gap-1.5 transition"
            >
              <Settings className="w-4 h-4" />
              <span>Gestão</span>
            </button>
          </div>
        </div>
      </header>

      <main className="flex-1 max-w-3xl w-full mx-auto px-4 py-4 space-y-4">
        {/* Unified Água / Gás Toggle Bar */}
        <ServiceToggleBar
          activeService={activeService}
          onSelectService={onSelectService}
        />

        {/* Heading & Tower sync counters */}
        <div className="flex flex-wrap items-baseline justify-between gap-2 pt-1">
          <h2 className="text-3xl font-extrabold tracking-tight text-[#0F172A]">
            Apartamentos
          </h2>
          <div className="flex items-center gap-2 text-xs font-bold text-slate-600">
            <span>{readCount}/20 lidas</span>
            {localOnlyCount > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-amber-800">
                  {localOnlyCount} apenas no aparelho
                </span>
              </>
            )}
            {conflictCount > 0 && (
              <>
                <span aria-hidden="true">·</span>
                <span className="text-red-700 font-extrabold">
                  {conflictCount} conflito(s)
                </span>
              </>
            )}
          </div>
        </div>

        {/* Collection Order Selector (Gás) & Author Filter */}
        <div className="space-y-2.5">
          {activeService === 'gas' && (
            <div className="space-y-1.5">
              <div className="flex items-stretch rounded-xl border border-slate-300 bg-white overflow-hidden">
                <span className="px-3.5 py-2.5 bg-slate-100 text-xs font-bold text-slate-700 flex items-center border-r border-slate-300 whitespace-nowrap">
                  Ordem de coleta
                </span>
                <select
                  aria-label="Ordem de coleta de Gás"
                  value={orderMode}
                  onChange={(e) =>
                    onChangeOrderMode(e.target.value as CollectionOrderMode)
                  }
                  className="flex-1 min-h-[44px] px-3 py-2 bg-white text-sm font-bold text-[#0F172A] focus:outline-none"
                >
                  <option value="sequential">Sequencial (101 a 504)</option>
                  <option value="physical">
                    Disposição Física do Painel{' '}
                    {hasCustomPhysicalOrder
                      ? `(${formatTowerCode(tower)} configurada)`
                      : '(Padrão sequencial até cadastrar)'}
                  </option>
                </select>
              </div>

              {orderMode === 'physical' && !hasCustomPhysicalOrder && (
                <div className="flex items-center justify-between gap-2 rounded-xl bg-amber-50 border border-amber-300 px-3 py-2 text-xs">
                  <span className="text-amber-950 font-semibold">
                    A ordem física da Torre {formatTowerNumber(tower)} ainda não
                    foi cadastrada. Usando ordem sequencial.
                  </span>
                  <button
                    type="button"
                    onClick={() => onOpenManagementOrderConfig(tower)}
                    className="font-extrabold text-[#0A2239] underline whitespace-nowrap"
                  >
                    Configurar na Gestão
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Authorship Filter for Dual-Reader validation */}
          <div className="flex items-center justify-between gap-2">
            <div className="inline-flex rounded-xl bg-slate-200/80 p-1">
              <button
                type="button"
                onClick={() => setAuthorFilter('all')}
                className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                  authorFilter === 'all'
                    ? 'bg-white text-[#0F172A] shadow-2xs'
                    : 'text-slate-700 hover:text-[#0F172A]'
                }`}
              >
                Todas as leituras
              </button>
              <button
                type="button"
                onClick={() => setAuthorFilter('mine')}
                className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition ${
                  authorFilter === 'mine'
                    ? 'bg-white text-[#0F172A] shadow-2xs'
                    : 'text-slate-700 hover:text-[#0F172A]'
                }`}
              >
                <UserCheck className="w-3.5 h-3.5" />
                <span>Minhas leituras</span>
              </button>
            </div>

            <button
              type="button"
              onClick={handleTowerPdfReport}
              disabled={isGeneratingPdf}
              className="min-h-[38px] px-3 py-1.5 rounded-xl border border-[#0A2239] bg-white hover:bg-slate-50 text-xs font-extrabold text-[#0A2239] flex items-center gap-1.5"
            >
              <FileText className="w-3.5 h-3.5" />
              <span>
                {isGeneratingPdf
                  ? pdfProgressLabel || 'Gerando PDF...'
                  : 'PDF A4 Colorido'}
              </span>
            </button>
          </div>
        </div>

        {/* Apartments List matching PNG reference */}
        <div className="space-y-2.5">
          {filteredApartments.length === 0 ? (
            <div className="rounded-2xl bg-white border border-slate-300 p-6 text-center text-sm font-semibold text-slate-600">
              Nenhuma leitura encontrada para o filtro "Minhas leituras" nesta
              torre.
            </div>
          ) : (
            filteredApartments.map((apt) => {
              const unitId = buildUnitKey(cycleId, activeService, tower, apt);
              const ref = referencesMap.get(unitId);
              const reading = readingsMap.get(unitId);
              const draft = draftsMap.get(unitId);

              const hasConflict = reading?.syncStatus === 'conflict';
              const hasAlert = reading?.status === 'alert';
              const isRead = Boolean(reading);

              let statusLabel = 'Pendente';
              let statusBadgeClass = 'bg-[#FDE68A] text-[#78350F]';

              if (hasConflict) {
                statusLabel = 'Conflito';
                statusBadgeClass =
                  'bg-[#FEE2E2] text-[#991B1B] border border-red-400';
              } else if (hasAlert) {
                statusLabel = 'Alerta';
                statusBadgeClass =
                  'bg-[#FEE2E2] text-[#991B1B] border border-red-300';
              } else if (isRead) {
                statusLabel = 'Lida';
                statusBadgeClass = 'bg-[#DCFCE7] text-[#166534]';
              }

              return (
                <button
                  key={apt}
                  type="button"
                  onClick={() => onSelectApartment(apt)}
                  className={`w-full rounded-2xl bg-white border-2 px-4 py-3 flex items-center justify-between gap-3 shadow-2xs active:scale-[0.99] transition text-left ${
                    hasConflict
                      ? 'border-red-600'
                      : hasAlert
                      ? 'border-red-400'
                      : isRead
                      ? 'border-emerald-600/60'
                      : 'border-slate-300 hover:border-slate-400'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-2xl font-extrabold font-mono tabular-nums text-[#0F172A]">
                        {apt}
                      </span>

                      {reading ? (
                        <span className="text-xs font-mono tabular-nums font-bold text-slate-700">
                          {formatDecimal4(reading.currentValue, true)} m³
                          {reading.consumption !== null && (
                            <span className="text-slate-500">
                              {' '}
                              (Δ {formatDecimal4(reading.consumption, true)} m³)
                            </span>
                          )}
                          {reading.calculatedAmountBrl !== null &&
                          reading.calculatedAmountBrl !== undefined ? (
                            <span className="text-emerald-800 font-extrabold">
                              {' '}
                              • {formatCurrencyBrl(reading.calculatedAmountBrl)}
                            </span>
                          ) : reading.amountUnavailableReason ? (
                            <span className="text-amber-800 font-sans font-bold">
                              {' '}
                              • {reading.amountUnavailableReason}
                            </span>
                          ) : null}
                        </span>
                      ) : ref && ref.previousValue !== null ? (
                        <span className="text-xs font-mono tabular-nums font-semibold text-slate-500">
                          Ant: {formatDecimal4(ref.previousValue, true)} m³
                        </span>
                      ) : (
                        <span className="text-xs font-semibold text-amber-800">
                          Sem leitura anterior
                        </span>
                      )}
                    </div>

                    {/* Second line: sync origin, draft indicator, authorship, or alert summary */}
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-semibold text-slate-600">
                      {reading && (
                        <>
                          {reading.syncStatus === 'local_only' && (
                            <span className="inline-flex items-center gap-1 text-amber-800 font-bold">
                              <Smartphone className="w-3 h-3" />
                              <span>Salva no aparelho</span>
                            </span>
                          )}
                          {reading.syncStatus === 'synced' && (
                            <span className="text-emerald-800 font-bold">
                              Sincronizada
                            </span>
                          )}
                          {reading.syncStatus === 'conflict' && (
                            <span className="inline-flex items-center gap-1 text-red-700 font-extrabold">
                              <AlertTriangle className="w-3 h-3" />
                              <span>
                                Conflito entre aparelhos (preservadas 2 versões)
                              </span>
                            </span>
                          )}
                          <span aria-hidden="true">·</span>
                          <span>
                            Autor: {reading.createdByName}
                            {reading.updatedByUid !== reading.createdByUid &&
                              ` (Editado por ${reading.updatedByName})`}
                          </span>
                        </>
                      )}

                      {!reading && draft && (
                        <span className="text-amber-800 font-bold">
                          Rascunho salvo no aparelho ({draft.currentValueInput || 'foto'})
                        </span>
                      )}

                      {reading && reading.alerts.length > 0 && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-red-700 font-bold">
                            {reading.alerts.map(formatAlertLabel).join(', ')}
                          </span>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2.5 shrink-0">
                    <span
                      className={`px-3 py-1 rounded-lg text-xs font-extrabold ${statusBadgeClass}`}
                    >
                      {statusLabel}
                    </span>
                    <ChevronRight className="w-5 h-5 text-slate-600" />
                  </div>
                </button>
              );
            })
          )}
        </div>

        {backupMessage && (
          <div className="rounded-xl bg-emerald-50 border border-emerald-400 px-3.5 py-2.5 text-xs font-bold text-emerald-950">
            {backupMessage}
          </div>
        )}

        {/* Bottom Tower Backup Button matching PNG reference */}
        <div className="pt-2 pb-8">
          <button
            type="button"
            onClick={handleTowerBackupZip}
            disabled={isGeneratingZip}
            className="w-full min-h-[54px] rounded-2xl bg-white hover:bg-slate-50 active:scale-[0.99] border-2 border-[#0A2239] text-[#0A2239] font-extrabold text-base flex items-center justify-center gap-2.5 shadow-xs transition"
          >
            <Download className="w-5 h-5 shrink-0" />
            <span>
              {isGeneratingZip
                ? 'Gerando ZIP com JPEGs e Manifesto...'
                : 'Backup da torre'}
            </span>
          </button>
        </div>
      </main>
    </div>
  );
};
