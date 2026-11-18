import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Camera,
  CheckCircle2,
  Download,
  Droplet,
  Flame,
  ImagePlus,
  RotateCcw,
  Share2,
  ShieldAlert,
  Smartphone,
  Sparkles,
} from 'lucide-react';
import {
  deleteDraftRecord,
  getDraftByUnitKey,
  getPhotosForReading,
  resolveReadingConflict,
  saveDraftRecord,
  saveReadingAtomically,
} from '../db/indexedDb';
import {
  AlertLimitsConfig,
  DraftRecord,
  ExceptionType,
  OperatingMode,
  PhotoRecord,
  PhotoSlot,
  ReadingRecord,
  ReferenceRecord,
  ServiceType,
  buildUnitKey,
  formatTowerNumber,
} from '../types/domain';
import {
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
  StampedPhotoOutput,
  canBrowserShareFiles,
  createSimulatedMeterRawBlob,
  sharePhotoFile,
  stampMeterPhoto,
  triggerPhotoDownload,
} from '../utils/photoStampEngine';

interface ReadingScreenProps {
  mode: OperatingMode;
  cycleId: string;
  tower: number;
  apartment: string;
  orderedApartments: readonly string[];
  service: ServiceType;
  limits: AlertLimitsConfig;
  reference: ReferenceRecord | undefined;
  existingReading: ReadingRecord | undefined;
  allTowerReadings: Map<string, ReadingRecord>;
  authorUid: string;
  authorName: string;
  onBackToApartments: () => void;
  onSavedAndNavigateNext: (nextApartment: string | null) => void;
  onRefreshState: () => Promise<void>;
}

interface PendingDevicePhotoAttachment {
  slot: 1 | 2;
  file: File;
  confirmTower: number;
  confirmApartment: string;
  confirmValueInput: string;
}

export const ReadingScreen: React.FC<ReadingScreenProps> = ({
  mode,
  cycleId,
  tower,
  apartment,
  orderedApartments,
  service,
  limits,
  reference,
  existingReading,
  allTowerReadings,
  authorUid,
  authorName,
  onBackToApartments,
  onSavedAndNavigateNext,
  onRefreshState,
}) => {
  const unitKey = useMemo(
    () => buildUnitKey(cycleId, service, tower, apartment),
    [cycleId, service, tower, apartment]
  );

  // Guard ref to discard any delayed async image processing from a previous apartment!
  const activeUnitKeyRef = useRef<string>(unitKey);
  activeUnitKeyRef.current = unitKey;

  const previousValue =
    existingReading !== undefined
      ? existingReading.previousValue
      : reference?.previousValue ?? null;

  const [valueInput, setValueInput] = useState<string>('');
  const [observation, setObservation] = useState<string>('');
  const [exceptionType, setExceptionType] = useState<ExceptionType>('none');

  const [photo1, setPhoto1] = useState<StampedPhotoOutput | null>(null);
  const [photo2, setPhoto2] = useState<StampedPhotoOutput | null>(null);
  const [photo1PreviewUrl, setPhoto1PreviewUrl] = useState<string | null>(null);
  const [photo2PreviewUrl, setPhoto2PreviewUrl] = useState<string | null>(null);

  // Conflict photos when syncStatus === 'conflict'
  const [conflictRemotePhoto1Url, setConflictRemotePhoto1Url] = useState<
    string | null
  >(null);
  const [conflictLocalPhoto1Url, setConflictLocalPhoto1Url] = useState<
    string | null
  >(null);

  const [restoredFromDraft, setRestoredFromDraft] = useState<boolean>(false);
  const [isProcessingPhoto, setIsProcessingPhoto] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [showEndOfTowerModal, setShowEndOfTowerModal] =
    useState<boolean>(false);
  const [isBackingUpTower, setIsBackingUpTower] = useState<boolean>(false);

  // Modal state for "Anexar foto do aparelho" (requiring explicit user confirmation of unit and value)
  const [pendingAttachment, setPendingAttachment] =
    useState<PendingDevicePhotoAttachment | null>(null);

  const camera1InputRef = useRef<HTMLInputElement | null>(null);
  const camera2InputRef = useRef<HTMLInputElement | null>(null);
  const attach1InputRef = useRef<HTMLInputElement | null>(null);
  const attach2InputRef = useRef<HTMLInputElement | null>(null);

  // Manage ObjectURLs cleanly to avoid memory leaks
  useEffect(() => {
    if (!photo1) {
      setPhoto1PreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(photo1.stampedBlob);
    setPhoto1PreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [photo1]);

  useEffect(() => {
    if (!photo2) {
      setPhoto2PreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(photo2.stampedBlob);
    setPhoto2PreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [photo2]);

  // Load existing reading, conflict photos, or pending draft from IndexedDB on apartment mount
  useEffect(() => {
    let cancelled = false;
    const currentUnitKey = unitKey;
    const revokableConflictUrls: string[] = [];

    async function loadInitialUnitState() {
      setErrorMessage(null);
      setInfoMessage(null);
      setShowEndOfTowerModal(false);

      const draft = await getDraftByUnitKey(mode, currentUnitKey);
      if (cancelled || activeUnitKeyRef.current !== currentUnitKey) return;

      if (draft) {
        setValueInput(draft.currentValueInput);
        setObservation(draft.observation);
        setExceptionType(draft.exceptionType);
        setRestoredFromDraft(true);

        if (draft.stampedPhoto1) {
          setPhoto1({
            stampedBlob: draft.stampedPhoto1,
            rawBlob: draft.rawPhoto1 || draft.stampedPhoto1,
            auditCode: draft.auditCode1 || '',
            fileName: `${currentUnitKey}_F1.jpg`,
            stampedValue: draft.stampedValue1 ?? 0,
            stampedTariff: null,
            stampedAmountBrl: null,
            capturedAt: draft.capturedAt1 || draft.updatedAt,
            width: 1024,
            height: 768,
            sizeBytes: draft.stampedPhoto1.size,
          });
        } else {
          setPhoto1(null);
        }

        if (draft.stampedPhoto2) {
          setPhoto2({
            stampedBlob: draft.stampedPhoto2,
            rawBlob: draft.rawPhoto2 || draft.stampedPhoto2,
            auditCode: draft.auditCode2 || '',
            fileName: `${currentUnitKey}_F2.jpg`,
            stampedValue: draft.stampedValue2 ?? 0,
            stampedTariff: null,
            stampedAmountBrl: null,
            capturedAt: draft.capturedAt2 || draft.updatedAt,
            width: 1024,
            height: 768,
            sizeBytes: draft.stampedPhoto2.size,
          });
        } else {
          setPhoto2(null);
        }
        return;
      }

      setRestoredFromDraft(false);

      if (existingReading) {
        setValueInput(formatDecimal4(existingReading.currentValue, true));
        setObservation(existingReading.observation);
        setExceptionType(existingReading.exceptionType);

        const photosMap: Map<PhotoSlot, PhotoRecord> =
          await getPhotosForReading(mode, existingReading.id);
        if (cancelled || activeUnitKeyRef.current !== currentUnitKey) return;

        const p1 = photosMap.get('1');
        if (p1) {
          setPhoto1({
            stampedBlob: p1.stampedBlob,
            rawBlob: p1.rawBlob || p1.stampedBlob,
            auditCode: p1.auditCode,
            fileName: p1.fileName,
            stampedValue: p1.stampedValue,
            stampedTariff: p1.stampedTariff ?? existingReading.appliedTariff ?? null,
            stampedAmountBrl:
              p1.stampedAmountBrl ?? existingReading.calculatedAmountBrl ?? null,
            capturedAt: p1.capturedAt,
            width: p1.width,
            height: p1.height,
            sizeBytes: p1.sizeBytes,
          });
        } else {
          setPhoto1(null);
        }

        const p2 = photosMap.get('2');
        if (p2) {
          setPhoto2({
            stampedBlob: p2.stampedBlob,
            rawBlob: p2.rawBlob || p2.stampedBlob,
            auditCode: p2.auditCode,
            fileName: p2.fileName,
            stampedValue: p2.stampedValue,
            stampedTariff: p2.stampedTariff ?? existingReading.appliedTariff ?? null,
            stampedAmountBrl:
              p2.stampedAmountBrl ?? existingReading.calculatedAmountBrl ?? null,
            capturedAt: p2.capturedAt,
            width: p2.width,
            height: p2.height,
            sizeBytes: p2.sizeBytes,
          });
        } else {
          setPhoto2(null);
        }

        if (existingReading.syncStatus === 'conflict') {
          const cp1 = photosMap.get('conflict_1');
          if (p1) {
            const u1 = URL.createObjectURL(p1.stampedBlob);
            revokableConflictUrls.push(u1);
            setConflictRemotePhoto1Url(u1);
          }
          if (cp1) {
            const uc1 = URL.createObjectURL(cp1.stampedBlob);
            revokableConflictUrls.push(uc1);
            setConflictLocalPhoto1Url(uc1);
          }
        }
      } else {
        setValueInput('');
        setObservation('');
        setExceptionType('none');
        setPhoto1(null);
        setPhoto2(null);
      }
    }

    loadInitialUnitState();

    return () => {
      cancelled = true;
      for (const u of revokableConflictUrls) {
        URL.revokeObjectURL(u);
      }
    };
  }, [unitKey, mode, existingReading]);

  const parsedCurrentValue = useMemo(
    () => parseDecimalInput(valueInput),
    [valueInput]
  );

  // If editing an already-saved reading whose value has not changed yet, preserve its audited tariff snapshot
  // unless a new cycle tariff is configured and the reader is actively typing/saving
  const activeTariffOverride = useMemo(() => {
    const cycleTariff =
      service === 'water' ? limits.waterTariffPerM3 : limits.gasTariffPerM3;
    if (
      existingReading &&
      existingReading.currentValue === parsedCurrentValue &&
      existingReading.exceptionType === exceptionType &&
      existingReading.appliedTariff !== undefined &&
      existingReading.appliedTariff !== null
    ) {
      return existingReading.appliedTariff;
    }
    return cycleTariff;
  }, [service, limits, existingReading, parsedCurrentValue, exceptionType]);

  // Immediate local consumption, monetary (R$), and alert evaluation on every keystroke!
  const evaluation = useMemo(
    () =>
      evaluateReading({
        service,
        previousValue,
        currentValue: parsedCurrentValue,
        limits,
        exceptionType,
        tariffOverridePerM3: activeTariffOverride,
      }),
    [
      service,
      previousValue,
      parsedCurrentValue,
      limits,
      exceptionType,
      activeTariffOverride,
    ]
  );

  // Persist draft immediately to IndexedDB whenever user types or captures a photo
  const persistDraftNow = async (overrides?: {
    valInput?: string;
    obs?: string;
    exc?: ExceptionType;
    p1?: StampedPhotoOutput | null;
    p2?: StampedPhotoOutput | null;
  }) => {
    const targetUnitKey = activeUnitKeyRef.current;
    const nextVal = overrides?.valInput ?? valueInput;
    const nextObs = overrides?.obs ?? observation;
    const nextExc = overrides?.exc ?? exceptionType;
    const nextP1 = overrides?.p1 !== undefined ? overrides.p1 : photo1;
    const nextP2 = overrides?.p2 !== undefined ? overrides.p2 : photo2;

    if (!nextVal && !nextObs && !nextP1 && !nextP2) return;

    const draft: DraftRecord = {
      unitKey: targetUnitKey,
      cycleId,
      service,
      tower,
      apartment,
      currentValueInput: nextVal,
      observation: nextObs,
      exceptionType: nextExc,
      rawPhoto1: nextP1?.rawBlob,
      stampedPhoto1: nextP1?.stampedBlob,
      auditCode1: nextP1?.auditCode,
      stampedValue1: nextP1?.stampedValue,
      capturedAt1: nextP1?.capturedAt,
      rawPhoto2: nextP2?.rawBlob,
      stampedPhoto2: nextP2?.stampedBlob,
      auditCode2: nextP2?.auditCode,
      stampedValue2: nextP2?.stampedValue,
      capturedAt2: nextP2?.capturedAt,
      updatedAt: new Date().toISOString(),
    };
    await saveDraftRecord(mode, draft).catch(() => {});
  };

  const handleCaptureOrStampPhoto = async (
    rawBlob: Blob,
    slot: 1 | 2,
    overrideNumericValue?: number | null
  ) => {
    const guardUnitKey = unitKey;
    setIsProcessingPhoto(true);
    setErrorMessage(null);
    try {
      const capturedAtIso = new Date().toISOString();
      const valToStamp =
        overrideNumericValue !== undefined
          ? overrideNumericValue
          : parsedCurrentValue;

      const evalForStamp = evaluateReading({
        service,
        previousValue,
        currentValue: valToStamp,
        limits,
        exceptionType,
        tariffOverridePerM3: activeTariffOverride,
      });

      const stamped = await stampMeterPhoto({
        rawBlob,
        cycleId,
        tower,
        apartment,
        service,
        currentValue: valToStamp,
        previousValue,
        consumption: evalForStamp.consumption,
        appliedTariff: evalForStamp.appliedTariff,
        calculatedAmountBrl: evalForStamp.calculatedAmountBrl,
        amountUnavailableReason: evalForStamp.amountUnavailableReason,
        slot,
        capturedAtIso,
      });

      // Ignore late processing if user switched to another apartment!
      if (activeUnitKeyRef.current !== guardUnitKey) {
        return;
      }

      if (slot === 1) {
        setPhoto1(stamped);
        await persistDraftNow({ p1: stamped });
      } else {
        setPhoto2(stamped);
        await persistDraftNow({ p2: stamped });
      }
    } catch (err) {
      if (activeUnitKeyRef.current === guardUnitKey) {
        setErrorMessage(
          err instanceof Error
            ? `Erro ao processar foto: ${err.message}`
            : 'Erro ao processar a foto.'
        );
      }
    } finally {
      if (activeUnitKeyRef.current === guardUnitKey) {
        setIsProcessingPhoto(false);
      }
    }
  };

  const handleSimulateCameraPhoto = async (slot: 1 | 2) => {
    const val = parsedCurrentValue ?? (previousValue ? previousValue + 0.837 : 100);
    const simulatedRaw = await createSimulatedMeterRawBlob({
      tower,
      apartment,
      service,
      value: val,
    });
    await handleCaptureOrStampPhoto(simulatedRaw, slot, val);
  };

  const handleDiscardDraft = async () => {
    await deleteDraftRecord(mode, unitKey);
    setRestoredFromDraft(false);
    if (existingReading) {
      setValueInput(formatDecimal4(existingReading.currentValue, true));
      setObservation(existingReading.observation);
      setExceptionType(existingReading.exceptionType);
    } else {
      setValueInput('');
      setObservation('');
      setExceptionType('none');
      setPhoto1(null);
      setPhoto2(null);
    }
  };

  const currentIdx = orderedApartments.indexOf(apartment);
  const isLastApartment =
    currentIdx >= 0 && currentIdx === orderedApartments.length - 1;
  const nextApartment =
    currentIdx >= 0 && currentIdx + 1 < orderedApartments.length
      ? orderedApartments[currentIdx + 1]
      : null;

  const handleSaveAndAdvance = async () => {
    setErrorMessage(null);
    setInfoMessage(null);
    const guardUnitKey = unitKey;

    if (parsedCurrentValue === null) {
      setErrorMessage(
        'Digite uma leitura atual válida (use ponto ou vírgula, com até 4 casas decimais).'
      );
      return;
    }

    if (!photo1) {
      setErrorMessage(
        'A 1ª foto carimbada do medidor é obrigatória antes de salvar.'
      );
      return;
    }

    if (evaluation.requiresJustification && observation.trim().length < 4) {
      setErrorMessage(
        'Esta leitura possui alerta/exceção. Preencha uma justificativa na Observação antes de salvar.'
      );
      return;
    }

    if (evaluation.requiresSecondPhoto && !photo2) {
      setErrorMessage(
        'Esta leitura possui alerta/exceção e exige a 2ª foto de validação do mostrador.'
      );
      return;
    }

    setIsSaving(true);
    try {
      // Determine final exceptionType if user confirmed an alert
      let finalExceptionType: ExceptionType = exceptionType;
      if (finalExceptionType === 'none') {
        if (evaluation.alerts.includes('NEGATIVE_CONSUMPTION')) {
          finalExceptionType = 'confirmed_negative';
        } else if (
          evaluation.alerts.includes('HIGH_CONSUMPTION') ||
          evaluation.alerts.includes('CEILING_EXCEEDED')
        ) {
          finalExceptionType = 'confirmed_high';
        }
      }

      const finalEval = evaluateReading({
        service,
        previousValue,
        currentValue: parsedCurrentValue,
        limits,
        exceptionType: finalExceptionType,
        tariffOverridePerM3: activeTariffOverride,
      });

      // If the user corrected the reading value, exceptionType, or tariff AFTER taking photo1 or photo2,
      // regenerate the final stamped photo with the exact final reading, tariff, and R$ value before saving!
      let finalPhoto1 = photo1;
      if (
        photo1.stampedValue !== parsedCurrentValue ||
        photo1.stampedTariff !== finalEval.appliedTariff ||
        photo1.stampedAmountBrl !== finalEval.calculatedAmountBrl
      ) {
        finalPhoto1 = await stampMeterPhoto({
          rawBlob: photo1.rawBlob || photo1.stampedBlob,
          cycleId,
          tower,
          apartment,
          service,
          currentValue: parsedCurrentValue,
          previousValue,
          consumption: finalEval.consumption,
          appliedTariff: finalEval.appliedTariff,
          calculatedAmountBrl: finalEval.calculatedAmountBrl,
          amountUnavailableReason: finalEval.amountUnavailableReason,
          slot: 1,
          capturedAtIso: photo1.capturedAt,
        });
        if (activeUnitKeyRef.current !== guardUnitKey) return;
        setPhoto1(finalPhoto1);
      }

      let finalPhoto2 = photo2;
      if (
        photo2 &&
        (photo2.stampedValue !== parsedCurrentValue ||
          photo2.stampedTariff !== finalEval.appliedTariff ||
          photo2.stampedAmountBrl !== finalEval.calculatedAmountBrl)
      ) {
        finalPhoto2 = await stampMeterPhoto({
          rawBlob: photo2.rawBlob || photo2.stampedBlob,
          cycleId,
          tower,
          apartment,
          service,
          currentValue: parsedCurrentValue,
          previousValue,
          consumption: finalEval.consumption,
          appliedTariff: finalEval.appliedTariff,
          calculatedAmountBrl: finalEval.calculatedAmountBrl,
          amountUnavailableReason: finalEval.amountUnavailableReason,
          slot: 2,
          capturedAtIso: photo2.capturedAt,
        });
        if (activeUnitKeyRef.current !== guardUnitKey) return;
        setPhoto2(finalPhoto2);
      }

      // Atomic IndexedDB write (reading + photos + syncQueue + draft cleanup)
      await saveReadingAtomically({
        mode,
        cycleId,
        service,
        tower,
        apartment,
        previousValue,
        currentValue: parsedCurrentValue,
        exceptionType: finalExceptionType,
        observation,
        limits,
        tariffOverridePerM3: activeTariffOverride,
        photo1: finalPhoto1,
        photo2: finalPhoto2,
        authorUid,
        authorName,
      });

      if (activeUnitKeyRef.current !== guardUnitKey) return;
      await onRefreshState();

      if (isLastApartment) {
        setShowEndOfTowerModal(true);
      } else {
        onSavedAndNavigateNext(nextApartment);
      }
    } catch (err) {
      setErrorMessage(
        err instanceof Error
          ? `Falha ao gravar no aparelho (rascunho preservado): ${err.message}`
          : 'Falha ao gravar leitura no aparelho. O rascunho foi preservado.'
      );
    } finally {
      if (activeUnitKeyRef.current === guardUnitKey) {
        setIsSaving(false);
      }
    }
  };

  const handleResolveConflict = async (chosen: 'remote' | 'local') => {
    if (!existingReading) return;
    setIsSaving(true);
    try {
      await resolveReadingConflict({
        mode,
        readingId: existingReading.id,
        chosenSource: chosen,
        authorUid,
        authorName,
      });
      await onRefreshState();
      setInfoMessage(
        chosen === 'remote'
          ? 'Mantida a versão sincronizada do servidor.'
          : 'Tentativa local promovida como nova revisão e adicionada à fila.'
      );
    } catch (err) {
      setErrorMessage(
        err instanceof Error ? err.message : 'Erro ao resolver conflito.'
      );
    } finally {
      setIsSaving(false);
    }
  };

  const handleTowerBackupFromModal = async () => {
    setIsBackingUpTower(true);
    try {
      const res = await generateTowerBackupZip({
        mode,
        cycleId,
        service,
        towers: [tower],
      });
      triggerBlobDownload(res.zipBlob, res.fileName);
    } finally {
      setIsBackingUpTower(false);
    }
  };

  // Compute tower summary for the end-of-tower summary modal (including total R$)
  const towerSummaryStats = useMemo(() => {
    const cycleTariff =
      service === 'water' ? limits.waterTariffPerM3 : limits.gasTariffPerM3;
    let readCount = 0;
    let alertCount = 0;
    let totalConsScaled = 0;
    let totalAmountCents = 0;
    let validAmountCount = 0;

    for (const apt of orderedApartments) {
      const uId = buildUnitKey(cycleId, service, tower, apt);
      if (apt === apartment && parsedCurrentValue !== null) {
        readCount++;
        if (evaluation.status === 'alert') alertCount++;
        if (
          evaluation.consumption !== null &&
          exceptionType !== 'meter_replaced'
        ) {
          totalConsScaled += Math.round(evaluation.consumption * 10000);
        }
        if (evaluation.calculatedAmountBrl !== null) {
          totalAmountCents += Math.round(evaluation.calculatedAmountBrl * 100);
          validAmountCount++;
        }
      } else {
        const r = allTowerReadings.get(uId);
        if (r) {
          readCount++;
          if (r.status === 'alert') alertCount++;
          if (
            r.consumption !== null &&
            r.exceptionType !== 'meter_replaced'
          ) {
            totalConsScaled += Math.round(r.consumption * 10000);
          }
          const fin = getAuditedReadingFinancials(r, cycleTariff);
          if (fin.calculatedAmountBrl !== null) {
            totalAmountCents += Math.round(fin.calculatedAmountBrl * 100);
            validAmountCount++;
          }
        }
      }
    }
    return {
      readCount,
      alertCount,
      totalConsumption: totalConsScaled / 10000,
      totalAmountBrl: validAmountCount > 0 ? totalAmountCents / 100 : null,
      validAmountCount,
    };
  }, [
    orderedApartments,
    cycleId,
    service,
    tower,
    apartment,
    parsedCurrentValue,
    evaluation,
    exceptionType,
    allTowerReadings,
    limits,
  ]);

  return (
    <div className="min-h-screen flex flex-col bg-[#F4F6F9] text-[#0F172A]">
      {/* Sticky Top Bar always keeping Tower and Apartment visible */}
      <header className="sticky top-0 z-30 bg-[#0A2239] text-white shadow-md">
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <button
              type="button"
              onClick={onBackToApartments}
              aria-label="Voltar para lista de apartamentos"
              className="min-h-[44px] min-w-[44px] -ml-2 rounded-xl flex items-center justify-center hover:bg-white/10 active:bg-white/20 transition"
            >
              <ArrowLeft className="w-6 h-6" />
            </button>
            <h1 className="text-xl font-extrabold tracking-tight truncate">
              Torre {formatTowerNumber(tower)} • Apto {apartment}
            </h1>
          </div>

          <span className="text-xs font-mono font-bold bg-white/15 px-2.5 py-1 rounded-lg shrink-0">
            {currentIdx + 1}/{orderedApartments.length}
          </span>
        </div>
      </header>

      <main className="flex-1 max-w-2xl w-full mx-auto px-4 py-4 space-y-4">
        {/* Service Banner always visible (matching right screen of PNG reference) */}
        <div
          className={`rounded-xl px-4 py-2.5 flex items-center justify-between gap-2 font-extrabold text-base ${
            service === 'gas'
              ? 'bg-[#FDE68A] text-[#0F172A]'
              : 'bg-[#E0F2FE] text-[#0A2239]'
          }`}
        >
          <div className="flex items-center gap-2">
            {service === 'gas' ? (
              <Flame className="w-5 h-5 fill-[#D97706] text-[#D97706]" />
            ) : (
              <Droplet className="w-5 h-5 fill-[#0D8A9E] text-[#0D8A9E]" />
            )}
            <span>{service === 'gas' ? 'Gás' : 'Água'}</span>
          </div>

          <div className="flex items-center gap-2 text-xs font-bold">
            {existingReading ? (
              existingReading.syncStatus === 'synced' ? (
                <span className="px-2 py-0.5 rounded bg-emerald-700 text-white">
                  Sincronizada (Rev {existingReading.revision})
                </span>
              ) : existingReading.syncStatus === 'conflict' ? (
                <span className="px-2 py-0.5 rounded bg-red-700 text-white">
                  Conflito entre aparelhos
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-800 text-white">
                  <Smartphone className="w-3.5 h-3.5" />
                  <span>Salva no aparelho</span>
                </span>
              )
            ) : (
              <span className="text-slate-700">Nova coleta</span>
            )}
          </div>
        </div>

        {/* Dual-Device Conflict Comparison Box (Preserves both versions and photos!) */}
        {existingReading?.syncStatus === 'conflict' &&
          existingReading.conflictCandidate && (
            <section className="rounded-2xl bg-red-50 border-2 border-red-600 p-4 space-y-3">
              <div className="flex items-start gap-2.5">
                <ShieldAlert className="w-6 h-6 text-red-700 shrink-0 mt-0.5" />
                <div>
                  <h2 className="text-sm font-extrabold text-red-950">
                    Conflito Detectado entre Aparelhos — Ambas as evidências
                    foram preservadas
                  </h2>
                  <p className="text-xs text-red-900 mt-0.5">
                    Dois leituristas registraram esta mesma unidade e serviço
                    offline. Compare os dois valores e fotos abaixo e escolha
                    qual versão confirmar.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {/* Version A: Synchronized in Firestore */}
                <div className="rounded-xl bg-white border border-slate-300 p-3 space-y-2">
                  <span className="text-[11px] font-extrabold uppercase text-emerald-800">
                    1. Versão Sincronizada (Nuvem)
                  </span>
                  <p className="text-xl font-extrabold font-mono tabular-nums text-[#0F172A]">
                    {formatDecimal4(existingReading.currentValue, true)} m³
                  </p>
                  <p className="text-xs text-slate-700">
                    Consumo:{' '}
                    <strong>
                      {formatDecimal4(existingReading.consumption, true)} m³
                    </strong>
                    {existingReading.calculatedAmountBrl !== null &&
                      existingReading.calculatedAmountBrl !== undefined && (
                        <>
                          {' '}
                          •{' '}
                          <strong>
                            {formatCurrencyBrl(
                              existingReading.calculatedAmountBrl
                            )}
                          </strong>
                        </>
                      )}
                    <br />
                    Autor: <strong>{existingReading.updatedByName}</strong>
                    <br />
                    Obs: {existingReading.observation || '—'}
                  </p>
                  {conflictRemotePhoto1Url && (
                    <img
                      src={conflictRemotePhoto1Url}
                      alt="Foto da versão sincronizada"
                      referrerPolicy="no-referrer"
                      className="w-full h-32 object-cover rounded-lg border border-slate-300"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => handleResolveConflict('remote')}
                    disabled={isSaving}
                    className="w-full min-h-[40px] rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white font-bold text-xs"
                  >
                    Manter Versão Sincronizada
                  </button>
                </div>

                {/* Version B: Local Attempt on this device */}
                <div className="rounded-xl bg-white border border-amber-400 p-3 space-y-2">
                  <span className="text-[11px] font-extrabold uppercase text-amber-800">
                    2. Tentativa Local (Este Aparelho)
                  </span>
                  <p className="text-xl font-extrabold font-mono tabular-nums text-[#0F172A]">
                    {formatDecimal4(
                      existingReading.conflictCandidate.currentValue,
                      true
                    )}{' '}
                    m³
                  </p>
                  <p className="text-xs text-slate-700">
                    Consumo:{' '}
                    <strong>
                      {formatDecimal4(
                        existingReading.conflictCandidate.consumption,
                        true
                      )}{' '}
                      m³
                    </strong>
                    {existingReading.conflictCandidate.calculatedAmountBrl !==
                      null &&
                      existingReading.conflictCandidate.calculatedAmountBrl !==
                        undefined && (
                        <>
                          {' '}
                          •{' '}
                          <strong>
                            {formatCurrencyBrl(
                              existingReading.conflictCandidate
                                .calculatedAmountBrl
                            )}
                          </strong>
                        </>
                      )}
                    <br />
                    Autor:{' '}
                    <strong>
                      {existingReading.conflictCandidate.updatedByName}
                    </strong>
                    <br />
                    Obs: {existingReading.conflictCandidate.observation || '—'}
                  </p>
                  {conflictLocalPhoto1Url && (
                    <img
                      src={conflictLocalPhoto1Url}
                      alt="Foto da tentativa local"
                      referrerPolicy="no-referrer"
                      className="w-full h-32 object-cover rounded-lg border border-slate-300"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => handleResolveConflict('local')}
                    disabled={isSaving}
                    className="w-full min-h-[40px] rounded-lg bg-[#E08E00] hover:bg-[#c97e00] text-[#0F172A] font-extrabold text-xs"
                  >
                    Promover Tentativa Local (Rev {existingReading.revision + 1})
                  </button>
                </div>
              </div>
            </section>
          )}

        {/* Recovered Draft Banner */}
        {restoredFromDraft && (
          <div className="rounded-xl bg-amber-50 border border-amber-400 px-3.5 py-2.5 flex items-center justify-between gap-2 text-xs">
            <span className="font-bold text-amber-950">
              Rascunho não salvo recuperado automaticamente do IndexedDB.
            </span>
            <button
              type="button"
              onClick={handleDiscardDraft}
              className="inline-flex items-center gap-1 font-extrabold text-red-700 underline whitespace-nowrap"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Descartar rascunho</span>
            </button>
          </div>
        )}

        {/* Anterior, Consumo (m³) & Valor (R$) Rows matching PNG reference + monetary audit */}
        <div className="space-y-2">
          <div className="rounded-xl bg-[#E2E8F0]/80 px-4 py-3 flex items-center justify-between">
            <span className="text-sm font-bold text-[#0F172A]">Anterior</span>
            {previousValue !== null ? (
              <span className="text-base font-extrabold font-mono tabular-nums text-[#0F172A]">
                {formatDecimal4(previousValue, true)} m³
              </span>
            ) : (
              <span className="text-sm font-extrabold text-amber-800">
                Sem leitura anterior
              </span>
            )}
          </div>

          <div className="rounded-xl bg-[#E2E8F0]/80 px-4 py-3 flex items-center justify-between">
            <div>
              <span className="text-sm font-bold text-[#0F172A]">Consumo</span>
              <span className="block text-[11px] font-semibold text-slate-600">
                Ref: Limite {formatDecimal4(evaluation.alertLimitUsed, true)} m³
                / Teto {formatDecimal4(evaluation.ceilingLimitUsed, true)} m³
              </span>
            </div>
            <span
              className={`text-base font-extrabold font-mono tabular-nums ${
                evaluation.status === 'alert'
                  ? 'text-red-700'
                  : 'text-[#0F172A]'
              }`}
            >
              {evaluation.excludeFromTotals
                ? 'Troca de medidor (Excluído)'
                : evaluation.consumption !== null
                ? `${formatDecimal4(evaluation.consumption, true)} m³`
                : '—'}
            </span>
          </div>

          {/* Live Monetary Calculation (R$) and Applied Tariff (R$/m³) */}
          <div className="rounded-xl bg-[#E2E8F0]/80 px-4 py-3 flex items-center justify-between gap-2">
            <div>
              <span className="text-sm font-bold text-[#0F172A]">
                Valor Calculado (R$)
              </span>
              <span className="block text-[11px] font-semibold text-slate-600">
                {evaluation.appliedTariff !== null &&
                evaluation.appliedTariff > 0 ? (
                  <>
                    Tarifa aplicada:{' '}
                    <strong className="font-mono text-[#0A2239]">
                      {formatTariffBrl(evaluation.appliedTariff)}
                    </strong>
                  </>
                ) : (
                  <span className="text-amber-900 font-bold">
                    Sem tarifa configurada na Gestão
                  </span>
                )}
              </span>
            </div>

            <div className="text-right">
              {evaluation.calculatedAmountBrl !== null ? (
                <span className="text-lg font-extrabold font-mono tabular-nums text-emerald-900">
                  {formatCurrencyBrl(evaluation.calculatedAmountBrl)}
                </span>
              ) : (
                <span className="text-xs font-extrabold text-amber-900 bg-amber-100 border border-amber-300 px-2.5 py-1 rounded-lg inline-block">
                  {evaluation.amountUnavailableReason || 'Indisponível'}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Leitura Atual Input matching PNG reference (Enter opens camera!) */}
        <div className="space-y-1.5">
          <label
            htmlFor="leitura-atual-input"
            className="block text-base font-extrabold text-[#0F172A]"
          >
            Leitura atual
          </label>
          <input
            id="leitura-atual-input"
            type="text"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0,0000"
            value={valueInput}
            onChange={(e) => {
              const next = e.target.value;
              setValueInput(next);
              persistDraftNow({ valInput: next });
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                camera1InputRef.current?.click();
              }
            }}
            className="w-full min-h-[64px] px-4 py-3 rounded-xl bg-white border-2 border-slate-400 focus:border-[#0A2239] focus:outline-none text-3xl font-extrabold font-mono tabular-nums text-[#0F172A] shadow-2xs"
          />
          <p className="text-xs font-semibold text-slate-600">
            Aceita vírgula ou ponto (4 casas decimais). Pressione{' '}
            <strong>Enter</strong> para abrir a câmera traseira.
          </p>
        </div>

        {/* Immediate Real-Time Alert Banner & Meter Replacement Toggle */}
        {(evaluation.primaryAlertMessage || exceptionType === 'meter_replaced') && (
          <div
            className={`rounded-xl border-2 p-3.5 space-y-2 ${
              evaluation.status === 'alert'
                ? 'bg-red-50 border-red-500 text-red-950'
                : 'bg-amber-50 border-amber-400 text-amber-950'
            }`}
          >
            <div className="flex items-start gap-2.5">
              <AlertTriangle className="w-5 h-5 shrink-0 mt-0.5" />
              <div className="space-y-1 text-xs font-bold">
                <p>{evaluation.primaryAlertMessage}</p>
                {evaluation.alerts.length > 0 && (
                  <p className="text-[11px] opacity-90">
                    Classificação:{' '}
                    {evaluation.alerts.map(formatAlertLabel).join(' • ')}
                  </p>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Meter Replacement Checkbox */}
        <label className="flex items-center gap-2.5 rounded-xl bg-white border border-slate-300 px-3.5 py-2.5 text-xs font-bold text-[#0F172A] cursor-pointer">
          <input
            type="checkbox"
            checked={exceptionType === 'meter_replaced'}
            onChange={(e) => {
              const nextExc: ExceptionType = e.target.checked
                ? 'meter_replaced'
                : 'none';
              setExceptionType(nextExc);
              persistDraftNow({ exc: nextExc });
            }}
            className="w-4 h-4 rounded accent-[#0A2239]"
          />
          <span>
            Medidor novo ou trocado (exclui consumo e valor R$ distorcido dos
            totais da torre)
          </span>
        </label>

        {/* Observação Input matching PNG reference */}
        <div className="space-y-1.5">
          <label
            htmlFor="observacao-input"
            className="block text-base font-extrabold text-[#0F172A]"
          >
            Observação{' '}
            {evaluation.requiresJustification && (
              <span className="text-xs font-bold text-red-700">
                (Justificativa obrigatória para confirmar exceção)
              </span>
            )}
          </label>
          <input
            id="observacao-input"
            type="text"
            placeholder={
              evaluation.requiresJustification
                ? 'Descreva o motivo da exceção ou número do novo medidor'
                : 'Opcional'
            }
            value={observation}
            onChange={(e) => {
              const next = e.target.value;
              setObservation(next);
              persistDraftNow({ obs: next });
            }}
            className={`w-full min-h-[48px] px-3.5 py-2.5 rounded-xl bg-white border-2 text-sm font-semibold text-[#0F172A] focus:outline-none ${
              evaluation.requiresJustification && observation.trim().length < 4
                ? 'border-red-500'
                : 'border-slate-300 focus:border-[#0A2239]'
            }`}
          />
        </div>

        {/* Hidden file inputs for Rear Camera and Device JPEG Attachment */}
        <input
          ref={camera1InputRef}
          type="file"
          accept="image/jpeg,image/png,image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) {
              handleCaptureOrStampPhoto(file, 1);
            }
          }}
        />
        <input
          ref={camera2InputRef}
          type="file"
          accept="image/jpeg,image/png,image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) {
              handleCaptureOrStampPhoto(file, 2);
            }
          }}
        />
        <input
          ref={attach1InputRef}
          type="file"
          accept="image/jpeg,image/png,image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) {
              setPendingAttachment({
                slot: 1,
                file,
                confirmTower: tower,
                confirmApartment: apartment,
                confirmValueInput:
                  valueInput ||
                  (previousValue !== null
                    ? formatDecimal4(previousValue + 0.837, true)
                    : '0,0000'),
              });
            }
          }}
        />
        <input
          ref={attach2InputRef}
          type="file"
          accept="image/jpeg,image/png,image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) {
              setPendingAttachment({
                slot: 2,
                file,
                confirmTower: tower,
                confirmApartment: apartment,
                confirmValueInput: valueInput || '0,0000',
              });
            }
          }}
        />

        {/* Visible Camera Capture & Attach Buttons */}
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => camera1InputRef.current?.click()}
              disabled={isProcessingPhoto}
              className="flex-1 min-h-[48px] px-4 py-2.5 rounded-xl bg-[#0A2239] hover:bg-[#12385b] text-white font-extrabold text-sm flex items-center justify-center gap-2 shadow-xs transition"
            >
              <Camera className="w-5 h-5 shrink-0" />
              <span>
                {photo1 ? 'Refazer 1ª Foto (Câmera)' : 'Tirar Foto do Medidor'}
              </span>
            </button>

            <button
              type="button"
              onClick={() => attach1InputRef.current?.click()}
              disabled={isProcessingPhoto}
              className="min-h-[48px] px-3.5 py-2.5 rounded-xl bg-white border-2 border-slate-300 hover:bg-slate-50 text-[#0F172A] font-bold text-xs flex items-center gap-1.5 transition"
            >
              <ImagePlus className="w-4 h-4 shrink-0" />
              <span>Anexar foto do aparelho</span>
            </button>

            <button
              type="button"
              onClick={() => handleSimulateCameraPhoto(1)}
              disabled={isProcessingPhoto}
              title="Gera imagem simulada colorida do medidor com o valor digitado para teste rápido"
              className="min-h-[48px] px-3 py-2.5 rounded-xl bg-slate-200 hover:bg-slate-300 text-[#0F172A] font-bold text-xs flex items-center gap-1.5 transition"
            >
              <Sparkles className="w-4 h-4 shrink-0" />
              <span>Simular Foto</span>
            </button>
          </div>

          {/* 1st Photo Preview + "Baixar foto" + "Compartilhar" matching PNG reference */}
          {photo1 && photo1PreviewUrl && (
            <div className="flex items-stretch gap-3">
              <div className="flex-1 rounded-2xl bg-white border-2 border-slate-300 overflow-hidden shadow-2xs">
                <img
                  src={photo1PreviewUrl}
                  alt={`Foto 1 carimbada Torre ${formatTowerNumber(
                    tower
                  )} Apto ${apartment}`}
                  referrerPolicy="no-referrer"
                  className="w-full max-h-56 object-contain bg-[#0A2239]"
                />
                <div className="px-3 py-2 bg-slate-100 border-t border-slate-200 flex flex-wrap items-center justify-between gap-2 text-xs font-bold text-[#0F172A]">
                  <span>
                    Torre {formatTowerNumber(tower)} • Apto {apartment} •{' '}
                    {service === 'gas' ? 'Gás' : 'Água'}
                    {evaluation.calculatedAmountBrl !== null && (
                      <span className="text-emerald-800 ml-1">
                        • {formatCurrencyBrl(evaluation.calculatedAmountBrl)}
                      </span>
                    )}
                  </span>
                  <span className="font-mono text-[11px] text-slate-600">
                    {photo1.auditCode}
                  </span>
                </div>
              </div>

              <div className="flex flex-col justify-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() =>
                    triggerPhotoDownload(photo1.stampedBlob, photo1.fileName)
                  }
                  className="min-h-[76px] px-3.5 py-2 rounded-2xl bg-white border-2 border-[#0A2239] hover:bg-slate-50 text-[#0A2239] font-extrabold text-xs flex flex-col items-center justify-center gap-1 shadow-2xs"
                >
                  <Download className="w-5 h-5" />
                  <span className="text-center leading-tight">
                    Baixar
                    <br />
                    foto
                  </span>
                </button>

                {canBrowserShareFiles() && (
                  <button
                    type="button"
                    onClick={() =>
                      sharePhotoFile(
                        photo1.stampedBlob,
                        photo1.fileName,
                        `Leitura Torre ${formatTowerNumber(
                          tower
                        )} Apto ${apartment}`
                      )
                    }
                    className="min-h-[44px] px-3 py-2 rounded-xl bg-white border border-slate-300 text-slate-800 font-bold text-xs flex items-center justify-center gap-1"
                  >
                    <Share2 className="w-4 h-4" />
                    <span>Compartilhar</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {/* 2nd Validation Photo Section (when required by exception/alert or already attached) */}
          {(evaluation.requiresSecondPhoto || photo2) && (
            <div className="rounded-2xl bg-red-50/70 border-2 border-red-400 p-3.5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <h3 className="text-xs font-extrabold text-red-950 uppercase">
                    2ª Foto Obrigatória • Validação de Exceção
                  </h3>
                  <p className="text-[11px] font-semibold text-red-900">
                    Capture um segundo ângulo nítido do mostrador para auditar o
                    alerta/exceção.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => camera2InputRef.current?.click()}
                    disabled={isProcessingPhoto}
                    className="min-h-[42px] px-3 py-2 rounded-xl bg-red-700 hover:bg-red-800 text-white font-bold text-xs flex items-center gap-1.5"
                  >
                    <Camera className="w-4 h-4" />
                    <span>
                      {photo2 ? 'Refazer 2ª Foto' : 'Tirar 2ª Foto (Validação)'}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => attach2InputRef.current?.click()}
                    disabled={isProcessingPhoto}
                    className="min-h-[42px] px-3 py-2 rounded-xl bg-white border border-red-300 text-red-950 font-bold text-xs"
                  >
                    Anexar 2ª Foto
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSimulateCameraPhoto(2)}
                    disabled={isProcessingPhoto}
                    className="min-h-[42px] px-3 py-2 rounded-xl bg-red-200/80 text-red-950 font-bold text-xs"
                  >
                    Simular 2ª Foto
                  </button>
                </div>
              </div>

              {photo2 && photo2PreviewUrl && (
                <div className="flex items-stretch gap-3">
                  <div className="flex-1 rounded-xl bg-white border border-red-300 overflow-hidden">
                    <img
                      src={photo2PreviewUrl}
                      alt="2ª Foto de validação carimbada"
                      referrerPolicy="no-referrer"
                      className="w-full max-h-48 object-contain bg-[#0A2239]"
                    />
                    <div className="px-3 py-1.5 bg-red-100 text-[11px] font-bold text-red-950 flex justify-between">
                      <span>2ª FOTO • VALIDAÇÃO</span>
                      <span className="font-mono">{photo2.auditCode}</span>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      triggerPhotoDownload(photo2.stampedBlob, photo2.fileName)
                    }
                    className="min-h-[64px] px-3 py-2 rounded-xl bg-white border border-red-400 text-red-950 font-bold text-xs flex flex-col items-center justify-center gap-1"
                  >
                    <Download className="w-4 h-4" />
                    <span>Baixar 2ª</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Authorship Metadata if already saved */}
        {existingReading && (
          <div className="text-xs font-semibold text-slate-600 flex flex-wrap items-center gap-2">
            <span>
              Registrado por: <strong>{existingReading.createdByName}</strong> (
              {new Date(existingReading.createdAt).toLocaleString('pt-BR')})
            </span>
            {existingReading.updatedByUid !== existingReading.createdByUid && (
              <>
                <span aria-hidden="true">·</span>
                <span>
                  Última alteração:{' '}
                  <strong>{existingReading.updatedByName}</strong> (
                  {new Date(existingReading.updatedAt).toLocaleString('pt-BR')})
                </span>
              </>
            )}
          </div>
        )}

        {errorMessage && (
          <div className="rounded-xl bg-red-100 border-2 border-red-600 px-4 py-3 text-xs font-extrabold text-red-950">
            {errorMessage}
          </div>
        )}

        {infoMessage && (
          <div className="rounded-xl bg-emerald-100 border border-emerald-600 px-4 py-3 text-xs font-bold text-emerald-950">
            {infoMessage}
          </div>
        )}

        {/* Primary CTA "Salvar e avançar" matching PNG reference */}
        <div className="pt-2 pb-10">
          <button
            type="button"
            onClick={handleSaveAndAdvance}
            disabled={isSaving || isProcessingPhoto}
            className="w-full min-h-[58px] rounded-2xl bg-[#E08E00] hover:bg-[#cc8100] active:scale-[0.99] disabled:opacity-60 text-[#0F172A] font-extrabold text-xl flex items-center justify-center gap-2 shadow-md transition"
          >
            <span>
              {isSaving
                ? 'Gravando no aparelho...'
                : isLastApartment
                ? 'Salvar e ver resumo da torre'
                : 'Salvar e avançar'}
            </span>
          </button>
        </div>
      </main>

      {/* Modal: Confirmation of Unit and Value when attaching photo from device ("Anexar foto do aparelho") */}
      {pendingAttachment && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-5 text-[#0F172A] shadow-xl space-y-4">
            <h3 className="text-lg font-extrabold">
              Confirmar Unidade e Valor da Foto Anexada
            </h3>
            <p className="text-xs text-slate-600 leading-relaxed">
              Para recuperar um JPEG do aparelho com segurança de auditoria,
              confirme que a foto selecionada pertence a esta unidade e confira
              o valor da leitura para o carimbo:
            </p>

            <div className="rounded-xl bg-slate-100 p-3 space-y-1.5 text-xs font-bold">
              <div>
                Unidade:{' '}
                <strong className="text-sm">
                  Torre {formatTowerNumber(tower)} • Apartamento {apartment} (
                  {service === 'gas' ? 'Gás' : 'Água'})
                </strong>
              </div>
              <div>
                Arquivo: <code>{pendingAttachment.file.name}</code>
              </div>
            </div>

            <div className="space-y-1">
              <label className="block text-xs font-extrabold">
                Valor da leitura no mostrador da foto (m³):
              </label>
              <input
                type="text"
                inputMode="decimal"
                value={pendingAttachment.confirmValueInput}
                onChange={(e) =>
                  setPendingAttachment({
                    ...pendingAttachment,
                    confirmValueInput: e.target.value,
                  })
                }
                className="w-full min-h-[46px] px-3 py-2 rounded-xl border-2 border-slate-400 font-mono font-extrabold text-lg"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setPendingAttachment(null)}
                className="min-h-[44px] px-4 py-2 rounded-xl border border-slate-300 font-bold text-xs"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={async () => {
                  const confirmedVal = parseDecimalInput(
                    pendingAttachment.confirmValueInput
                  );
                  if (confirmedVal === null) {
                    setErrorMessage(
                      'Informe um valor numérico válido para carimbar a foto anexada.'
                    );
                    return;
                  }
                  const fileToStamp = pendingAttachment.file;
                  const slotToStamp = pendingAttachment.slot;
                  const formattedVal = formatDecimal4(confirmedVal, true);
                  setValueInput(formattedVal);
                  setPendingAttachment(null);
                  await handleCaptureOrStampPhoto(
                    fileToStamp,
                    slotToStamp,
                    confirmedVal
                  );
                }}
                className="min-h-[44px] px-4 py-2 rounded-xl bg-[#0A2239] text-white font-extrabold text-xs"
              >
                Confirmar e Carimbar Foto
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal: Last Apartment Summary & Tower Backup */}
      {showEndOfTowerModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 p-4">
          <div className="w-full max-w-md rounded-2xl bg-white p-6 text-[#0F172A] shadow-2xl space-y-4">
            <div className="flex items-center gap-2.5 text-emerald-800">
              <CheckCircle2 className="w-7 h-7 shrink-0" />
              <h3 className="text-xl font-extrabold">
                Último Apartamento Concluído • Torre {formatTowerNumber(tower)}
              </h3>
            </div>

            <p className="text-xs text-slate-700 leading-relaxed">
              A leitura do apartamento <strong>{apartment}</strong> foi gravada
              com segurança no aparelho. Confira o resumo da Torre{' '}
              {formatTowerNumber(tower)} ({service === 'gas' ? 'Gás' : 'Água'}):
            </p>

            <div className="rounded-xl bg-slate-100 border border-slate-300 p-4 space-y-2 text-sm font-bold">
              <div className="flex justify-between">
                <span>Apartamentos lidos na torre:</span>
                <span className="font-mono">
                  {towerSummaryStats.readCount} / {orderedApartments.length}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Leituras com alerta:</span>
                <span className="font-mono text-red-700">
                  {towerSummaryStats.alertCount}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Consumo total válido da torre:</span>
                <span className="font-mono">
                  {formatDecimal4(towerSummaryStats.totalConsumption, true)} m³
                </span>
              </div>
              <div className="flex justify-between">
                <span>Valor total calculado da torre:</span>
                <span className="font-mono text-emerald-900">
                  {towerSummaryStats.totalAmountBrl !== null
                    ? formatCurrencyBrl(towerSummaryStats.totalAmountBrl)
                    : 'Sem tarifa configurada'}
                </span>
              </div>
            </div>

            <div className="space-y-2.5 pt-2">
              <button
                type="button"
                onClick={handleTowerBackupFromModal}
                disabled={isBackingUpTower}
                className="w-full min-h-[50px] rounded-xl bg-[#E08E00] hover:bg-[#cc8100] text-[#0F172A] font-extrabold text-sm flex items-center justify-center gap-2 shadow-xs"
              >
                <Download className="w-5 h-5" />
                <span>
                  {isBackingUpTower
                    ? 'Gerando ZIP da Torre...'
                    : `Baixar Backup da Torre ${formatTowerNumber(tower)} (ZIP)`}
                </span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setShowEndOfTowerModal(false);
                  onBackToApartments();
                }}
                className="w-full min-h-[46px] rounded-xl bg-[#0A2239] text-white font-bold text-sm"
              >
                Voltar para Lista de Apartamentos
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
