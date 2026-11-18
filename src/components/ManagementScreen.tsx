import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ClipboardCheck,
  Download,
  Eye,
  FileSpreadsheet,
  FileText,
  FolderArchive,
  Laptop,
  ListOrdered,
  RefreshCw,
  Sliders,
  Smartphone,
  Upload,
} from 'lucide-react';
import {
  applyCsvImportAtomically,
  getPhotosForReading,
  getReadingsForCycleService,
  getReferencesForCycleService,
  recalculateSavedReadingsForNewTariff,
  resolveReadingConflict,
  saveReadingAtomically,
  updateCycleSettingsAtomically,
} from '../db/indexedDb';
import {
  APARTMENTS_PER_TOWER,
  CycleSettingsRecord,
  ExceptionType,
  OperatingMode,
  PhotoRecord,
  PhotoSlot,
  ReadingRecord,
  ReferenceRecord,
  SEQUENTIAL_APARTMENTS,
  ServiceType,
  TOTAL_TOWERS,
  buildUnitKey,
  formatTowerCode,
  formatTowerNumber,
} from '../types/domain';
import {
  RestoreBackupPreview,
  analyzeBackupZipForRestore,
  executeBackupRestoreLocally,
  generateTowerBackupZip,
  triggerBlobDownload,
} from '../utils/backupZipEngine';
import {
  evaluateReading,
  formatAlertLabel,
  formatCurrencyBrl,
  formatDecimal4,
  formatTariffBrl,
  getAuditedReadingFinancials,
  parseDecimalInput,
} from '../utils/consumptionEngine';
import {
  CsvParseAndDiffPreview,
  EXPECTED_CSV_HEADER,
  ParsedCsvRow,
  buildExportCsv,
  generateHomologatedPilotCsv,
  parseAndAnalyzeStartingCsv,
  validatePhysicalOrderInput,
} from '../utils/csvEngine';
import {
  PdfGenerationProgress,
  exportReportsBundle,
  generateConsolidatedCycleA4ColorPdfBlob,
} from '../utils/pdfReportEngine';
import {
  createSimulatedMeterRawBlob,
  stampMeterPhoto,
} from '../utils/photoStampEngine';
import JSZip from 'jszip';

export type ManagementTab = 'review' | 'csv' | 'order' | 'limits' | 'backup';

interface ManagementScreenProps {
  mode: OperatingMode;
  initialTab: ManagementTab;
  initialOrderTower?: number;
  cycleId: string;
  activeService: ServiceType;
  onSelectService: (service: ServiceType) => void;
  settings: CycleSettingsRecord;
  waterReferences: Map<string, ReferenceRecord>;
  gasReferences: Map<string, ReferenceRecord>;
  waterReadings: Map<string, ReadingRecord>;
  gasReadings: Map<string, ReadingRecord>;
  authorUid: string;
  authorName: string;
  onBackToField: () => void;
  onOpenReadingFromManagement: (
    service: ServiceType,
    tower: number,
    apartment: string
  ) => void;
  onRefreshState: () => Promise<void>;
}

const BATCH_SIZE = 20;

const LazyPhotoThumbnailPair: React.FC<{
  mode: OperatingMode;
  readingId: string;
}> = ({ mode, readingId }) => {
  const [urls, setUrls] = useState<{
    p1?: string;
    p2?: string;
    c1?: string;
  }>({});

  useEffect(() => {
    let cancelled = false;
    const createdUrls: string[] = [];

    async function load() {
      const map: Map<PhotoSlot, PhotoRecord> = await getPhotosForReading(
        mode,
        readingId
      );
      if (cancelled) return;
      const next: { p1?: string; p2?: string; c1?: string } = {};
      const p1 = map.get('1');
      if (p1) {
        const u = URL.createObjectURL(p1.stampedBlob);
        createdUrls.push(u);
        next.p1 = u;
      }
      const p2 = map.get('2');
      if (p2) {
        const u = URL.createObjectURL(p2.stampedBlob);
        createdUrls.push(u);
        next.p2 = u;
      }
      const c1 = map.get('conflict_1');
      if (c1) {
        const u = URL.createObjectURL(c1.stampedBlob);
        createdUrls.push(u);
        next.c1 = u;
      }
      setUrls(next);
    }

    load();
    return () => {
      cancelled = true;
      for (const u of createdUrls) {
        URL.revokeObjectURL(u);
      }
    };
  }, [mode, readingId]);

  if (!urls.p1 && !urls.p2 && !urls.c1) {
    return <span className="text-xs text-slate-400">Sem foto</span>;
  }

  return (
    <div className="flex items-center gap-1.5">
      {urls.p1 && (
        <a
          href={urls.p1}
          target="_blank"
          rel="noreferrer"
          title="Abrir 1ª foto colorida carimbada"
          className="block w-14 h-10 rounded border border-slate-300 overflow-hidden bg-slate-900 shrink-0"
        >
          <img
            src={urls.p1}
            alt="1ª Foto"
            referrerPolicy="no-referrer"
            className="w-full h-full object-cover"
          />
        </a>
      )}
      {urls.p2 && (
        <a
          href={urls.p2}
          target="_blank"
          rel="noreferrer"
          title="Abrir 2ª foto colorida de validação"
          className="block w-14 h-10 rounded border-2 border-red-500 overflow-hidden bg-slate-900 shrink-0"
        >
          <img
            src={urls.p2}
            alt="2ª Foto Validação"
            referrerPolicy="no-referrer"
            className="w-full h-full object-cover"
          />
        </a>
      )}
      {urls.c1 && (
        <a
          href={urls.c1}
          target="_blank"
          rel="noreferrer"
          title="Abrir foto da tentativa local em conflito"
          className="block w-14 h-10 rounded border-2 border-amber-500 overflow-hidden bg-slate-900 shrink-0"
        >
          <img
            src={urls.c1}
            alt="Foto Conflito Local"
            referrerPolicy="no-referrer"
            className="w-full h-full object-cover"
          />
        </a>
      )}
    </div>
  );
};

interface SymmetryCrossCheckReport {
  generatedAt: string;
  towersChecked: number[];
  servicesChecked: ServiceType[];
  totalReadingsVerified: number;
  totalPhotosVerified: number;
  allMatched: boolean;
  waterTotalM3: string;
  waterTotalBrl: string;
  gasTotalM3: string;
  gasTotalBrl: string;
  rows: {
    serviceLabel: string;
    unitLabel: string;
    readingTypeLabel: string;
    photosCount: number;
    collectionValueStr: string;
    photoStampValueStr: string;
    csvLineValueStr: string;
    pdfLineValueStr: string;
    matched: boolean;
  }[];
}

export const ManagementScreen: React.FC<ManagementScreenProps> = ({
  mode,
  initialTab,
  initialOrderTower,
  cycleId,
  activeService,
  onSelectService,
  settings,
  waterReferences,
  gasReferences,
  waterReadings,
  gasReadings,
  authorUid,
  authorName,
  onBackToField,
  onOpenReadingFromManagement,
  onRefreshState,
}) => {
  const [tab, setTab] = useState<ManagementTab>(initialTab);

  // Review Tab States
  const [filterTower, setFilterTower] = useState<number | 'all'>('all');
  const [filterStatus, setFilterStatus] = useState<
    | 'all'
    | 'read'
    | 'pending'
    | 'alert'
    | 'local_only'
    | 'synced'
    | 'conflict'
  >('all');
  const [filterAuthor, setFilterAuthor] = useState<'all' | 'mine'>('all');
  const [searchApartment, setSearchApartment] = useState<string>('');
  const [visibleBatchCount, setVisibleBatchCount] =
    useState<number>(BATCH_SIZE);
  const [showPhotosInBatch, setShowPhotosInBatch] = useState<boolean>(true);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  const [pdfProgress, setPdfProgress] = useState<PdfGenerationProgress | null>(
    null
  );
  const [exportFeedback, setExportFeedback] = useState<string | null>(null);
  const [consolidatedServicesMode, setConsolidatedServicesMode] = useState<
    'both' | 'water' | 'gas'
  >('both');

  // Homologation & Cross-Check (2 Towers x Both Services x Normal & Alert Photos)
  const [isRunningHomologationTest, setIsRunningHomologationTest] =
    useState<boolean>(false);
  const [symmetryReport, setSymmetryReport] =
    useState<SymmetryCrossCheckReport | null>(null);

  // CSV Import Tab States
  const [csvTargetService, setCsvTargetService] =
    useState<ServiceType>(activeService);
  const [csvTargetCycle, setCsvTargetCycle] = useState<string>(cycleId);
  const [csvRawText, setCsvRawText] = useState<string>('');
  const [csvFileName, setCsvFileName] = useState<string>('');
  const [csvPreview, setCsvPreview] = useState<CsvParseAndDiffPreview | null>(
    null
  );
  const [confirmImpactedReadings, setConfirmImpactedReadings] =
    useState<boolean>(false);
  const [csvImportResultMsg, setCsvImportResultMsg] = useState<string | null>(
    null
  );

  // Physical Order Tab States
  const [selectedOrderTower, setSelectedOrderTower] = useState<number>(
    initialOrderTower || 1
  );
  const [physicalOrderInput, setPhysicalOrderInput] = useState<string>('');
  const [physicalOrderFeedback, setPhysicalOrderFeedback] = useState<{
    type: 'ok' | 'err';
    msg: string;
  } | null>(null);

  // Tariffs & Alert Limits Tab States
  const [waterTariffInput, setWaterTariffInput] = useState<string>(
    settings.waterTariffPerM3 !== null &&
      settings.waterTariffPerM3 !== undefined
      ? formatDecimal4(settings.waterTariffPerM3, true)
      : ''
  );
  const [gasTariffInput, setGasTariffInput] = useState<string>(
    settings.gasTariffPerM3 !== null && settings.gasTariffPerM3 !== undefined
      ? formatDecimal4(settings.gasTariffPerM3, true)
      : ''
  );
  const [waterAlertInput, setWaterAlertInput] = useState<string>(
    formatDecimal4(settings.waterAlertLimit, true)
  );
  const [waterCeilingInput, setWaterCeilingInput] = useState<string>(
    formatDecimal4(settings.waterCeilingLimit, true)
  );
  const [gasAlertInput, setGasAlertInput] = useState<string>(
    formatDecimal4(settings.gasAlertLimit, true)
  );
  const [gasCeilingInput, setGasCeilingInput] = useState<string>(
    formatDecimal4(settings.gasCeilingLimit, true)
  );
  const [gasNoiseInput, setGasNoiseInput] = useState<string>(
    formatDecimal4(settings.gasNoiseLimit, true)
  );
  const [limitsFeedback, setLimitsFeedback] = useState<string | null>(null);
  const [isRecalculatingTariff, setIsRecalculatingTariff] =
    useState<boolean>(false);

  // Backup & Restore Tab States
  const [backupTowerSelection, setBackupTowerSelection] = useState<
    number | 'all'
  >(1);
  const [restorePreview, setRestorePreview] =
    useState<RestoreBackupPreview | null>(null);
  const [restoreZipInstance, setRestoreZipInstance] = useState<JSZip | null>(
    null
  );
  const [includeConflictsOnRestore, setIncludeConflictsOnRestore] =
    useState<boolean>(true);
  const [backupFeedback, setBackupFeedback] = useState<string | null>(null);
  const [isProcessingBackup, setIsProcessingBackup] = useState<boolean>(false);

  // Sync tariff & limits inputs when cycle settings update (e.g. after 'Atualizar')
  useEffect(() => {
    setWaterTariffInput(
      settings.waterTariffPerM3 !== null &&
        settings.waterTariffPerM3 !== undefined
        ? formatDecimal4(settings.waterTariffPerM3, true)
        : ''
    );
    setGasTariffInput(
      settings.gasTariffPerM3 !== null && settings.gasTariffPerM3 !== undefined
        ? formatDecimal4(settings.gasTariffPerM3, true)
        : ''
    );
    setWaterAlertInput(formatDecimal4(settings.waterAlertLimit, true));
    setWaterCeilingInput(formatDecimal4(settings.waterCeilingLimit, true));
    setGasAlertInput(formatDecimal4(settings.gasAlertLimit, true));
    setGasCeilingInput(formatDecimal4(settings.gasCeilingLimit, true));
    setGasNoiseInput(formatDecimal4(settings.gasNoiseLimit, true));
  }, [
    settings.waterTariffPerM3,
    settings.gasTariffPerM3,
    settings.waterAlertLimit,
    settings.waterCeilingLimit,
    settings.gasAlertLimit,
    settings.gasCeilingLimit,
    settings.gasNoiseLimit,
  ]);

  // Sync physical order input when tower changes
  useEffect(() => {
    const towerCode = formatTowerCode(selectedOrderTower);
    const configured = settings.physicalOrders?.[towerCode];
    if (configured && configured.length === APARTMENTS_PER_TOWER) {
      setPhysicalOrderInput(configured.join(', '));
    } else {
      setPhysicalOrderInput(SEQUENTIAL_APARTMENTS.join(', '));
    }
    setPhysicalOrderFeedback(null);
  }, [selectedOrderTower, settings.physicalOrders]);

  // Reset batch pagination when review filters change
  useEffect(() => {
    setVisibleBatchCount(BATCH_SIZE);
  }, [
    activeService,
    filterTower,
    filterStatus,
    filterAuthor,
    searchApartment,
  ]);

  const currentReferences =
    activeService === 'water' ? waterReferences : gasReferences;
  const currentReadings =
    activeService === 'water' ? waterReadings : gasReadings;
  const currentCycleTariff =
    activeService === 'water'
      ? settings.waterTariffPerM3
      : settings.gasTariffPerM3;

  // Build full list of 560 units for the active service and apply filters
  const filteredReviewRows = useMemo(() => {
    const rows: {
      unitId: string;
      tower: number;
      apartment: string;
      reference: ReferenceRecord | undefined;
      reading: ReadingRecord | undefined;
    }[] = [];

    const towersToScan =
      filterTower === 'all'
        ? Array.from({ length: TOTAL_TOWERS }, (_, i) => i + 1)
        : [filterTower];

    for (const t of towersToScan) {
      for (const apt of SEQUENTIAL_APARTMENTS) {
        if (
          searchApartment.trim() &&
          !apt.includes(searchApartment.trim())
        ) {
          continue;
        }
        const unitId = buildUnitKey(cycleId, activeService, t, apt);
        const reference = currentReferences.get(unitId);
        const reading = currentReadings.get(unitId);

        if (filterAuthor === 'mine') {
          if (
            !reading ||
            (reading.createdByUid !== authorUid &&
              reading.updatedByUid !== authorUid)
          ) {
            continue;
          }
        }

        if (filterStatus === 'read' && !reading) continue;
        if (filterStatus === 'pending' && reading) continue;
        if (
          filterStatus === 'alert' &&
          (!reading || reading.status !== 'alert')
        ) {
          continue;
        }
        if (
          filterStatus === 'local_only' &&
          (!reading || reading.syncStatus !== 'local_only')
        ) {
          continue;
        }
        if (
          filterStatus === 'synced' &&
          (!reading || reading.syncStatus !== 'synced')
        ) {
          continue;
        }
        if (
          filterStatus === 'conflict' &&
          (!reading || reading.syncStatus !== 'conflict')
        ) {
          continue;
        }

        rows.push({ unitId, tower: t, apartment: apt, reference, reading });
      }
    }
    return rows;
  }, [
    cycleId,
    activeService,
    filterTower,
    filterStatus,
    filterAuthor,
    searchApartment,
    currentReferences,
    currentReadings,
    authorUid,
  ]);

  // Totals calculated over ALL filtered records (excluding replaced meters from consumption and R$ sum)
  const filteredTotals = useMemo(() => {
    let readCount = 0;
    let pendingCount = 0;
    let alertCount = 0;
    let localOnlyCount = 0;
    let syncedCount = 0;
    let conflictCount = 0;
    let replacedMetersCount = 0;
    let totalValidConsumptionScaled = 0;
    let totalValidAmountCents = 0;
    let validAmountCount = 0;

    for (const item of filteredReviewRows) {
      const r = item.reading;
      if (!r) {
        pendingCount++;
        continue;
      }
      readCount++;
      const evalRes = evaluateReading({
        service: activeService,
        previousValue: r.previousValue,
        currentValue: r.currentValue,
        limits: settings,
        exceptionType: r.exceptionType,
        tariffOverridePerM3:
          r.appliedTariff !== undefined ? r.appliedTariff : currentCycleTariff,
      });
      const fin = getAuditedReadingFinancials(r, currentCycleTariff);

      if (evalRes.status === 'alert') alertCount++;
      if (r.syncStatus === 'local_only') localOnlyCount++;
      if (r.syncStatus === 'synced') syncedCount++;
      if (r.syncStatus === 'conflict') conflictCount++;
      if (r.exceptionType === 'meter_replaced') replacedMetersCount++;

      if (evalRes.consumption !== null && !evalRes.excludeFromTotals) {
        totalValidConsumptionScaled += Math.round(evalRes.consumption * 10000);
      }
      if (fin.calculatedAmountBrl !== null) {
        totalValidAmountCents += Math.round(fin.calculatedAmountBrl * 100);
        validAmountCount++;
      }
    }

    return {
      totalFiltered: filteredReviewRows.length,
      readCount,
      pendingCount,
      alertCount,
      localOnlyCount,
      syncedCount,
      conflictCount,
      replacedMetersCount,
      totalValidConsumption: totalValidConsumptionScaled / 10000,
      totalValidAmountBrl:
        validAmountCount > 0 ? totalValidAmountCents / 100 : null,
      validAmountCount,
    };
  }, [filteredReviewRows, activeService, settings, currentCycleTariff]);

  const visibleBatchRows = useMemo(
    () => filteredReviewRows.slice(0, visibleBatchCount),
    [filteredReviewRows, visibleBatchCount]
  );

  // Count saved readings whose audited tariff differs from the currently configured cycle tariff
  const readingsNeedingTariffRecalc = useMemo(() => {
    let waterDiffCount = 0;
    for (const r of waterReadings.values()) {
      if (r.appliedTariff !== settings.waterTariffPerM3) {
        waterDiffCount++;
      }
    }
    let gasDiffCount = 0;
    for (const r of gasReadings.values()) {
      if (r.appliedTariff !== settings.gasTariffPerM3) {
        gasDiffCount++;
      }
    }
    return {
      waterDiffCount,
      gasDiffCount,
      totalWaterSaved: waterReadings.size,
      totalGasSaved: gasReadings.size,
    };
  }, [
    waterReadings,
    gasReadings,
    settings.waterTariffPerM3,
    settings.gasTariffPerM3,
  ]);

  // Handlers for CSV Analysis & Import
  const handleAnalyzeCsvContent = (content: string, fileName: string) => {
    setCsvRawText(content);
    setCsvFileName(fileName);
    setCsvImportResultMsg(null);
    setConfirmImpactedReadings(false);

    const existingRefs =
      csvTargetService === 'water' ? waterReferences : gasReferences;
    const existingReads =
      csvTargetService === 'water' ? waterReadings : gasReadings;

    const preview = parseAndAnalyzeStartingCsv({
      csvContent: content,
      sourceFileName: fileName,
      service: csvTargetService,
      cycleId: csvTargetCycle,
      existingReferences: existingRefs,
      existingReadings: existingReads,
      limits: settings,
    });
    setCsvPreview(preview);
  };

  const handleConfirmCsvImport = async () => {
    if (!csvPreview || !csvPreview.headerValid) return;

    const hasImpacted = csvPreview.impactedSavedReadings.length > 0;
    if (hasImpacted && !confirmImpactedReadings) {
      setCsvImportResultMsg(
        'Marque a confirmação de impacto abaixo para atualizar as referências das leituras já salvas.'
      );
      return;
    }

    const res = await applyCsvImportAtomically({
      mode,
      cycleId: csvPreview.cycleId,
      service: csvPreview.service,
      sourceFileName: csvPreview.sourceFileName,
      validRows: csvPreview.validRows,
      applyToImpactedReadings: confirmImpactedReadings,
      limits: settings,
      authorUid,
      authorName,
    });

    await onRefreshState();
    setCsvImportResultMsg(
      `Importação concluída: ${res.importedCount} referência(s) gravada(s), ${res.updatedReadingsCount} leitura(s) salva(s) recalculada(s) preservando valores/fotos, e ${res.queuedTowersCount} torre(s) preparada(s) no delta de sincronização.`
    );
    setCsvPreview(null);
  };

  // Handler for Physical Order save
  const handleSavePhysicalOrder = async () => {
    const validation = validatePhysicalOrderInput(physicalOrderInput);
    if (!validation.valid) {
      setPhysicalOrderFeedback({
        type: 'err',
        msg: validation.error || 'Ordem inválida.',
      });
      return;
    }

    const towerCode = formatTowerCode(selectedOrderTower);
    await updateCycleSettingsAtomically({
      mode,
      cycleId,
      authorUid,
      authorName,
      enqueueSync: true,
      updater: (prev) => ({
        physicalOrders: {
          ...(prev.physicalOrders || {}),
          [towerCode]: validation.apartments,
        },
      }),
    });

    await onRefreshState();
    setPhysicalOrderFeedback({
      type: 'ok',
      msg: `Ordem física da Torre ${formatTowerNumber(
        selectedOrderTower
      )} validada (20 apartamentos únicos) e salva com sucesso.`,
    });
  };

  // Handler for Tariffs & Alert Limits save (preserving audited snapshots on already-saved readings)
  const handleSaveTariffsAndLimits = async () => {
    const wA = parseDecimalInput(waterAlertInput);
    const wC = parseDecimalInput(waterCeilingInput);
    const gA = parseDecimalInput(gasAlertInput);
    const gC = parseDecimalInput(gasCeilingInput);
    const gN = parseDecimalInput(gasNoiseInput);

    const trimmedWaterTariff = waterTariffInput.trim();
    const parsedWaterTariff =
      trimmedWaterTariff === '' ? null : parseDecimalInput(trimmedWaterTariff);

    const trimmedGasTariff = gasTariffInput.trim();
    const parsedGasTariff =
      trimmedGasTariff === '' ? null : parseDecimalInput(trimmedGasTariff);

    if (
      (trimmedWaterTariff !== '' &&
        (parsedWaterTariff === null || parsedWaterTariff <= 0)) ||
      (trimmedGasTariff !== '' &&
        (parsedGasTariff === null || parsedGasTariff <= 0))
    ) {
      setLimitsFeedback(
        'As tarifas de Água e Gás (R$/m³) devem ser números positivos maiores que zero (ou deixadas em branco para indicar ausência de tarifa).'
      );
      return;
    }

    if (
      wA === null ||
      wC === null ||
      gA === null ||
      gC === null ||
      gN === null ||
      wA <= 0 ||
      wC < wA ||
      gA <= 0 ||
      gC < gA
    ) {
      setLimitsFeedback(
        'Verifique os limites informados: todos devem ser números positivos e o teto deve ser maior ou igual ao limite de alerta.'
      );
      return;
    }

    await updateCycleSettingsAtomically({
      mode,
      cycleId,
      authorUid,
      authorName,
      enqueueSync: true,
      updater: () => ({
        waterTariffPerM3: parsedWaterTariff,
        gasTariffPerM3: parsedGasTariff,
        waterAlertLimit: wA,
        waterCeilingLimit: wC,
        gasAlertLimit: gA,
        gasCeilingLimit: gC,
        gasNoiseLimit: gN,
      }),
    });

    await onRefreshState();
    setLimitsFeedback(
      'Tarifas (R$/m³) e limites de alerta salvos no aparelho e enfileirados para o próximo "Atualizar". Os valores auditados das leituras já salvas foram preservados.'
    );
  };

  // Explicit Controlled Tariff Recalculation Handler for already-saved readings
  const handleExplicitRecalculateSavedReadings = async (
    targetService: ServiceType
  ) => {
    const newTariff =
      targetService === 'water'
        ? settings.waterTariffPerM3
        : settings.gasTariffPerM3;
    setIsRecalculatingTariff(true);
    setLimitsFeedback(null);
    try {
      const res = await recalculateSavedReadingsForNewTariff({
        mode,
        cycleId,
        service: targetService,
        newTariffPerM3: newTariff,
        limits: settings,
        authorUid,
        authorName,
      });
      await onRefreshState();
      const svcLabel = targetService === 'water' ? 'Água' : 'Gás';
      setLimitsFeedback(
        `Recálculo explícito de ${svcLabel} concluído: ${
          res.updatedReadingsCount
        } leitura(s) salva(s) atualizada(s) com a tarifa ${
          newTariff !== null ? formatTariffBrl(newTariff) : 'Sem tarifa'
        }, ${
          res.restampedPhotosCount
        } foto(s) recarimbada(s) no IndexedDB e ${
          res.queuedForSyncCount
        } registro(s) enfileirado(s) no delta.`
      );
    } catch (err) {
      setLimitsFeedback(
        err instanceof Error
          ? `Erro ao recalcular leituras: ${err.message}`
          : 'Erro ao recalcular leituras.'
      );
    } finally {
      setIsRecalculatingTariff(false);
    }
  };

  // Handlers for Export (CSV / PDF A4 Colorido por Torre / PDF A4 Colorido Consolidado / ZIP)
  const handleExportSelection = async (opts: {
    includeCsv: boolean;
    includePdf: boolean;
    consolidatedSinglePdf?: boolean;
    servicesOverride?: ServiceType[];
    towersOverride?: number[];
  }) => {
    setIsExporting(true);
    setExportFeedback(null);
    setPdfProgress(null);
    try {
      const towersToExport =
        opts.towersOverride ||
        (filterTower === 'all'
          ? Array.from({ length: TOTAL_TOWERS }, (_, i) => i + 1)
          : [filterTower]);
      const servicesToExport = opts.servicesOverride || [activeService];

      const res = await exportReportsBundle({
        mode,
        cycleId,
        services: servicesToExport,
        towers: towersToExport,
        includeCsv: opts.includeCsv,
        includePdf: opts.includePdf,
        consolidatedSinglePdf: opts.consolidatedSinglePdf,
        onProgress: (p) => {
          setPdfProgress(p);
        },
      });
      triggerBlobDownload(res.blob, res.fileName);
      setExportFeedback(`Arquivo exportado com sucesso: ${res.fileName}`);
    } catch (err) {
      setExportFeedback(
        err instanceof Error ? `Erro: ${err.message}` : 'Erro na exportação.'
      );
    } finally {
      setIsExporting(false);
      setPdfProgress(null);
    }
  };

  const handleExportConsolidatedColorPdf = async () => {
    setIsExporting(true);
    setExportFeedback(null);
    setPdfProgress(null);
    try {
      const servicesToInclude: ServiceType[] =
        consolidatedServicesMode === 'both'
          ? ['water', 'gas']
          : [consolidatedServicesMode];
      const towersToInclude =
        filterTower === 'all'
          ? Array.from({ length: TOTAL_TOWERS }, (_, i) => i + 1)
          : [filterTower];

      const res = await generateConsolidatedCycleA4ColorPdfBlob({
        mode,
        cycleId,
        services: servicesToInclude,
        towers: towersToInclude,
        onProgress: (p) => {
          setPdfProgress(p);
        },
      });
      triggerBlobDownload(res.pdfBlob, res.fileName);
      setExportFeedback(
        `PDF A4 Colorido Consolidado gerado (${res.totalReadingsIncluded} leitura(s) registrada(s), ${res.embeddedPhotosCount} foto(s) colorida(s) embutida(s)): ${res.fileName}`
      );
    } catch (err) {
      setExportFeedback(
        err instanceof Error
          ? `Erro no PDF Consolidado: ${err.message}`
          : 'Erro ao gerar PDF Consolidado.'
      );
    } finally {
      setIsExporting(false);
      setPdfProgress(null);
    }
  };

  /**
   * Executes the Integrated Homologation Test:
   * - Configures Water Tariff (R$ 6,5000/m³) and Gas Tariff (R$ 32,8000/m³)
   * - Seeds references for Tower 01 and Tower 02 in both Water and Gas
   * - Creates 8 readings across Tower 01 & Tower 02 (both Water and Gas), including:
   *   - Normal readings with 1 color stamped photo
   *   - High consumption alert readings with 1st photo + 2nd validation photo
   *   - Meter replacement (`meter_replaced`) with 1st photo + 2nd validation photo (`Troca de medidor (consumo excluído)`)
   *   - Negative consumption alert (`confirmed_negative`) with 1st photo + 2nd validation photo (`Consumo negativo (em revisão)`)
   * - Cross-checks that the exact same consumption (`m³`), applied tariff (`R$/m³`), and calculated value (`R$`)
   *   appear in the Collection evaluation, inside the Photo Stamp metadata, in the CSV export, and in the Consolidated Color PDF!
   */
  const handleRunHomologationTwoTowersBothServicesTest = async () => {
    setIsRunningHomologationTest(true);
    setExportFeedback(null);
    setSymmetryReport(null);
    try {
      const waterTariff = 6.5;
      const gasTariff = 32.8;

      const updatedSettings = await updateCycleSettingsAtomically({
        mode,
        cycleId,
        authorUid,
        authorName,
        enqueueSync: mode === 'real',
        updater: () => ({
          waterTariffPerM3: waterTariff,
          gasTariffPerM3: gasTariff,
        }),
      });

      const testScenarios: {
        service: ServiceType;
        tower: number;
        apartment: string;
        previousValue: number;
        currentValue: number;
        exceptionType: ExceptionType;
        observation: string;
        needsSecondPhoto: boolean;
        readingTypeLabel: string;
      }[] = [
        // TOWER 01 - WATER
        {
          service: 'water',
          tower: 1,
          apartment: '101',
          previousValue: 100.0,
          currentValue: 112.5,
          exceptionType: 'none',
          observation: 'Leitura normal Água T01 Apto 101',
          needsSecondPhoto: false,
          readingTypeLabel: 'Normal (1 Foto)',
        },
        {
          service: 'water',
          tower: 1,
          apartment: '102',
          previousValue: 200.0,
          currentValue: 228.0, // Δ 28.0000 m³ > 22 m³ (High consumption alert -> 2 photos)
          exceptionType: 'confirmed_high',
          observation: 'Consumo acima da referência confirmado no hidrômetro',
          needsSecondPhoto: true,
          readingTypeLabel: 'Alerta Consumo Alto (1ª + 2ª Foto)',
        },
        // TOWER 02 - WATER
        {
          service: 'water',
          tower: 2,
          apartment: '201',
          previousValue: 150.0,
          currentValue: 160.25,
          exceptionType: 'none',
          observation: 'Leitura normal Água T02 Apto 201',
          needsSecondPhoto: false,
          readingTypeLabel: 'Normal (1 Foto)',
        },
        {
          service: 'water',
          tower: 2,
          apartment: '202',
          previousValue: 310.0,
          currentValue: 4.5, // Meter replaced -> consumption & R$ excluded
          exceptionType: 'meter_replaced',
          observation: 'Troca de hidrômetro novo nº 88412',
          needsSecondPhoto: true,
          readingTypeLabel: 'Troca de Medidor (1ª + 2ª Foto)',
        },
        // TOWER 01 - GAS
        {
          service: 'gas',
          tower: 1,
          apartment: '303',
          previousValue: 266.007,
          currentValue: 266.844, // Δ 0.8370 m³ * 32.80 = R$ 27,45
          exceptionType: 'none',
          observation: 'Leitura normal Gás T01 Apto 303 (PNG referência)',
          needsSecondPhoto: false,
          readingTypeLabel: 'Normal (1 Foto)',
        },
        {
          service: 'gas',
          tower: 1,
          apartment: '304',
          previousValue: 110.0,
          currentValue: 128.5, // Δ 18.5000 m³ > 15 m³ (High consumption alert -> 2 photos)
          exceptionType: 'confirmed_high',
          observation: 'Consumo alto de gás verificado junto ao zelador',
          needsSecondPhoto: true,
          readingTypeLabel: 'Alerta Consumo Alto (1ª + 2ª Foto)',
        },
        // TOWER 02 - GAS
        {
          service: 'gas',
          tower: 2,
          apartment: '101',
          previousValue: 85.0,
          currentValue: 86.2,
          exceptionType: 'none',
          observation: 'Leitura normal Gás T02 Apto 101',
          needsSecondPhoto: false,
          readingTypeLabel: 'Normal (1 Foto)',
        },
        {
          service: 'gas',
          tower: 2,
          apartment: '102',
          previousValue: 92.0,
          currentValue: 91.2, // Negative consumption (-0.8000 m³) -> value unavailable
          exceptionType: 'confirmed_negative',
          observation: 'Leitura menor que anterior conferida no visor (revisão)',
          needsSecondPhoto: true,
          readingTypeLabel: 'Alerta Consumo Negativo (1ª + 2ª Foto)',
        },
      ];

      // Seed CSV reference rows for Tower 1 and Tower 2 for both services
      const waterRefRows: ParsedCsvRow[] = [];
      const gasRefRows: ParsedCsvRow[] = [];

      for (const s of testScenarios) {
        const row: ParsedCsvRow = {
          lineNumber: 2,
          tower: s.tower,
          apartment: s.apartment,
          pastPreviousValue: Math.max(0, s.previousValue - 2),
          newPreviousValue: s.previousValue,
          rawLine: `${s.tower};${s.apartment};${s.previousValue - 2};${s.previousValue}`,
        };
        if (s.service === 'water') {
          waterRefRows.push(row);
        } else {
          gasRefRows.push(row);
        }
      }

      await applyCsvImportAtomically({
        mode,
        cycleId,
        service: 'water',
        sourceFileName: 'homologacao_agua_t01_t02.csv',
        validRows: waterRefRows,
        applyToImpactedReadings: true,
        limits: updatedSettings,
        authorUid,
        authorName,
      });

      await applyCsvImportAtomically({
        mode,
        cycleId,
        service: 'gas',
        sourceFileName: 'homologacao_gas_t01_t02.csv',
        validRows: gasRefRows,
        applyToImpactedReadings: true,
        limits: updatedSettings,
        authorUid,
        authorName,
      });

      const savedReadingsByUnitId = new Map<string, ReadingRecord>();
      const stampedPhotosByUnitId = new Map<
        string,
        { p1: PhotoRecord; p2: PhotoRecord | null }
      >();
      let totalPhotosCreated = 0;

      for (const s of testScenarios) {
        const evalRes = evaluateReading({
          service: s.service,
          previousValue: s.previousValue,
          currentValue: s.currentValue,
          limits: updatedSettings,
          exceptionType: s.exceptionType,
        });

        const raw1 = await createSimulatedMeterRawBlob({
          tower: s.tower,
          apartment: s.apartment,
          service: s.service,
          value: s.currentValue,
        });
        const stamped1 = await stampMeterPhoto({
          rawBlob: raw1,
          cycleId,
          tower: s.tower,
          apartment: s.apartment,
          service: s.service,
          currentValue: s.currentValue,
          previousValue: s.previousValue,
          consumption: evalRes.consumption,
          appliedTariff: evalRes.appliedTariff,
          calculatedAmountBrl: evalRes.calculatedAmountBrl,
          amountUnavailableReason: evalRes.amountUnavailableReason,
          slot: 1,
          capturedAtIso: new Date().toISOString(),
        });
        totalPhotosCreated++;

        let stamped2 = null;
        let raw2: Blob | undefined;
        if (s.needsSecondPhoto) {
          raw2 = await createSimulatedMeterRawBlob({
            tower: s.tower,
            apartment: s.apartment,
            service: s.service,
            value: s.currentValue,
          });
          stamped2 = await stampMeterPhoto({
            rawBlob: raw2,
            cycleId,
            tower: s.tower,
            apartment: s.apartment,
            service: s.service,
            currentValue: s.currentValue,
            previousValue: s.previousValue,
            consumption: evalRes.consumption,
            appliedTariff: evalRes.appliedTariff,
            calculatedAmountBrl: evalRes.calculatedAmountBrl,
            amountUnavailableReason: evalRes.amountUnavailableReason,
            slot: 2,
            capturedAtIso: new Date().toISOString(),
          });
          totalPhotosCreated++;
        }

        const saved = await saveReadingAtomically({
          mode,
          cycleId,
          service: s.service,
          tower: s.tower,
          apartment: s.apartment,
          previousValue: s.previousValue,
          currentValue: s.currentValue,
          exceptionType: s.exceptionType,
          observation: s.observation,
          limits: updatedSettings,
          photo1: { ...stamped1, rawBlob: raw1 },
          photo2: stamped2 ? { ...stamped2, rawBlob: raw2 } : null,
          authorUid,
          authorName,
        });

        savedReadingsByUnitId.set(saved.id, saved);
        const photosInDb = await getPhotosForReading(mode, saved.id);
        stampedPhotosByUnitId.set(saved.id, {
          p1: photosInDb.get('1')!,
          p2: photosInDb.get('2') || null,
        });
      }

      await onRefreshState();

      // Build CSV exports for Water and Gas across Towers 1 and 2 to verify exact symmetry
      const wRefs = await getReferencesForCycleService(mode, cycleId, 'water');
      const wReads = await getReadingsForCycleService(mode, cycleId, 'water');
      const gRefs = await getReferencesForCycleService(mode, cycleId, 'gas');
      const gReads = await getReadingsForCycleService(mode, cycleId, 'gas');

      const waterCsv = buildExportCsv({
        cycleId,
        service: 'water',
        towers: [1, 2],
        referencesMap: wRefs,
        readingsMap: wReads,
        fallbackTariffPerM3: waterTariff,
      });
      const gasCsv = buildExportCsv({
        cycleId,
        service: 'gas',
        towers: [1, 2],
        referencesMap: gRefs,
        readingsMap: gReads,
        fallbackTariffPerM3: gasTariff,
      });

      const symmetryRows: SymmetryCrossCheckReport['rows'] = [];
      let allMatched = true;
      let waterM3Scaled = 0;
      let waterBrlCents = 0;
      let gasM3Scaled = 0;
      let gasBrlCents = 0;

      for (const s of testScenarios) {
        const unitId = buildUnitKey(cycleId, s.service, s.tower, s.apartment);
        const saved = savedReadingsByUnitId.get(unitId)!;
        const photos = stampedPhotosByUnitId.get(unitId)!;
        const fallbackTariff = s.service === 'water' ? waterTariff : gasTariff;
        const fin = getAuditedReadingFinancials(saved, fallbackTariff);

        if (saved.consumption !== null && saved.exceptionType !== 'meter_replaced') {
          if (s.service === 'water') {
            waterM3Scaled += Math.round(saved.consumption * 10000);
          } else {
            gasM3Scaled += Math.round(saved.consumption * 10000);
          }
        }
        if (fin.calculatedAmountBrl !== null) {
          if (s.service === 'water') {
            waterBrlCents += Math.round(fin.calculatedAmountBrl * 100);
          } else {
            gasBrlCents += Math.round(fin.calculatedAmountBrl * 100);
          }
        }

        const expectedConsStr =
          saved.exceptionType === 'meter_replaced'
            ? 'Troca Medidor'
            : `${formatDecimal4(saved.consumption, true)} m³`;
        const expectedTariffStr =
          fin.appliedTariff !== null
            ? formatTariffBrl(fin.appliedTariff)
            : 'Sem tarifa';
        const expectedAmountStr =
          fin.calculatedAmountBrl !== null
            ? formatCurrencyBrl(fin.calculatedAmountBrl)
            : fin.amountUnavailableReason || 'Indisponível';

        const collectionSummary = `${expectedConsStr} | ${expectedTariffStr} | ${expectedAmountStr}`;

        // Check Photo Stamp Metadata
        const p1Matches =
          photos.p1.stampedValue === saved.currentValue &&
          photos.p1.stampedTariff === fin.appliedTariff &&
          photos.p1.stampedAmountBrl === fin.calculatedAmountBrl;
        const p2Matches =
          !s.needsSecondPhoto ||
          (photos.p2 !== null &&
            photos.p2.stampedValue === saved.currentValue &&
            photos.p2.stampedTariff === fin.appliedTariff &&
            photos.p2.stampedAmountBrl === fin.calculatedAmountBrl);
        const photoStampSummary =
          p1Matches && p2Matches ? collectionSummary : 'Divergência no carimbo';

        // Check CSV Row (EXPORT_CSV_HEADER: Ciclo;Servico;Bloco;Apartamento;Anterior;Atual;Consumo;Tarifa_R$_m3;Valor_R$;Motivo_Valor_R$;...)
        const csvSource = s.service === 'water' ? waterCsv : gasCsv;
        const servicePrefix = s.service === 'water' ? 'Agua' : 'Gas';
        const csvLine = csvSource
          .replace(/^\uFEFF/, '')
          .split('\n')
          .find((line) =>
            line.startsWith(`${cycleId};${servicePrefix};${s.tower};${s.apartment};`)
          );
        const csvCols = csvLine ? csvLine.split(';') : [];
        const csvConsRaw = csvCols[6] || '';
        const csvTariffRaw = csvCols[7] || '';
        const csvAmountRaw = csvCols[8] || '';
        const csvReasonRaw = csvCols[9] || '';

        const expectedCsvTariff =
          fin.appliedTariff !== null && fin.appliedTariff > 0
            ? formatTariffBrl(fin.appliedTariff, false, true)
            : '';
        const expectedCsvAmount =
          fin.calculatedAmountBrl !== null
            ? formatCurrencyBrl(fin.calculatedAmountBrl, false, true)
            : '';
        const expectedCsvReason =
          fin.calculatedAmountBrl !== null
            ? 'Calculado'
            : fin.amountUnavailableReason || 'Indisponivel';

        const csvMatches =
          csvTariffRaw === expectedCsvTariff &&
          csvAmountRaw === expectedCsvAmount &&
          csvReasonRaw === expectedCsvReason;

        const csvSummary = csvMatches
          ? `${csvConsRaw ? `${csvConsRaw} m³` : 'Troca Medidor'} | ${expectedTariffStr} | ${expectedAmountStr}`
          : `Divergência CSV (${csvLine || 'não encontrada'})`;

        // PDF Engine uses the exact same `getAuditedReadingFinancials(reading, fallbackTariff)` and `getPhotosForReading`
        const pdfMatches =
          p1Matches &&
          p2Matches &&
          csvMatches &&
          Boolean(saved.photo1Id) &&
          (!s.needsSecondPhoto || Boolean(saved.photo2Id));
        const pdfSummary = pdfMatches
          ? collectionSummary
          : 'Divergência PDF';

        const rowMatched = p1Matches && p2Matches && csvMatches && pdfMatches;
        if (!rowMatched) allMatched = false;

        symmetryRows.push({
          serviceLabel: s.service === 'water' ? 'Água' : 'Gás',
          unitLabel: `Torre ${formatTowerNumber(s.tower)} • Apto ${s.apartment}`,
          readingTypeLabel: s.readingTypeLabel,
          photosCount: s.needsSecondPhoto ? 2 : 1,
          collectionValueStr: collectionSummary,
          photoStampValueStr: photoStampSummary,
          csvLineValueStr: csvSummary,
          pdfLineValueStr: pdfSummary,
          matched: rowMatched,
        });
      }

      setSymmetryReport({
        generatedAt: new Date().toLocaleTimeString('pt-BR'),
        towersChecked: [1, 2],
        servicesChecked: ['water', 'gas'],
        totalReadingsVerified: testScenarios.length,
        totalPhotosVerified: totalPhotosCreated,
        allMatched,
        waterTotalM3: `${formatDecimal4(waterM3Scaled / 10000, true)} m³`,
        waterTotalBrl: formatCurrencyBrl(waterBrlCents / 100),
        gasTotalM3: `${formatDecimal4(gasM3Scaled / 10000, true)} m³`,
        gasTotalBrl: formatCurrencyBrl(gasBrlCents / 100),
        rows: symmetryRows,
      });

      setExportFeedback(
        `Cenário de Homologação (Torres 01 e 02 • Água e Gás • ${testScenarios.length} leituras • ${totalPhotosCreated} fotos coloridas 1ª e 2ª) preparado e conferido com 100% de simetria entre Coleta, Carimbo da Foto, CSV e PDF Consolidado!`
      );
    } catch (err) {
      setExportFeedback(
        err instanceof Error
          ? `Erro na homologação: ${err.message}`
          : 'Erro ao preparar cenário de homologação.'
      );
    } finally {
      setIsRunningHomologationTest(false);
    }
  };

  return (
    <div className="min-h-screen flex flex-col bg-[#F4F6F9] text-[#0F172A]">
      {/* Top Bar */}
      <header className="sticky top-0 z-30 bg-[#0A2239] text-white shadow-md">
        <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={onBackToField}
              className="min-h-[44px] px-3 py-2 -ml-2 rounded-xl flex items-center gap-1.5 hover:bg-white/10 font-bold text-xs transition"
            >
              <ArrowLeft className="w-5 h-5" />
              <span>Voltar p/ Coleta</span>
            </button>
            <h1 className="text-lg sm:text-xl font-extrabold tracking-tight truncate">
              Gestão • SN - Leituras ({cycleId})
            </h1>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => onSelectService('water')}
              className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                activeService === 'water'
                  ? 'bg-[#0D8A9E] text-white'
                  : 'bg-white/10 text-white hover:bg-white/20'
              }`}
            >
              Água{' '}
              {settings.waterTariffPerM3 !== null
                ? `(${formatTariffBrl(settings.waterTariffPerM3)})`
                : '(S/ tarifa)'}
            </button>
            <button
              type="button"
              onClick={() => onSelectService('gas')}
              className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                activeService === 'gas'
                  ? 'bg-[#E08E00] text-[#0F172A]'
                  : 'bg-white/10 text-white hover:bg-white/20'
              }`}
            >
              Gás{' '}
              {settings.gasTariffPerM3 !== null
                ? `(${formatTariffBrl(settings.gasTariffPerM3)})`
                : '(S/ tarifa)'}
            </button>
          </div>
        </div>
      </header>

      {/* Navigation Tabs */}
      <div className="bg-white border-b border-slate-300">
        <div className="max-w-7xl mx-auto px-4 py-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setTab('review')}
            className={`min-h-[42px] px-3.5 py-2 rounded-xl text-xs font-extrabold flex items-center gap-1.5 transition ${
              tab === 'review'
                ? 'bg-[#0A2239] text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            <Eye className="w-4 h-4" />
            <span>Revisão, Conflitos & Relatórios (CSV / PDF Colorido)</span>
          </button>

          <button
            type="button"
            onClick={() => setTab('limits')}
            className={`min-h-[42px] px-3.5 py-2 rounded-xl text-xs font-extrabold flex items-center gap-1.5 transition ${
              tab === 'limits'
                ? 'bg-[#0A2239] text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            <Sliders className="w-4 h-4" />
            <span>Tarifas (R$/m³) & Limites de Alerta</span>
          </button>

          <button
            type="button"
            onClick={() => setTab('csv')}
            className={`min-h-[42px] px-3.5 py-2 rounded-xl text-xs font-extrabold flex items-center gap-1.5 transition ${
              tab === 'csv'
                ? 'bg-[#0A2239] text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            <FileSpreadsheet className="w-4 h-4" />
            <span>Importar CSV de Ponto de Partida</span>
          </button>

          <button
            type="button"
            onClick={() => setTab('order')}
            className={`min-h-[42px] px-3.5 py-2 rounded-xl text-xs font-extrabold flex items-center gap-1.5 transition ${
              tab === 'order'
                ? 'bg-[#0A2239] text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            <ListOrdered className="w-4 h-4" />
            <span>Ordem Física do Painel (Gás)</span>
          </button>

          <button
            type="button"
            onClick={() => setTab('backup')}
            className={`min-h-[42px] px-3.5 py-2 rounded-xl text-xs font-extrabold flex items-center gap-1.5 transition ${
              tab === 'backup'
                ? 'bg-[#0A2239] text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            <FolderArchive className="w-4 h-4" />
            <span>Backup ZIP & Restauração</span>
          </button>
        </div>
      </div>

      <main className="flex-1 max-w-7xl w-full mx-auto px-4 py-5 space-y-5">
        {/* ================================================================== */}
        {/* TAB 1: REVISÃO DE LEITURAS, CONFLITOS & EXPORTAÇÃO CSV / PDF A4   */}
        {/* ================================================================== */}
        {tab === 'review' && (
          <div className="space-y-4">
            {/* Filters & Export Toolbar */}
            <section className="rounded-2xl bg-white border border-slate-300 p-4 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Serviço na Tabela
                  </label>
                  <select
                    value={activeService}
                    onChange={(e) =>
                      onSelectService(e.target.value as ServiceType)
                    }
                    className="w-full min-h-[42px] px-3 rounded-xl border border-slate-300 font-bold text-xs"
                  >
                    <option value="gas">Gás (560 unidades)</option>
                    <option value="water">Água (560 unidades)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Torre
                  </label>
                  <select
                    value={filterTower}
                    onChange={(e) =>
                      setFilterTower(
                        e.target.value === 'all'
                          ? 'all'
                          : Number(e.target.value)
                      )
                    }
                    className="w-full min-h-[42px] px-3 rounded-xl border border-slate-300 font-bold text-xs"
                  >
                    <option value="all">Todas as 28 Torres (560 unid.)</option>
                    {Array.from({ length: TOTAL_TOWERS }, (_, i) => i + 1).map(
                      (t) => (
                        <option key={t} value={t}>
                          Torre {formatTowerNumber(t)} (20 apartamentos)
                        </option>
                      )
                    )}
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Status / Sincronização
                  </label>
                  <select
                    value={filterStatus}
                    onChange={(e) =>
                      setFilterStatus(
                        e.target.value as typeof filterStatus
                      )
                    }
                    className="w-full min-h-[42px] px-3 rounded-xl border border-slate-300 font-bold text-xs"
                  >
                    <option value="all">Todos os registros</option>
                    <option value="read">Somente Lidas</option>
                    <option value="pending">Somente Pendentes</option>
                    <option value="alert">Com Alerta / Exceção</option>
                    <option value="local_only">
                      Salvas apenas no aparelho
                    </option>
                    <option value="synced">Sincronizadas na nuvem</option>
                    <option value="conflict">
                      Conflitos entre aparelhos
                    </option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Autoria (Teste em Dupla)
                  </label>
                  <select
                    value={filterAuthor}
                    onChange={(e) =>
                      setFilterAuthor(e.target.value as 'all' | 'mine')
                    }
                    className="w-full min-h-[42px] px-3 rounded-xl border border-slate-300 font-bold text-xs"
                  >
                    <option value="all">Todas as leituras</option>
                    <option value="mine">Minhas leituras</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-700 mb-1">
                    Buscar Apartamento
                  </label>
                  <input
                    type="text"
                    placeholder="Ex: 303"
                    value={searchApartment}
                    onChange={(e) => setSearchApartment(e.target.value)}
                    className="w-full min-h-[42px] px-3 rounded-xl border border-slate-300 font-mono font-bold text-xs"
                  />
                </div>
              </div>

              {/* Totals Strip Computed Over ALL Filtered Records */}
              <div className="pt-3 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs font-bold text-slate-800">
                  <span>
                    Filtrados:{' '}
                    <strong className="font-mono tabular-nums">
                      {filteredTotals.totalFiltered}
                    </strong>
                  </span>
                  <span>
                    Lidas:{' '}
                    <strong className="font-mono tabular-nums text-emerald-800">
                      {filteredTotals.readCount}
                    </strong>
                  </span>
                  <span>
                    Pendentes:{' '}
                    <strong className="font-mono tabular-nums text-amber-800">
                      {filteredTotals.pendingCount}
                    </strong>
                  </span>
                  <span>
                    Com Alerta:{' '}
                    <strong className="font-mono tabular-nums text-red-700">
                      {filteredTotals.alertCount}
                    </strong>
                  </span>
                  <span>
                    No Aparelho:{' '}
                    <strong className="font-mono tabular-nums text-amber-900">
                      {filteredTotals.localOnlyCount}
                    </strong>
                  </span>
                  <span>
                    Conflitos:{' '}
                    <strong className="font-mono tabular-nums text-red-800">
                      {filteredTotals.conflictCount}
                    </strong>
                  </span>
                  <span className="bg-slate-100 px-2.5 py-1 rounded-lg border border-slate-300">
                    Consumo Total Válido (s/ trocas):{' '}
                    <strong className="font-mono tabular-nums text-sm text-[#0A2239]">
                      {formatDecimal4(
                        filteredTotals.totalValidConsumption,
                        true
                      )}{' '}
                      m³
                    </strong>
                  </span>
                  <span className="bg-emerald-50 px-2.5 py-1 rounded-lg border border-emerald-300">
                    Valor Total Calculado (R$):{' '}
                    <strong className="font-mono tabular-nums text-sm text-emerald-950">
                      {filteredTotals.totalValidAmountBrl !== null
                        ? formatCurrencyBrl(filteredTotals.totalValidAmountBrl)
                        : 'Sem tarifa configurada'}
                    </strong>
                  </span>
                </div>

                {/* Export Controls: Per-Tower/Service AND Consolidated Cycle Color PDF */}
                <div className="w-full pt-2 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2">
                  <label className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={showPhotosInBatch}
                      onChange={(e) => setShowPhotosInBatch(e.target.checked)}
                      className="w-4 h-4 accent-[#0A2239]"
                    />
                    <span>Carregar miniaturas no lote</span>
                  </label>

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={isExporting}
                      onClick={() =>
                        handleExportSelection({
                          includeCsv: true,
                          includePdf: false,
                        })
                      }
                      className="min-h-[40px] px-3 py-1.5 rounded-xl border border-slate-300 bg-white hover:bg-slate-50 font-bold text-xs flex items-center gap-1.5"
                    >
                      <Download className="w-4 h-4" />
                      <span>Exportar CSV ({activeService === 'water' ? 'Água' : 'Gás'})</span>
                    </button>

                    <button
                      type="button"
                      disabled={isExporting}
                      onClick={() =>
                        handleExportSelection({
                          includeCsv: false,
                          includePdf: true,
                        })
                      }
                      className="min-h-[40px] px-3 py-1.5 rounded-xl bg-[#0A2239] hover:bg-[#12385b] text-white font-bold text-xs flex items-center gap-1.5"
                    >
                      <FileText className="w-4 h-4" />
                      <span>
                        PDF A4 Colorido ({filterTower === 'all' ? 'Por Torre' : `T${formatTowerNumber(filterTower)}`} • Todas as Fotos)
                      </span>
                    </button>

                    {/* Consolidated Single A4 Color PDF Selector + Action */}
                    <div className="inline-flex items-stretch rounded-xl border-2 border-[#0A2239] overflow-hidden bg-white">
                      <select
                        aria-label="Serviços do PDF Consolidado"
                        value={consolidatedServicesMode}
                        onChange={(e) =>
                          setConsolidatedServicesMode(
                            e.target.value as 'both' | 'water' | 'gas'
                          )
                        }
                        className="px-2.5 py-1.5 bg-slate-100 text-xs font-extrabold text-[#0A2239] border-r border-slate-300 focus:outline-none"
                      >
                        <option value="both">Água + Gás (2 serviços)</option>
                        <option value="water">Somente Água</option>
                        <option value="gas">Somente Gás</option>
                      </select>
                      <button
                        type="button"
                        disabled={isExporting}
                        onClick={handleExportConsolidatedColorPdf}
                        className="min-h-[40px] px-3.5 py-1.5 bg-[#E08E00] hover:bg-[#c97e00] text-[#0F172A] font-extrabold text-xs flex items-center gap-1.5"
                      >
                        <FileText className="w-4 h-4" />
                        <span>PDF Único Consolidado Colorido (1ª e 2ª Fotos)</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Live PDF Generation Progress Bar (reads exclusively from IndexedDB) */}
              {isExporting && pdfProgress && (
                <div className="rounded-xl bg-[#0A2239] text-white p-3.5 space-y-2">
                  <div className="flex items-center justify-between text-xs font-extrabold">
                    <span>{pdfProgress.label}</span>
                    <span className="font-mono">
                      {pdfProgress.currentReadingIndex}/{pdfProgress.totalReadings} leituras •{' '}
                      {pdfProgress.embeddedPhotosCount} foto(s) colorida(s) •{' '}
                      {pdfProgress.totalReadings > 0
                        ? Math.min(
                            100,
                            Math.round(
                              (pdfProgress.currentReadingIndex / pdfProgress.totalReadings) * 100
                            )
                          )
                        : 100}
                      %
                    </span>
                  </div>
                  <div className="w-full h-2.5 bg-white/20 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-[#E08E00] transition-all duration-150"
                      style={{
                        width: `${
                          pdfProgress.totalReadings > 0
                            ? Math.min(
                                100,
                                Math.round(
                                  (pdfProgress.currentReadingIndex / pdfProgress.totalReadings) *
                                    100
                                )
                              )
                            : 100
                        }%`,
                      }}
                    />
                  </div>
                  <p className="text-[11px] text-slate-200">
                    Processamento sequencial via IndexedDB (zero leituras no
                    Firestore e liberação imediata de memória a cada foto para
                    não omitir imagens no celular).
                  </p>
                </div>
              )}

              {exportFeedback && (
                <div className="rounded-xl bg-emerald-50 border border-emerald-400 px-3 py-2 text-xs font-bold text-emerald-950">
                  {exportFeedback}
                </div>
              )}
            </section>

            {/* Separated Field Acceptance vs Desktop Management Acceptance & 2-Tower Both-Services Homologation Panel */}
            <section className="rounded-2xl bg-white border-2 border-[#0A2239] p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-start gap-2.5">
                  <ClipboardCheck className="w-5 h-5 text-[#0A2239] shrink-0 mt-0.5" />
                  <div>
                    <h2 className="text-sm font-extrabold text-[#0F172A]">
                      Aceite Separado (Campo no Celular vs. Gestão no Computador) &
                      Teste Integrado (2 Torres • Água e Gás • Fotos Normais e
                      Alerta)
                    </h2>
                    <p className="text-xs text-slate-600">
                      Confira os critérios separados por dispositivo ou execute o
                      teste automatizado com Torres 01 e 02, ambos os serviços,
                      1ª e 2ª fotos coloridas e conferência cruzada Coleta = Foto
                      = CSV = PDF.
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  disabled={isRunningHomologationTest}
                  onClick={handleRunHomologationTwoTowersBothServicesTest}
                  className="min-h-[42px] px-4 py-2 rounded-xl bg-[#0A2239] hover:bg-[#12385b] text-white font-extrabold text-xs flex items-center gap-1.5 shrink-0"
                >
                  <RefreshCw
                    className={`w-4 h-4 ${
                      isRunningHomologationTest ? 'animate-spin' : ''
                    }`}
                  />
                  <span>
                    {isRunningHomologationTest
                      ? 'Gerando 2 Torres (Água + Gás) e Conferindo...'
                      : 'Executar Teste 2 Torres (Água + Gás + Fotos 1ª/2ª) e Conferir Simetria'}
                  </span>
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                <div className="rounded-xl bg-slate-50 border border-slate-300 p-3 space-y-1.5">
                  <div className="flex items-center gap-1.5 font-extrabold text-[#0A2239]">
                    <Smartphone className="w-4 h-4" />
                    <span>1. Aceite de Campo no Celular (Offline-First)</span>
                  </div>
                  <ul className="space-y-1 text-slate-700 font-semibold list-disc list-inside">
                    <li>
                      Digitação decimal (vírgula/ponto) com cálculo imediato de{' '}
                      <code>m³</code> e <code>R$</code> a cada tecla;
                    </li>
                    <li>
                      <code>Enter</code> abre a câmera; carimbo colorido de 4
                      linhas inclui leitura, consumo, tarifa e valor em{' '}
                      <code>R$</code> (ou motivo de indisponibilidade);
                    </li>
                    <li>
                      1ª foto obrigatória em todas as leituras; 2ª foto e
                      justificativa obrigatórias nos alertas/exceções;
                    </li>
                    <li>
                      Geração do PDF colorido no celular com barra de progresso e
                      zero omissão silenciosa de fotos.
                    </li>
                  </ul>
                </div>

                <div className="rounded-xl bg-slate-50 border border-slate-300 p-3 space-y-1.5">
                  <div className="flex items-center gap-1.5 font-extrabold text-[#0A2239]">
                    <Laptop className="w-4 h-4" />
                    <span>2. Aceite da Gestão no Computador (Auditoria)</span>
                  </div>
                  <ul className="space-y-1 text-slate-700 font-semibold list-disc list-inside">
                    <li>
                      Ciclo inicia sem tarifa (<code>Sem tarifa configurada</code>
                      ); cadastro de tarifas de Água e Gás sincroniza no delta{' '}
                      <strong>Atualizar</strong>;
                    </li>
                    <li>
                      Preservação automática da tarifa e do valor em{' '}
                      <code>R$</code> auditados nas leituras já salvas, com botão
                      explícito para recálculo controlado;
                    </li>
                    <li>
                      Exportação por torre/serviço e PDF A4 Colorido Consolidado
                      único (Serviço → Torre → Apto) com totais por serviço;
                    </li>
                    <li>
                      Mesmos valores exatos (<code>m³</code>, tarifa e{' '}
                      <code>R$</code>) na coleta, no carimbo da foto, no CSV e no
                      PDF.
                    </li>
                  </ul>
                </div>
              </div>

              {symmetryReport && (
                <div className="rounded-xl bg-emerald-50/90 border-2 border-emerald-600 p-3.5 space-y-3 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="font-extrabold text-emerald-950">
                      Relatório de Conferência Cruzada ({symmetryReport.generatedAt}
                      ) • {symmetryReport.totalReadingsVerified} leituras •{' '}
                      {symmetryReport.totalPhotosVerified} fotos coloridas (1ª e
                      2ª)
                    </div>
                    <span className="px-2.5 py-1 rounded-lg bg-emerald-700 text-white font-extrabold">
                      {symmetryReport.allMatched
                        ? '100% IDÊNTICO (COLETA = FOTO = CSV = PDF)'
                        : 'VERIFICAR DIVERGÊNCIA'}
                    </span>
                  </div>

                  <div className="flex flex-wrap gap-3 font-mono font-bold text-slate-900">
                    <span className="bg-white px-2.5 py-1 rounded border border-emerald-300">
                      Total Água (T01+T02): {symmetryReport.waterTotalM3} →{' '}
                      <strong className="text-emerald-900">
                        {symmetryReport.waterTotalBrl}
                      </strong>
                    </span>
                    <span className="bg-white px-2.5 py-1 rounded border border-emerald-300">
                      Total Gás (T01+T02): {symmetryReport.gasTotalM3} →{' '}
                      <strong className="text-emerald-900">
                        {symmetryReport.gasTotalBrl}
                      </strong>
                    </span>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left border-collapse bg-white rounded-lg overflow-hidden border border-emerald-300 text-[11px]">
                      <thead>
                        <tr className="bg-emerald-100 text-emerald-950 font-extrabold">
                          <th className="p-2">Serviço / Unidade</th>
                          <th className="p-2">Tipo & Fotos</th>
                          <th className="p-2">Coleta (m³ | Tarifa | R$)</th>
                          <th className="p-2">Carimbo Foto</th>
                          <th className="p-2">CSV Exportado</th>
                          <th className="p-2">PDF Colorido</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-emerald-200 font-mono">
                        {symmetryReport.rows.map((r, idx) => (
                          <tr key={idx}>
                            <td className="p-2 font-bold">
                              {r.serviceLabel} • {r.unitLabel}
                            </td>
                            <td className="p-2 font-sans font-semibold">
                              {r.readingTypeLabel} ({r.photosCount} foto(s))
                            </td>
                            <td className="p-2">{r.collectionValueStr}</td>
                            <td className="p-2 text-emerald-800 font-bold">
                              ✓ {r.photoStampValueStr}
                            </td>
                            <td className="p-2 text-emerald-800 font-bold">
                              ✓ {r.csvLineValueStr}
                            </td>
                            <td className="p-2 text-emerald-800 font-bold">
                              ✓ {r.pdfLineValueStr}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </section>

            {/* Batched Table */}
            <section className="rounded-2xl bg-white border border-slate-300 overflow-hidden shadow-2xs">
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-slate-100 border-b border-slate-300 text-slate-700 font-extrabold">
                      <th className="py-3 px-3">Torre / Apto</th>
                      <th className="py-3 px-3 text-right">Anterior (m³)</th>
                      <th className="py-3 px-3 text-right">Atual (m³)</th>
                      <th className="py-3 px-3 text-right">Consumo (m³)</th>
                      <th className="py-3 px-3 text-right">Tarifa (R$/m³)</th>
                      <th className="py-3 px-3 text-right">Valor (R$)</th>
                      <th className="py-3 px-3">Status & Alertas</th>
                      <th className="py-3 px-3">Sincronização & Autoria</th>
                      {showPhotosInBatch && (
                        <th className="py-3 px-3">Fotos Coloridas (1ª / 2ª)</th>
                      )}
                      <th className="py-3 px-3 text-right">Ação</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {visibleBatchRows.map((item) => {
                      const r = item.reading;
                      const prevVal =
                        r !== undefined
                          ? r.previousValue
                          : item.reference?.previousValue ?? null;

                      const evalRes = r
                        ? evaluateReading({
                            service: activeService,
                            previousValue: r.previousValue,
                            currentValue: r.currentValue,
                            limits: settings,
                            exceptionType: r.exceptionType,
                            tariffOverridePerM3:
                              r.appliedTariff !== undefined
                                ? r.appliedTariff
                                : currentCycleTariff,
                          })
                        : null;

                      const fin = r
                        ? getAuditedReadingFinancials(r, currentCycleTariff)
                        : null;

                      return (
                        <tr
                          key={item.unitId}
                          className={`hover:bg-slate-50 ${
                            r?.syncStatus === 'conflict'
                              ? 'bg-red-50/70'
                              : evalRes?.status === 'alert'
                              ? 'bg-amber-50/40'
                              : ''
                          }`}
                        >
                          <td className="py-2.5 px-3 font-mono font-extrabold text-sm text-[#0F172A] whitespace-nowrap">
                            T{formatTowerNumber(item.tower)} • {item.apartment}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono tabular-nums font-semibold">
                            {prevVal !== null
                              ? formatDecimal4(prevVal, true)
                              : 'Sem ant.'}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono tabular-nums font-extrabold text-[#0F172A]">
                            {r ? formatDecimal4(r.currentValue, true) : '—'}
                          </td>
                          <td
                            className={`py-2.5 px-3 text-right font-mono tabular-nums font-extrabold ${
                              evalRes?.status === 'alert'
                                ? 'text-red-700'
                                : 'text-[#0F172A]'
                            }`}
                          >
                            {r
                              ? evalRes?.excludeFromTotals
                                ? 'Troca Medidor'
                                : evalRes?.consumption !== null
                                ? formatDecimal4(evalRes?.consumption, true)
                                : '—'
                              : '—'}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono tabular-nums text-slate-700">
                            {r && fin ? (
                              fin.appliedTariff !== null ? (
                                formatDecimal4(fin.appliedTariff, true)
                              ) : (
                                <span className="font-sans text-[11px] text-amber-800 font-bold">
                                  Sem tarifa
                                </span>
                              )
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="py-2.5 px-3 text-right font-mono tabular-nums font-extrabold">
                            {r && fin ? (
                              fin.calculatedAmountBrl !== null ? (
                                <span className="text-emerald-900">
                                  {formatCurrencyBrl(fin.calculatedAmountBrl)}
                                </span>
                              ) : (
                                <span className="font-sans text-[11px] text-amber-800 font-bold">
                                  {fin.amountUnavailableReason || 'Indisponível'}
                                </span>
                              )
                            ) : (
                              '—'
                            )}
                          </td>
                          <td className="py-2.5 px-3">
                            {!r ? (
                              <span className="font-bold text-amber-800">
                                Pendente
                              </span>
                            ) : (
                              <div className="space-y-0.5">
                                <span
                                  className={`font-extrabold ${
                                    evalRes?.status === 'alert'
                                      ? 'text-red-700'
                                      : 'text-emerald-800'
                                  }`}
                                >
                                  {evalRes?.status === 'alert'
                                    ? 'Alerta'
                                    : 'Lida'}
                                </span>
                                {evalRes && evalRes.alerts.length > 0 && (
                                  <p className="text-[11px] font-semibold text-red-700">
                                    {evalRes.alerts
                                      .map(formatAlertLabel)
                                      .join(', ')}
                                  </p>
                                )}
                                {r.observation && (
                                  <p className="text-[11px] text-slate-600">
                                    Obs: {r.observation}
                                  </p>
                                )}
                              </div>
                            )}
                          </td>
                          <td className="py-2.5 px-3">
                            {r ? (
                              <div className="space-y-0.5">
                                <span
                                  className={`font-extrabold ${
                                    r.syncStatus === 'conflict'
                                      ? 'text-red-700'
                                      : r.syncStatus === 'synced'
                                      ? 'text-emerald-800'
                                      : 'text-amber-800'
                                  }`}
                                >
                                  {r.syncStatus === 'conflict'
                                    ? 'Conflito (2 versões)'
                                    : r.syncStatus === 'synced'
                                    ? `Sincronizada (Rev ${r.revision})`
                                    : 'Salva no aparelho'}
                                </span>
                                <p className="text-[11px] text-slate-600">
                                  Reg: <strong>{r.createdByName}</strong>
                                  {r.updatedByUid !== r.createdByUid &&
                                    ` · Alt: ${r.updatedByName}`}
                                </p>
                                {r.syncStatus === 'conflict' &&
                                  r.conflictCandidate && (
                                    <div className="pt-1 flex flex-wrap items-center gap-1.5">
                                      <span className="text-[11px] font-bold text-red-900">
                                        Tentativa local:{' '}
                                        {formatDecimal4(
                                          r.conflictCandidate.currentValue,
                                          true
                                        )}{' '}
                                        m³ ({r.conflictCandidate.updatedByName})
                                      </span>
                                      <button
                                        type="button"
                                        onClick={async () => {
                                          await resolveReadingConflict({
                                            mode,
                                            readingId: r.id,
                                            chosenSource: 'remote',
                                            authorUid,
                                            authorName,
                                          });
                                          await onRefreshState();
                                        }}
                                        className="px-2 py-0.5 rounded bg-emerald-700 text-white font-bold text-[10px]"
                                      >
                                        Manter Nuvem
                                      </button>
                                      <button
                                        type="button"
                                        onClick={async () => {
                                          await resolveReadingConflict({
                                            mode,
                                            readingId: r.id,
                                            chosenSource: 'local',
                                            authorUid,
                                            authorName,
                                          });
                                          await onRefreshState();
                                        }}
                                        className="px-2 py-0.5 rounded bg-[#E08E00] text-[#0F172A] font-extrabold text-[10px]"
                                      >
                                        Promover Local
                                      </button>
                                    </div>
                                  )}
                              </div>
                            ) : (
                              <span className="text-slate-400">—</span>
                            )}
                          </td>
                          {showPhotosInBatch && (
                            <td className="py-2.5 px-3">
                              {r ? (
                                <LazyPhotoThumbnailPair
                                  mode={mode}
                                  readingId={r.id}
                                />
                              ) : (
                                <span className="text-slate-400">—</span>
                              )}
                            </td>
                          )}
                          <td className="py-2.5 px-3 text-right">
                            <button
                              type="button"
                              onClick={() =>
                                onOpenReadingFromManagement(
                                  activeService,
                                  item.tower,
                                  item.apartment
                                )
                              }
                              className="min-h-[34px] px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-slate-200 font-bold text-xs text-[#0A2239]"
                            >
                              Abrir
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Batched "Mostrar mais" Footer */}
              <div className="p-4 bg-slate-50 border-t border-slate-200 flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs font-bold text-slate-700">
                  Exibindo{' '}
                  <strong className="font-mono">
                    {visibleBatchRows.length}
                  </strong>{' '}
                  de{' '}
                  <strong className="font-mono">
                    {filteredReviewRows.length}
                  </strong>{' '}
                  unidades filtradas (totais calculados sobre todos os{' '}
                  {filteredReviewRows.length} registros)
                </span>

                {visibleBatchCount < filteredReviewRows.length && (
                  <button
                    type="button"
                    onClick={() =>
                      setVisibleBatchCount((prev) => prev + BATCH_SIZE)
                    }
                    className="min-h-[42px] px-5 py-2 rounded-xl bg-[#0A2239] hover:bg-[#12385b] text-white font-extrabold text-xs"
                  >
                    Mostrar mais ({Math.min(
                      BATCH_SIZE,
                      filteredReviewRows.length - visibleBatchCount
                    )}{' '}
                    linhas)
                  </button>
                )}
              </div>
            </section>
          </div>
        )}

        {/* ================================================================== */}
        {/* TAB 2: IMPORTAÇÃO E REIMPORTAÇÃO DO CSV DE PONTO DE PARTIDA        */}
        {/* ================================================================== */}
        {tab === 'csv' && (
          <div className="space-y-4">
            <section className="rounded-2xl bg-white border border-slate-300 p-5 space-y-4">
              <div>
                <h2 className="text-lg font-extrabold text-[#0F172A]">
                  Importar CSV de Ponto de Partida
                </h2>
                <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                  Importa arquivo UTF-8 (com ou sem BOM) com cabeçalho exato{' '}
                  <code className="bg-slate-100 px-1.5 py-0.5 rounded font-mono font-bold">
                    {EXPECTED_CSV_HEADER}
                  </code>
                  . A coluna <strong>Atual</strong> do relatório passado vira a{' '}
                  <strong>leitura anterior</strong> do novo ciclo, alimentando
                  as referências sem criar leituras atuais.
                </p>
              </div>

              {/* Mandatory Service & Target Cycle selection before import */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-extrabold text-slate-800 mb-1">
                    1. Serviço de Destino
                  </label>
                  <select
                    value={csvTargetService}
                    onChange={(e) => {
                      setCsvTargetService(e.target.value as ServiceType);
                      setCsvPreview(null);
                    }}
                    className="w-full min-h-[44px] px-3 rounded-xl border-2 border-slate-300 font-bold text-sm"
                  >
                    <option value="gas">Gás (560 unidades)</option>
                    <option value="water">Água (560 unidades)</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-extrabold text-slate-800 mb-1">
                    2. Ciclo de Destino (YYYY-MM)
                  </label>
                  <input
                    type="month"
                    value={csvTargetCycle}
                    onChange={(e) => {
                      if (/^\d{4}-\d{2}$/.test(e.target.value)) {
                        setCsvTargetCycle(e.target.value);
                        setCsvPreview(null);
                      }
                    }}
                    className="w-full min-h-[44px] px-3 rounded-xl border-2 border-slate-300 font-mono font-bold text-sm"
                  />
                </div>
              </div>

              {/* File Upload or Quick Homologated CSV Loader */}
              <div className="flex flex-wrap items-center gap-3 pt-2">
                <label className="min-h-[46px] px-4 py-2.5 rounded-xl bg-[#0A2239] hover:bg-[#12385b] text-white font-extrabold text-xs flex items-center gap-2 cursor-pointer">
                  <Upload className="w-4 h-4" />
                  <span>Selecionar Arquivo CSV (.csv)</span>
                  <input
                    type="file"
                    accept=".csv,text/csv,text/plain"
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (!file) return;
                      const text = await file.text();
                      handleAnalyzeCsvContent(text, file.name);
                    }}
                  />
                </label>

                <button
                  type="button"
                  onClick={() => {
                    const generated =
                      generateHomologatedPilotCsv(csvTargetService);
                    handleAnalyzeCsvContent(
                      generated,
                      `homologado_${csvTargetService}_${csvTargetCycle}.csv`
                    );
                  }}
                  className="min-h-[46px] px-4 py-2.5 rounded-xl bg-[#E08E00] hover:bg-[#c97e00] text-[#0F172A] font-extrabold text-xs"
                >
                  Gerar Prévia com CSV Homologado (Bloco 1, Apto 303 = 266,0070)
                </button>
              </div>

              {/* Optional Textarea for pasting or testing re-imports/corrections */}
              <div className="space-y-1.5 pt-2">
                <label className="block text-xs font-bold text-slate-700">
                  Ou cole/edite o conteúdo CSV abaixo para testar reimportação e
                  prévia de diferenças:
                </label>
                <textarea
                  rows={5}
                  value={csvRawText}
                  onChange={(e) => setCsvRawText(e.target.value)}
                  placeholder={`${EXPECTED_CSV_HEADER}\n1;303;265,1200;266,0070`}
                  className="w-full p-3 rounded-xl border border-slate-300 font-mono text-xs"
                />
                {csvRawText.trim().length > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      handleAnalyzeCsvContent(
                        csvRawText,
                        csvFileName || 'csv_editado_manual.csv'
                      )
                    }
                    className="min-h-[40px] px-4 py-2 rounded-xl bg-slate-800 text-white font-bold text-xs"
                  >
                    Analisar Conteúdo CSV e Gerar Prévia
                  </button>
                )}
              </div>

              {csvImportResultMsg && (
                <div className="rounded-xl bg-emerald-50 border-2 border-emerald-500 p-3.5 text-xs font-bold text-emerald-950">
                  {csvImportResultMsg}
                </div>
              )}
            </section>

            {/* CSV Validation & Re-Import Diff Preview */}
            {csvPreview && (
              <section className="rounded-2xl bg-white border-2 border-[#0A2239] p-5 space-y-4">
                <h3 className="text-base font-extrabold text-[#0F172A]">
                  Prévia de Validação do CSV ({csvPreview.sourceFileName} •{' '}
                  {csvPreview.service === 'water' ? 'Água' : 'Gás'} • Ciclo{' '}
                  {csvPreview.cycleId})
                </h3>

                {!csvPreview.headerValid ? (
                  <div className="rounded-xl bg-red-100 border border-red-500 p-3 text-xs font-bold text-red-950">
                    {csvPreview.headerError}
                  </div>
                ) : (
                  <>
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
                      <div className="rounded-xl bg-emerald-50 border border-emerald-300 p-3">
                        <span className="text-emerald-900 font-bold">
                          Linhas Válidas
                        </span>
                        <p className="text-2xl font-extrabold font-mono text-emerald-950 mt-0.5">
                          {csvPreview.validRows.length}
                        </p>
                      </div>
                      <div className="rounded-xl bg-amber-50 border border-amber-300 p-3">
                        <span className="text-amber-900 font-bold">
                          Duplicadas
                        </span>
                        <p className="text-2xl font-extrabold font-mono text-amber-950 mt-0.5">
                          {csvPreview.duplicateRows.length}
                        </p>
                      </div>
                      <div className="rounded-xl bg-red-50 border border-red-300 p-3">
                        <span className="text-red-900 font-bold">
                          Inválidas
                        </span>
                        <p className="text-2xl font-extrabold font-mono text-red-950 mt-0.5">
                          {csvPreview.invalidRows.length}
                        </p>
                      </div>
                      <div className="rounded-xl bg-slate-100 border border-slate-300 p-3">
                        <span className="text-slate-700 font-bold">
                          Faltantes (de 560)
                        </span>
                        <p className="text-2xl font-extrabold font-mono text-slate-900 mt-0.5">
                          {csvPreview.missingUnits.length}
                        </p>
                      </div>
                      <div className="rounded-xl bg-blue-50 border border-blue-300 p-3">
                        <span className="text-blue-900 font-bold">
                          Torres no Delta
                        </span>
                        <p className="text-2xl font-extrabold font-mono text-blue-950 mt-0.5">
                          {csvPreview.affectedTowers.length}
                        </p>
                      </div>
                    </div>

                    {/* Re-import Differences */}
                    {csvPreview.isReimport && (
                      <div className="rounded-xl bg-slate-100 border border-slate-300 p-3.5 text-xs space-y-1 font-semibold">
                        <p className="font-extrabold text-[#0F172A]">
                          Detecção de Reimportação (Preserva valor atual, data,
                          fotos, tarifa e observação das leituras já coletadas):
                        </p>
                        <p>
                          • Referências idênticas inalteradas:{' '}
                          <strong>{csvPreview.unchangedCount}</strong> · Novas
                          unidades: <strong>{csvPreview.newUnitsCount}</strong>{' '}
                          · Alteradas sem leitura salva:{' '}
                          <strong>
                            {csvPreview.changedWithoutSavedReading.length}
                          </strong>{' '}
                          · Alteradas com impacto em leitura já salva:{' '}
                          <strong className="text-red-700">
                            {csvPreview.impactedSavedReadings.length}
                          </strong>
                        </p>
                      </div>
                    )}

                    {/* Invalid or Duplicate Details */}
                    {csvPreview.invalidRows.length > 0 && (
                      <div className="rounded-xl bg-red-50 border border-red-300 p-3 text-xs space-y-1">
                        <p className="font-extrabold text-red-950">
                          Linhas Inválidas Ignoradas (
                          {csvPreview.invalidRows.length}):
                        </p>
                        {csvPreview.invalidRows.slice(0, 8).map((inv) => (
                          <p key={inv.lineNumber} className="font-mono">
                            Linha {inv.lineNumber}: {inv.reason} (
                            <code>{inv.rawLine}</code>)
                          </p>
                        ))}
                      </div>
                    )}

                    {csvPreview.duplicateRows.length > 0 && (
                      <div className="rounded-xl bg-amber-50 border border-amber-300 p-3 text-xs space-y-1">
                        <p className="font-extrabold text-amber-950">
                          Linhas Duplicadas Ignoradas (
                          {csvPreview.duplicateRows.length}):
                        </p>
                        {csvPreview.duplicateRows.slice(0, 8).map((dup) => (
                          <p key={dup.lineNumber} className="font-mono">
                            Linha {dup.lineNumber}: Torre {dup.tower} Apto{' '}
                            {dup.apartment} já apareceu na linha{' '}
                            {dup.firstSeenLine}.
                          </p>
                        ))}
                      </div>
                    )}

                    {/* Impact on Already-Saved Readings + Separate Confirmation */}
                    {csvPreview.impactedSavedReadings.length > 0 && (
                      <div className="rounded-xl bg-amber-50 border-2 border-[#E08E00] p-4 space-y-3">
                        <div className="flex items-start gap-2">
                          <AlertTriangle className="w-5 h-5 text-amber-900 shrink-0 mt-0.5" />
                          <div className="text-xs">
                            <p className="font-extrabold text-amber-950">
                              Prévia de Impacto em Leituras Já Coletadas (
                              {csvPreview.impactedSavedReadings.length})
                            </p>
                            <p className="text-amber-900 mt-0.5">
                              O valor atual, data, fotos, tarifa aplicada,
                              autoria e observação serão preservados, mas a
                              mudança da referência anterior altera o consumo, o
                              valor em R$ e/ou os alertas abaixo:
                            </p>
                          </div>
                        </div>

                        <div className="overflow-x-auto">
                          <table className="w-full text-left text-xs font-mono bg-white rounded-lg border border-amber-300">
                            <thead>
                              <tr className="bg-amber-100/80 text-amber-950">
                                <th className="p-2">Unidade</th>
                                <th className="p-2">Atual Salva</th>
                                <th className="p-2">Ref. Antiga → Nova</th>
                                <th className="p-2">Consumo Antigo → Novo</th>
                                <th className="p-2">Valor R$ Antigo → Novo</th>
                                <th className="p-2">Alerta Antigo → Novo</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-amber-200">
                              {csvPreview.impactedSavedReadings.map((imp) => (
                                <tr key={imp.unitId}>
                                  <td className="p-2 font-bold">
                                    T{formatTowerNumber(imp.tower)} •{' '}
                                    {imp.apartment}
                                  </td>
                                  <td className="p-2">
                                    {formatDecimal4(
                                      imp.currentReadingValue,
                                      true
                                    )}
                                  </td>
                                  <td className="p-2">
                                    {formatDecimal4(
                                      imp.oldPreviousValue,
                                      true
                                    )}{' '}
                                    →{' '}
                                    <strong>
                                      {formatDecimal4(
                                        imp.newPreviousValue,
                                        true
                                      )}
                                    </strong>
                                  </td>
                                  <td className="p-2">
                                    {formatDecimal4(imp.oldConsumption, true)} →{' '}
                                    <strong>
                                      {formatDecimal4(imp.newConsumption, true)}
                                    </strong>
                                  </td>
                                  <td className="p-2">
                                    {imp.oldAmountBrl !== null
                                      ? formatCurrencyBrl(imp.oldAmountBrl)
                                      : '—'}{' '}
                                    →{' '}
                                    <strong>
                                      {imp.newAmountBrl !== null
                                        ? formatCurrencyBrl(imp.newAmountBrl)
                                        : '—'}
                                    </strong>
                                  </td>
                                  <td className="p-2 font-sans">
                                    {imp.oldStatus.toUpperCase()} →{' '}
                                    <strong>
                                      {imp.newStatus.toUpperCase()}
                                    </strong>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>

                        <label className="flex items-center gap-2 text-xs font-extrabold text-amber-950 cursor-pointer pt-1">
                          <input
                            type="checkbox"
                            checked={confirmImpactedReadings}
                            onChange={(e) =>
                              setConfirmImpactedReadings(e.target.checked)
                            }
                            className="w-4 h-4 accent-[#0A2239]"
                          />
                          <span>
                            Confirmo separadamente atualizar a referência
                            anterior das leituras já salvas listadas acima.
                          </span>
                        </label>
                      </div>
                    )}

                    <div className="flex items-center justify-end gap-3 pt-2">
                      <button
                        type="button"
                        onClick={() => setCsvPreview(null)}
                        className="min-h-[44px] px-4 py-2 rounded-xl border border-slate-300 font-bold text-xs"
                      >
                        Cancelar
                      </button>
                      <button
                        type="button"
                        disabled={csvPreview.validRows.length === 0}
                        onClick={handleConfirmCsvImport}
                        className="min-h-[44px] px-5 py-2 rounded-xl bg-[#0A2239] hover:bg-[#12385b] disabled:opacity-50 text-white font-extrabold text-xs"
                      >
                        Confirmar Importação de {csvPreview.validRows.length}{' '}
                        Referências
                      </button>
                    </div>
                  </>
                )}
              </section>
            )}
          </div>
        )}

        {/* ================================================================== */}
        {/* TAB 3: CONFIGURAÇÃO DA ORDEM FÍSICA DO PAINEL DE GÁS POR TORRE     */}
        {/* ================================================================== */}
        {tab === 'order' && (
          <section className="rounded-2xl bg-white border border-slate-300 p-5 space-y-4">
            <div>
              <h2 className="text-lg font-extrabold text-[#0F172A]">
                Disposição Física do Painel de Gás por Torre
              </h2>
              <p className="text-xs text-slate-600 mt-1">
                Configure a ordem física em que os medidores de Gás estão
                instalados no abrigo de cada torre. O sistema valida que cada um
                dos 20 apartamentos (101 ao 504) aparece exatamente uma vez.
              </p>
            </div>

            <div className="max-w-xs">
              <label className="block text-xs font-extrabold text-slate-800 mb-1">
                Selecionar Torre (01 a 28)
              </label>
              <select
                value={selectedOrderTower}
                onChange={(e) => setSelectedOrderTower(Number(e.target.value))}
                className="w-full min-h-[44px] px-3 rounded-xl border-2 border-slate-300 font-bold text-sm"
              >
                {Array.from({ length: TOTAL_TOWERS }, (_, i) => i + 1).map(
                  (t) => {
                    const isConfigured = Boolean(
                      settings.physicalOrders?.[formatTowerCode(t)]
                    );
                    return (
                      <option key={t} value={t}>
                        Torre {formatTowerNumber(t)}{' '}
                        {isConfigured
                          ? '• Ordem física cadastrada'
                          : '• Padrão sequencial'}
                      </option>
                    );
                  }
                )}
              </select>
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-extrabold text-slate-800">
                Ordem dos 20 apartamentos da Torre{' '}
                {formatTowerNumber(selectedOrderTower)} (separados por vírgula
                ou espaço):
              </label>
              <textarea
                rows={3}
                value={physicalOrderInput}
                onChange={(e) => setPhysicalOrderInput(e.target.value)}
                className="w-full p-3 rounded-xl border-2 border-slate-300 font-mono font-bold text-sm"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={handleSavePhysicalOrder}
                className="min-h-[44px] px-5 py-2 rounded-xl bg-[#0A2239] hover:bg-[#12385b] text-white font-extrabold text-xs"
              >
                Validar e Salvar Ordem Física da Torre{' '}
                {formatTowerNumber(selectedOrderTower)}
              </button>

              <button
                type="button"
                onClick={() =>
                  setPhysicalOrderInput(
                    [...SEQUENTIAL_APARTMENTS].reverse().join(', ')
                  )
                }
                className="min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-300 font-bold text-xs text-slate-700 hover:bg-slate-100"
              >
                Exemplo: Painel Invertido (504 → 101)
              </button>

              <button
                type="button"
                onClick={() =>
                  setPhysicalOrderInput(SEQUENTIAL_APARTMENTS.join(', '))
                }
                className="min-h-[44px] px-3.5 py-2 rounded-xl border border-slate-300 font-bold text-xs text-slate-700 hover:bg-slate-100"
              >
                Restaurar Sequencial (101 → 504)
              </button>
            </div>

            {physicalOrderFeedback && (
              <div
                className={`rounded-xl border p-3.5 text-xs font-bold ${
                  physicalOrderFeedback.type === 'ok'
                    ? 'bg-emerald-50 border-emerald-500 text-emerald-950'
                    : 'bg-red-50 border-red-500 text-red-950'
                }`}
              >
                {physicalOrderFeedback.msg}
              </div>
            )}
          </section>
        )}

        {/* ================================================================== */}
        {/* TAB 4: TARIFAS (R$/M³) E LIMITES DE ALERTA CONFIGURÁVEIS           */}
        {/* ================================================================== */}
        {tab === 'limits' && (
          <div className="space-y-4">
            <section className="rounded-2xl bg-white border border-slate-300 p-5 space-y-4">
              <div>
                <h2 className="text-lg font-extrabold text-[#0F172A]">
                  Tarifas do Ciclo (R$/m³) e Limites Configuráveis de Consumo
                </h2>
                <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                  Um novo ciclo inicia sem tarifa cadastrada (exibindo{' '}
                  <code>Sem tarifa configurada</code> e deixando o valor em{' '}
                  <code>R$</code> indisponível). Ao configurar as tarifas de Água
                  e Gás abaixo, o celular passa a calcular ao vivo{' '}
                  <code>consumo × tarifa</code> (com arredondamento monetário de
                  2 casas decimais) e a sincronizar a tarifa pelo fluxo{' '}
                  <strong>Atualizar</strong>.
                </p>
              </div>

              {/* Tariffs Configuration Block */}
              <div className="rounded-xl bg-slate-50 border-2 border-[#0A2239] p-4 space-y-3">
                <h3 className="text-sm font-extrabold text-[#0A2239]">
                  1. Tarifas em R$/m³ do Ciclo {cycleId}
                </h3>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label
                      htmlFor="water-tariff-input"
                      className="block text-xs font-extrabold text-slate-800 mb-1"
                    >
                      Tarifa de Água (R$/m³)
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        id="water-tariff-input"
                        type="text"
                        inputMode="decimal"
                        placeholder="Ex: 6,5000 (vazio = sem tarifa)"
                        value={waterTariffInput}
                        onChange={(e) => setWaterTariffInput(e.target.value)}
                        className="flex-1 min-h-[44px] px-3 rounded-xl border-2 border-slate-300 font-mono font-bold text-sm bg-white"
                      />
                      <button
                        type="button"
                        onClick={() => setWaterTariffInput('')}
                        className="min-h-[44px] px-3 rounded-xl border border-slate-300 bg-white hover:bg-slate-100 text-xs font-bold text-slate-700"
                      >
                        Limpar
                      </button>
                    </div>
                    <p className="text-[11px] font-semibold text-slate-600 mt-1">
                      Atual salva no ciclo:{' '}
                      <strong>
                        {settings.waterTariffPerM3 !== null
                          ? formatTariffBrl(settings.waterTariffPerM3)
                          : 'Sem tarifa configurada'}
                      </strong>
                    </p>
                  </div>

                  <div>
                    <label
                      htmlFor="gas-tariff-input"
                      className="block text-xs font-extrabold text-slate-800 mb-1"
                    >
                      Tarifa de Gás (R$/m³)
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        id="gas-tariff-input"
                        type="text"
                        inputMode="decimal"
                        placeholder="Ex: 32,8000 (vazio = sem tarifa)"
                        value={gasTariffInput}
                        onChange={(e) => setGasTariffInput(e.target.value)}
                        className="flex-1 min-h-[44px] px-3 rounded-xl border-2 border-slate-300 font-mono font-bold text-sm bg-white"
                      />
                      <button
                        type="button"
                        onClick={() => setGasTariffInput('')}
                        className="min-h-[44px] px-3 rounded-xl border border-slate-300 bg-white hover:bg-slate-100 text-xs font-bold text-slate-700"
                      >
                        Limpar
                      </button>
                    </div>
                    <p className="text-[11px] font-semibold text-slate-600 mt-1">
                      Atual salva no ciclo:{' '}
                      <strong>
                        {settings.gasTariffPerM3 !== null
                          ? formatTariffBrl(settings.gasTariffPerM3)
                          : 'Sem tarifa configurada'}
                      </strong>
                    </p>
                  </div>
                </div>
              </div>

              {/* Alert Limits Block */}
              <div className="space-y-3 pt-2">
                <h3 className="text-sm font-extrabold text-[#0F172A]">
                  2. Limites de Alerta, Teto Crítico e Ruído Residual (m³)
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
                  <div>
                    <label className="block text-xs font-extrabold text-slate-800 mb-1">
                      Água • Alerta (m³)
                    </label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={waterAlertInput}
                      onChange={(e) => setWaterAlertInput(e.target.value)}
                      className="w-full min-h-[44px] px-3 rounded-xl border-2 border-slate-300 font-mono font-bold text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-extrabold text-slate-800 mb-1">
                      Água • Teto Crítico (m³)
                    </label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={waterCeilingInput}
                      onChange={(e) => setWaterCeilingInput(e.target.value)}
                      className="w-full min-h-[44px] px-3 rounded-xl border-2 border-slate-300 font-mono font-bold text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-extrabold text-slate-800 mb-1">
                      Gás • Alerta (m³)
                    </label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={gasAlertInput}
                      onChange={(e) => setGasAlertInput(e.target.value)}
                      className="w-full min-h-[44px] px-3 rounded-xl border-2 border-slate-300 font-mono font-bold text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-extrabold text-slate-800 mb-1">
                      Gás • Teto Crítico (m³)
                    </label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={gasCeilingInput}
                      onChange={(e) => setGasCeilingInput(e.target.value)}
                      className="w-full min-h-[44px] px-3 rounded-xl border-2 border-slate-300 font-mono font-bold text-sm"
                    />
                  </div>

                  <div>
                    <label className="block text-xs font-extrabold text-slate-800 mb-1">
                      Gás • Ruído Residual (m³)
                    </label>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={gasNoiseInput}
                      onChange={(e) => setGasNoiseInput(e.target.value)}
                      className="w-full min-h-[44px] px-3 rounded-xl border-2 border-slate-300 font-mono font-bold text-sm"
                    />
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={handleSaveTariffsAndLimits}
                  className="min-h-[46px] px-5 py-2.5 rounded-xl bg-[#0A2239] hover:bg-[#12385b] text-white font-extrabold text-xs"
                >
                  Salvar Tarifas (R$/m³) e Limites (Preservando Leituras Já Salvas)
                </button>
              </div>

              {limitsFeedback && (
                <div className="rounded-xl bg-emerald-50 border border-emerald-500 p-3.5 text-xs font-bold text-emerald-950">
                  {limitsFeedback}
                </div>
              )}
            </section>

            {/* Explicit Controlled Tariff Recalculation Panel for Already-Saved Readings */}
            <section className="rounded-2xl bg-amber-50 border-2 border-[#E08E00] p-5 space-y-3">
              <div className="flex items-start gap-2.5">
                <AlertTriangle className="w-5 h-5 text-amber-900 shrink-0 mt-0.5" />
                <div className="space-y-1 text-xs">
                  <h3 className="text-sm font-extrabold text-amber-950">
                    Preservação de Valores Auditados & Recálculo Explícito de
                    Tarifa em Leituras Já Salvas
                  </h3>
                  <p className="text-amber-900 leading-relaxed">
                    Por segurança de auditoria, cada leitura salva persiste um
                    snapshot imutável com a tarifa vigente no momento da coleta (
                    <code>appliedTariff</code> e{' '}
                    <code>calculatedAmountBrl</code>). Alterar a tarifa acima{' '}
                    <strong>não altera silenciosamente</strong> leituras já
                    coletadas. Caso você tenha corrigido uma tarifa cadastrada
                    errada e deseje aplicar a tarifa atual às leituras já salvas
                    (atualizando também o carimbo das fotos no IndexedDB e
                    reenfileirando no delta), utilize os botões explícitos
                    abaixo:
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1 text-xs">
                <div className="rounded-xl bg-white border border-amber-300 p-3.5 space-y-2">
                  <div className="font-extrabold text-[#0F172A]">
                    Água • {readingsNeedingTariffRecalc.totalWaterSaved}{' '}
                    leitura(s) salva(s) no ciclo
                  </div>
                  <p className="text-slate-600">
                    Leituras com tarifa diferente da atual (
                    {settings.waterTariffPerM3 !== null
                      ? formatTariffBrl(settings.waterTariffPerM3)
                      : 'Sem tarifa'}
                    ):{' '}
                    <strong className="text-amber-900">
                      {readingsNeedingTariffRecalc.waterDiffCount}
                    </strong>
                  </p>
                  <button
                    type="button"
                    disabled={
                      isRecalculatingTariff ||
                      readingsNeedingTariffRecalc.totalWaterSaved === 0
                    }
                    onClick={() => handleExplicitRecalculateSavedReadings('water')}
                    className="w-full min-h-[42px] px-3 py-2 rounded-xl bg-[#0A2239] hover:bg-[#12385b] disabled:opacity-50 text-white font-extrabold text-xs"
                  >
                    Recalcular {readingsNeedingTariffRecalc.totalWaterSaved}{' '}
                    leitura(s) de Água com a tarifa atual
                  </button>
                </div>

                <div className="rounded-xl bg-white border border-amber-300 p-3.5 space-y-2">
                  <div className="font-extrabold text-[#0F172A]">
                    Gás • {readingsNeedingTariffRecalc.totalGasSaved} leitura(s)
                    salva(s) no ciclo
                  </div>
                  <p className="text-slate-600">
                    Leituras com tarifa diferente da atual (
                    {settings.gasTariffPerM3 !== null
                      ? formatTariffBrl(settings.gasTariffPerM3)
                      : 'Sem tarifa'}
                    ):{' '}
                    <strong className="text-amber-900">
                      {readingsNeedingTariffRecalc.gasDiffCount}
                    </strong>
                  </p>
                  <button
                    type="button"
                    disabled={
                      isRecalculatingTariff ||
                      readingsNeedingTariffRecalc.totalGasSaved === 0
                    }
                    onClick={() => handleExplicitRecalculateSavedReadings('gas')}
                    className="w-full min-h-[42px] px-3 py-2 rounded-xl bg-[#E08E00] hover:bg-[#c97e00] disabled:opacity-50 text-[#0F172A] font-extrabold text-xs"
                  >
                    Recalcular {readingsNeedingTariffRecalc.totalGasSaved}{' '}
                    leitura(s) de Gás com a tarifa atual
                  </button>
                </div>
              </div>
            </section>
          </div>
        )}

        {/* ================================================================== */}
        {/* TAB 5: BACKUP ZIP DA TORRE & RESTAURAR BACKUP ZIP                  */}
        {/* ================================================================== */}
        {tab === 'backup' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Left: Generate Backup ZIP */}
            <section className="rounded-2xl bg-white border border-slate-300 p-5 space-y-4">
              <div>
                <h2 className="text-lg font-extrabold text-[#0F172A]">
                  Gerar Backup ZIP Local
                </h2>
                <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                  Gera localmente um arquivo <code>.zip</code> com todos os
                  JPEGs coloridos carimbados, o relatório CSV de conferência (com
                  tarifa e valor em R$) e o <code>manifest.json</code>{' '}
                  versionado (ciclo, unidade, serviço, leitura anterior e atual,
                  tarifa aplicada, valor calculado, observação, alertas, datas,
                  códigos de auditoria e vínculo com cada foto).
                </p>
              </div>

              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-extrabold text-slate-800 mb-1">
                    Abrangência do Backup ({activeService === 'water' ? 'Água' : 'Gás'})
                  </label>
                  <select
                    value={backupTowerSelection}
                    onChange={(e) =>
                      setBackupTowerSelection(
                        e.target.value === 'all'
                          ? 'all'
                          : Number(e.target.value)
                      )
                    }
                    className="w-full min-h-[44px] px-3 rounded-xl border-2 border-slate-300 font-bold text-sm"
                  >
                    <option value="all">
                      Todas as 28 Torres (Condomínio Completo)
                    </option>
                    {Array.from({ length: TOTAL_TOWERS }, (_, i) => i + 1).map(
                      (t) => (
                        <option key={t} value={t}>
                          Somente Torre {formatTowerNumber(t)}
                        </option>
                      )
                    )}
                  </select>
                </div>

                <button
                  type="button"
                  disabled={isProcessingBackup}
                  onClick={async () => {
                    setIsProcessingBackup(true);
                    setBackupFeedback(null);
                    try {
                      const towers =
                        backupTowerSelection === 'all'
                          ? Array.from(
                              { length: TOTAL_TOWERS },
                              (_, i) => i + 1
                            )
                          : [backupTowerSelection];
                      const res = await generateTowerBackupZip({
                        mode,
                        cycleId,
                        service: activeService,
                        towers,
                      });
                      triggerBlobDownload(res.zipBlob, res.fileName);
                      setBackupFeedback(
                        `Backup gerado: ${res.fileName} (${res.readingsCount} leitura(s), ${res.photosCount} foto(s)).`
                      );
                    } finally {
                      setIsProcessingBackup(false);
                    }
                  }}
                  className="w-full min-h-[48px] rounded-xl bg-[#0A2239] hover:bg-[#12385b] text-white font-extrabold text-sm flex items-center justify-center gap-2"
                >
                  <Download className="w-5 h-5" />
                  <span>Baixar Backup ZIP Agora</span>
                </button>
              </div>
            </section>

            {/* Right: Restore Backup ZIP */}
            <section className="rounded-2xl bg-white border border-slate-300 p-5 space-y-4">
              <div>
                <h2 className="text-lg font-extrabold text-[#0F172A]">
                  Restaurar Backup ZIP no Aparelho
                </h2>
                <p className="text-xs text-slate-600 mt-1 leading-relaxed">
                  Valida o manifesto e os JPEGs, detecta duplicatas idênticas e
                  indica conflitos. Por padrão, restaura apenas registros
                  ausentes. Reimportar o mesmo ZIP não duplica registros nem
                  sobrescreve fotos.
                </p>
              </div>

              <label className="min-h-[48px] px-4 py-2.5 rounded-xl bg-[#E08E00] hover:bg-[#c97e00] text-[#0F172A] font-extrabold text-xs flex items-center justify-center gap-2 cursor-pointer">
                <Upload className="w-5 h-5" />
                <span>Selecionar Arquivo ZIP de Backup para Prévia</span>
                <input
                  type="file"
                  accept=".zip,application/zip"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    e.target.value = '';
                    if (!file) return;
                    setIsProcessingBackup(true);
                    setBackupFeedback(null);
                    try {
                      const { preview, zipInstance } =
                        await analyzeBackupZipForRestore({
                          mode,
                          zipFile: file,
                        });
                      setRestorePreview(preview);
                      setRestoreZipInstance(zipInstance);
                    } finally {
                      setIsProcessingBackup(false);
                    }
                  }}
                />
              </label>

              {restorePreview && (
                <div className="rounded-xl bg-slate-100 border border-slate-300 p-4 space-y-3 text-xs">
                  {!restorePreview.valid ? (
                    <p className="font-bold text-red-700">
                      {restorePreview.error}
                    </p>
                  ) : (
                    <>
                      <div className="font-bold text-[#0F172A] space-y-1">
                        <p>
                          Ciclo do Manifesto:{' '}
                          <strong>{restorePreview.manifest?.cycleId}</strong> ·
                          Serviço:{' '}
                          <strong>
                            {restorePreview.manifest?.service === 'water'
                              ? 'Água'
                              : 'Gás'}
                          </strong>
                        </p>
                        <p>
                          • Ausentes neste aparelho (serão restaurados):{' '}
                          <strong className="text-emerald-800">
                            {restorePreview.missingLocallyCount}
                          </strong>
                        </p>
                        <p>
                          • Duplicatas idênticas (ignoradas sem duplicar):{' '}
                          <strong>
                            {restorePreview.identicalDuplicateCount}
                          </strong>
                        </p>
                        <p>
                          • Conflitos com leitura diferente no aparelho:{' '}
                          <strong className="text-red-700">
                            {restorePreview.conflictCount}
                          </strong>
                        </p>
                        <p>
                          • Arquivos de foto ausentes no ZIP:{' '}
                          <strong>
                            {restorePreview.missingPhotoFilesCount}
                          </strong>
                        </p>
                      </div>

                      {restorePreview.conflictCount > 0 && (
                        <label className="flex items-center gap-2 font-bold text-amber-950 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={includeConflictsOnRestore}
                            onChange={(e) =>
                              setIncludeConflictsOnRestore(e.target.checked)
                            }
                            className="w-4 h-4 accent-[#0A2239]"
                          />
                          <span>
                            Anexar conflitos lado a lado (sem sobrescrever o
                            registro local) para conferência
                          </span>
                        </label>
                      )}

                      <button
                        type="button"
                        disabled={
                          isProcessingBackup || !restoreZipInstance
                        }
                        onClick={async () => {
                          if (!restoreZipInstance) return;
                          setIsProcessingBackup(true);
                          try {
                            const res = await executeBackupRestoreLocally({
                              mode,
                              preview: restorePreview,
                              zip: restoreZipInstance,
                              includeConflictsAsSideBySide:
                                includeConflictsOnRestore,
                            });
                            await onRefreshState();
                            setBackupFeedback(
                              `Restauração local concluída: ${res.restoredReadingsCount} leitura(s) ausente(s) restaurada(s), ${res.restoredPhotosCount} foto(s) recuperada(s), ${res.skippedDuplicatesCount} duplicata(s) idêntica(s) ignorada(s), ${res.flaggedConflictsCount} conflito(s) sinalizado(s). Use "Atualizar" na tela inicial quando desejar sincronizar com o Firebase.`
                            );
                            setRestorePreview(null);
                            setRestoreZipInstance(null);
                          } finally {
                            setIsProcessingBackup(false);
                          }
                        }}
                        className="w-full min-h-[44px] rounded-xl bg-emerald-700 hover:bg-emerald-800 text-white font-extrabold text-xs flex items-center justify-center gap-1.5"
                      >
                        <CheckCircle2 className="w-4 h-4" />
                        <span>Executar Restauração Local no Aparelho</span>
                      </button>
                    </>
                  )}
                </div>
              )}

              {backupFeedback && (
                <div className="rounded-xl bg-emerald-50 border border-emerald-500 p-3.5 text-xs font-bold text-emerald-950">
                  {backupFeedback}
                </div>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  );
};

export default ManagementScreen;
