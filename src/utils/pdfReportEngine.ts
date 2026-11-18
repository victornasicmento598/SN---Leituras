import { jsPDF } from 'jspdf';
import JSZip from 'jszip';
import {
  getOrInitCycleSettings,
  getPhotosForReading,
  getReadingsForCycleService,
  getReferencesForCycleService,
} from '../db/indexedDb';
import {
  CONDOMINIUM_NAME,
  OperatingMode,
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
  evaluateReading,
  formatAlertLabel,
  formatCurrencyBrl,
  formatDecimal4,
  formatTariffBrl,
  getAuditedReadingFinancials,
} from './consumptionEngine';
import { buildExportCsv } from './csvEngine';

export interface PdfGenerationProgress {
  phase: 'preparing' | 'processing_reading' | 'encoding_pdf';
  currentReadingIndex: number;
  totalReadings: number;
  embeddedPhotosCount: number;
  totalExpectedPhotos: number;
  label: string;
}

/**
 * Converts a stamped JPEG Blob from IndexedDB into a full-color JPEG data URL
 * bounded to 720px max width (preserving 100% of original dial and watermark colors
 * while keeping memory usage low on mobile devices).
 * Immediately releases the temporary ObjectURL and zeroes the canvas buffer.
 * Throws an explicit error if the image fails to decode so no photo is ever omitted silently.
 */
async function blobToColorJpegDataUrl(
  blob: Blob,
  contextLabel: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!blob || blob.size === 0) {
      reject(
        new Error(
          `Foto vazia ou ausente no IndexedDB para ${contextLabel}. Nenhuma foto é omitida silenciosamente.`
        )
      );
      return;
    }

    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      try {
        const srcW = img.naturalWidth || img.width || 720;
        const srcH = img.naturalHeight || img.height || 540;
        const targetW = Math.min(720, srcW);
        const ratio = srcH / srcW;
        const targetH = Math.max(240, Math.round(targetW * ratio));

        const canvas = document.createElement('canvas');
        canvas.width = targetW;
        canvas.height = targetH;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          canvas.width = 0;
          canvas.height = 0;
          reject(
            new Error(
              `Limite de memória gráfica (Canvas 2D) atingido ao processar ${contextLabel}.`
            )
          );
          return;
        }

        // Draw in 100% full color (no grayscale filter)
        ctx.drawImage(img, 0, 0, targetW, targetH);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.82);

        // Release temporary canvas backing store immediately
        canvas.width = 0;
        canvas.height = 0;

        if (!dataUrl || dataUrl.length < 64) {
          reject(
            new Error(
              `Falha ao codificar JPEG colorido para ${contextLabel} (possível limite de memória do celular).`
            )
          );
          return;
        }

        resolve(dataUrl);
      } catch (err) {
        reject(
          new Error(
            `Erro de memória ao processar imagem colorida de ${contextLabel}: ${
              err instanceof Error ? err.message : String(err)
            }`
          )
        );
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(
        new Error(
          `Não foi possível decodificar o JPEG do IndexedDB para ${contextLabel}.`
        )
      );
    };
    img.src = url;
  });
}

function yieldToMainThread(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Generates an A4 FULL-COLOR PDF report for a single tower and service:
 * - Complete 20-unit table with previous reading, current reading, consumption (m³),
 *   applied tariff (R$/m³), calculated amount (R$) or unavailability reason, status/alerts, and author
 * - Tower totals in m³ and R$ (excluding replaced meters and negative consumption)
 * - Full-color photos of ALL registered readings in the tower (both normal and alert readings,
 *   including both the 1st photo and the 2nd validation photo when present)
 * - Reads exclusively from IndexedDB and never omits any linked photo silently
 */
export async function generateTowerA4ColorPdfBlob(params: {
  mode: OperatingMode;
  cycleId: string;
  service: ServiceType;
  tower: number;
  referencesMap: Map<string, ReferenceRecord>;
  readingsMap: Map<string, ReadingRecord>;
  onProgress?: (progress: PdfGenerationProgress) => void;
}): Promise<{ pdfBlob: Blob; fileName: string; embeddedPhotosCount: number }> {
  const {
    mode,
    cycleId,
    service,
    tower,
    referencesMap,
    readingsMap,
    onProgress,
  } = params;
  const settings = await getOrInitCycleSettings(mode, cycleId);
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
    compress: true,
  });

  const isWater = service === 'water';
  const serviceName = isWater ? 'ÁGUA' : 'GÁS';
  const alertLimit = isWater ? settings.waterAlertLimit : settings.gasAlertLimit;
  const ceilingLimit = isWater
    ? settings.waterCeilingLimit
    : settings.gasCeilingLimit;
  const cycleTariff = isWater
    ? settings.waterTariffPerM3
    : settings.gasTariffPerM3;

  // Color Header Box
  if (isWater) {
    doc.setFillColor(10, 34, 57); // #0A2239
  } else {
    doc.setFillColor(120, 53, 15); // Deep Amber/Brown header for Gas
  }
  doc.rect(10, 10, 190, 25, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13.5);
  doc.setTextColor(255, 255, 255);
  doc.text(`SN - LEITURAS • ${CONDOMINIUM_NAME.toUpperCase()}`, 14, 17);

  doc.setFontSize(10.5);
  doc.setTextColor(253, 230, 138);
  doc.text(
    `RELATÓRIO A4 COLORIDO • TORRE ${formatTowerNumber(
      tower
    )} • SERVIÇO: ${serviceName} • CICLO: ${cycleId}`,
    14,
    23.5
  );

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(226, 232, 240);
  doc.text(
    `Tarifa do Ciclo: ${formatTariffBrl(
      cycleTariff,
      true
    )}   |   Limite Alerta: ${formatDecimal4(
      alertLimit
    )} m³ (Teto ${formatDecimal4(
      ceilingLimit
    )} m³)   |   Emitido: ${new Date().toLocaleString('pt-BR')}`,
    14,
    30.5
  );

  let readUnits = 0;
  let pendingUnits = 0;
  let alertUnits = 0;
  let meterReplacedUnits = 0;
  let totalValidConsumptionScaled = 0;
  let totalBrlCents = 0;
  let totalExpectedPhotos = 0;
  const registeredReadings: ReadingRecord[] = [];

  interface RowRenderData {
    apt: string;
    prevStr: string;
    currStr: string;
    consStr: string;
    tariffStr: string;
    brlStr: string;
    statusStr: string;
    obsAndAlertStr: string;
    authorStr: string;
    isAlert: boolean;
    isRead: boolean;
  }

  const rows: RowRenderData[] = [];

  for (const apt of SEQUENTIAL_APARTMENTS) {
    const unitId = buildUnitKey(cycleId, service, tower, apt);
    const ref = referencesMap.get(unitId);
    const reading = readingsMap.get(unitId);

    const prevVal =
      reading !== undefined ? reading.previousValue : ref?.previousValue ?? null;

    if (!reading) {
      pendingUnits++;
      rows.push({
        apt,
        prevStr: prevVal !== null ? formatDecimal4(prevVal, true) : 'Sem ant.',
        currStr: '—',
        consStr: '—',
        tariffStr: '—',
        brlStr: '—',
        statusStr: 'PENDENTE',
        obsAndAlertStr: '',
        authorStr: '—',
        isAlert: false,
        isRead: false,
      });
      continue;
    }

    readUnits++;
    registeredReadings.push(reading);
    if (reading.photo1Id) totalExpectedPhotos++;
    if (reading.photo2Id) totalExpectedPhotos++;

    const evalRes = evaluateReading({
      service,
      previousValue: reading.previousValue,
      currentValue: reading.currentValue,
      limits: settings,
      exceptionType: reading.exceptionType,
      overrideTariffPerM3: reading.appliedTariff,
    });
    const fin = getAuditedReadingFinancials(reading, cycleTariff);

    if (evalRes.status === 'alert') {
      alertUnits++;
    }
    if (reading.exceptionType === 'meter_replaced') {
      meterReplacedUnits++;
    }
    if (
      evalRes.consumption !== null &&
      evalRes.consumption >= 0 &&
      !evalRes.excludeFromTotals
    ) {
      totalValidConsumptionScaled += Math.round(evalRes.consumption * 10000);
    }
    if (fin.calculatedAmountBrl !== null && fin.calculatedAmountBrl >= 0) {
      totalBrlCents += Math.round(fin.calculatedAmountBrl * 100);
    }

    const alertsText = evalRes.alerts.map(formatAlertLabel).join(', ');
    const combinedObs = [alertsText, reading.observation]
      .filter(Boolean)
      .join(' — ');

    rows.push({
      apt,
      prevStr:
        reading.previousValue !== null
          ? formatDecimal4(reading.previousValue, true)
          : 'Sem ant.',
      currStr: formatDecimal4(reading.currentValue, true),
      consStr:
        evalRes.consumption !== null
          ? formatDecimal4(evalRes.consumption, true)
          : 'Excluído',
      tariffStr:
        fin.appliedTariff !== null && fin.appliedTariff > 0
          ? formatTariffBrl(fin.appliedTariff, false, true)
          : 'Sem tarifa',
      brlStr:
        fin.calculatedAmountBrl !== null
          ? formatCurrencyBrl(fin.calculatedAmountBrl, true, true)
          : fin.amountUnavailableReason || 'Indisp.',
      statusStr: evalRes.status === 'alert' ? 'ALERTA' : 'LIDA',
      obsAndAlertStr: combinedObs.slice(0, 36),
      authorStr: (reading.updatedByName || reading.createdByName || 'Local').slice(
        0,
        12
      ),
      isAlert: evalRes.status === 'alert',
      isRead: true,
    });
  }

  const totalConsumptionM3 = totalValidConsumptionScaled / 10000;
  const totalAmountBrl = totalBrlCents / 100;

  // Summary strip
  doc.setFillColor(241, 245, 249);
  doc.setDrawColor(148, 163, 184);
  doc.setLineWidth(0.3);
  doc.rect(10, 37, 190, 11, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8.2);
  doc.setTextColor(15, 23, 42);
  doc.text(
    `Lidas: ${readUnits}/20  |  Pendentes: ${pendingUnits}  |  Alertas: ${alertUnits}  |  Trocas: ${meterReplacedUnits}  |  Consumo Válido: ${formatDecimal4(
      totalConsumptionM3,
      true
    )} m³  |  Total Faturável: ${formatCurrencyBrl(totalAmountBrl, true)}`,
    13,
    43.8
  );

  // Table Header
  let y = 53;
  const colX = {
    apt: 10,
    prev: 22,
    curr: 44,
    cons: 66,
    tariff: 88,
    brl: 108,
    status: 136,
    obs: 152,
    author: 182,
  };

  doc.setFillColor(226, 232, 240);
  doc.setDrawColor(100, 116, 139);
  doc.rect(10, y - 4.2, 190, 6.2, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.2);
  doc.setTextColor(15, 23, 42);
  doc.text('APTO', colX.apt + 1.2, y);
  doc.text('ANTERIOR', colX.prev + 1.2, y);
  doc.text('ATUAL (m³)', colX.curr + 1.2, y);
  doc.text('CONSUMO', colX.cons + 1.2, y);
  doc.text('TARIFA', colX.tariff + 1.2, y);
  doc.text('VALOR (R$)', colX.brl + 1.2, y);
  doc.text('STATUS', colX.status + 1.2, y);
  doc.text('ALERTAS / OBS', colX.obs + 1.2, y);
  doc.text('AUTOR', colX.author + 1.2, y);

  y += 2;

  // Table Rows (20 units)
  doc.setFontSize(7.1);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rowY = y + i * 6;
    if (r.isAlert) {
      doc.setFillColor(254, 242, 242);
      doc.rect(10, rowY, 190, 6, 'F');
    } else if (r.isRead) {
      doc.setFillColor(240, 253, 244);
      doc.rect(10, rowY, 190, 6, 'F');
    }
    doc.setDrawColor(203, 213, 225);
    doc.setLineWidth(0.15);
    doc.rect(10, rowY, 190, 6);

    doc.setTextColor(15, 23, 42);
    doc.setFont('helvetica', 'bold');
    doc.text(r.apt, colX.apt + 1.5, rowY + 4.1);

    doc.setFont('courier', 'normal');
    doc.text(r.prevStr, colX.prev + 1.2, rowY + 4.1);
    doc.text(r.currStr, colX.curr + 1.2, rowY + 4.1);
    doc.setFont('courier', 'bold');
    doc.text(r.consStr, colX.cons + 1.2, rowY + 4.1);
    doc.setFont('courier', 'normal');
    doc.text(r.tariffStr, colX.tariff + 1.2, rowY + 4.1);

    doc.setFont('helvetica', 'bold');
    doc.text(r.brlStr.slice(0, 17), colX.brl + 1.2, rowY + 4.1);

    if (r.isAlert) {
      doc.setTextColor(185, 28, 28);
    } else if (r.isRead) {
      doc.setTextColor(22, 101, 52);
    } else {
      doc.setTextColor(146, 64, 14);
    }
    doc.text(r.statusStr, colX.status + 1.2, rowY + 4.1);

    doc.setTextColor(51, 65, 85);
    doc.setFont('helvetica', 'normal');
    doc.text(r.obsAndAlertStr || '—', colX.obs + 1.2, rowY + 4.1);
    doc.text(r.authorStr, colX.author + 1.2, rowY + 4.1);
  }

  y += rows.length * 6 + 7;

  // Full-color Photos section for ALL registered readings in the tower (normal and alert, 1st and 2nd photos)
  let embeddedPhotosCount = 0;

  if (registeredReadings.length > 0) {
    if (y > 220) {
      doc.addPage();
      y = 16;
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(10, 34, 57);
    doc.text(
      `EVIDÊNCIAS FOTOGRÁFICAS COLORIDAS — TODAS AS LEITURAS DA TORRE (${registeredReadings.length} UNID. / ${totalExpectedPhotos} FOTOS)`,
      10,
      y
    );
    y += 4.5;

    for (let idx = 0; idx < registeredReadings.length; idx++) {
      const reading = registeredReadings[idx];
      const unitLabel = `Torre ${formatTowerNumber(tower)} • Apto ${
        reading.apartment
      } (${serviceName})`;

      onProgress?.({
        phase: 'processing_reading',
        currentReadingIndex: idx + 1,
        totalReadings: registeredReadings.length,
        embeddedPhotosCount,
        totalExpectedPhotos,
        label: `Processando ${unitLabel} (${idx + 1}/${registeredReadings.length})...`,
      });

      await yieldToMainThread();

      const photosMap = await getPhotosForReading(mode, reading.id);
      const p1 = photosMap.get('1');
      const p2 = photosMap.get('2');

      if (reading.photo1Id && !p1) {
        throw new Error(
          `A 1ª foto vinculada de ${unitLabel} não foi encontrada no IndexedDB. Geração abortada para evitar omissão silenciosa.`
        );
      }
      if (reading.photo2Id && !p2) {
        throw new Error(
          `A 2ª foto de validação vinculada de ${unitLabel} não foi encontrada no IndexedDB. Geração abortada para evitar omissão silenciosa.`
        );
      }

      if (y > 224) {
        doc.addPage();
        y = 16;
      }

      const fin = getAuditedReadingFinancials(reading, cycleTariff);
      const isAlert = reading.status === 'alert';

      doc.setDrawColor(isAlert ? 220 : 148, isAlert ? 38 : 163, isAlert ? 38 : 184);
      doc.setLineWidth(isAlert ? 0.45 : 0.25);
      doc.rect(10, y, 190, 58);

      // Card Header Strip
      if (isAlert) {
        doc.setFillColor(254, 226, 226);
      } else {
        doc.setFillColor(241, 245, 249);
      }
      doc.rect(10.2, y + 0.2, 189.6, 13, 'F');

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(15, 23, 42);
      const brlHeader =
        fin.calculatedAmountBrl !== null
          ? formatCurrencyBrl(fin.calculatedAmountBrl, true)
          : `Indisponível (${fin.amountUnavailableReason || 'Sem tarifa'})`;

      doc.text(
        `Torre ${formatTowerNumber(tower)} • Apto ${
          reading.apartment
        } • ${serviceName}   |   Ant: ${
          reading.previousValue !== null
            ? `${formatDecimal4(reading.previousValue, true)} m³`
            : 'Sem ant.'
        }   |   Atual: ${formatDecimal4(
          reading.currentValue,
          true
        )} m³   |   Consumo: ${
          reading.consumption !== null
            ? `${formatDecimal4(reading.consumption, true)} m³`
            : 'Excluído (Troca)'
        }`,
        13,
        y + 5.2
      );

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.6);
      doc.text(
        `Tarifa Aplicada: ${formatTariffBrl(
          fin.appliedTariff,
          true
        )}   |   Valor R$: ${brlHeader}   |   Status: ${
          isAlert
            ? `ALERTA (${reading.alerts.map(formatAlertLabel).join(', ')})`
            : 'NORMAL'
        }   |   Obs: ${(reading.observation || '—').slice(0, 42)}`,
        13,
        y + 10.5
      );

      if (p1) {
        const img1DataUrl = await blobToColorJpegDataUrl(
          p1.stampedBlob,
          `${unitLabel} - 1ª Foto`
        );
        doc.addImage(img1DataUrl, 'JPEG', 13, y + 14.5, 84, 41.5);
        embeddedPhotosCount++;
      } else {
        doc.setTextColor(185, 28, 28);
        doc.text('[Sem 1ª foto registrada]', 16, y + 32);
      }

      if (p2) {
        const img2DataUrl = await blobToColorJpegDataUrl(
          p2.stampedBlob,
          `${unitLabel} - 2ª Foto de Validação`
        );
        doc.addImage(img2DataUrl, 'JPEG', 103, y + 14.5, 84, 41.5);
        embeddedPhotosCount++;
      } else {
        doc.setFont('helvetica', 'italic');
        doc.setFontSize(7.2);
        doc.setTextColor(100, 116, 139);
        doc.text(
          `1ª Foto Auditada: ${reading.auditCode1 || '—'}`,
          105,
          y + 26
        );
        doc.text(
          `Coletado por: ${reading.createdByName} (${new Date(
            reading.createdAt
          ).toLocaleString('pt-BR')})`,
          105,
          y + 32
        );
        doc.text('2ª Foto de validação: não exigida (leitura normal).', 105, y + 38);
      }

      y += 61;
    }
  } else {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8.5);
    doc.setTextColor(100, 116, 139);
    doc.text(
      'Nenhuma leitura registrada nesta torre até o momento.',
      10,
      y
    );
  }

  onProgress?.({
    phase: 'encoding_pdf',
    currentReadingIndex: registeredReadings.length,
    totalReadings: registeredReadings.length,
    embeddedPhotosCount,
    totalExpectedPhotos,
    label: 'Finalizando arquivo PDF colorido...',
  });

  await yieldToMainThread();

  const pdfArrayBuffer = doc.output('arraybuffer');
  const pdfBlob = new Blob([pdfArrayBuffer], { type: 'application/pdf' });
  const svcCode = service === 'water' ? 'AGUA' : 'GAS';
  const fileName = `Relatorio_A4_Colorido_${cycleId}_${svcCode}_${formatTowerCode(
    tower
  )}.pdf`;

  return { pdfBlob, fileName, embeddedPhotosCount };
}

/**
 * Generates a SINGLE Consolidated A4 Full-Color PDF for the cycle:
 * - Includes all registered readings across the selected services (Água and/or Gás) and selected towers (01..28)
 * - Organized hierarchically by Service -> Tower -> Apartment (Confirmed Decision 3: lists only units with a registered reading)
 * - Displays Executive Totals per Service (readings count, alerts, replaced meters, total valid consumption in m³, tariff in R$/m³, and total billed amount in R$)
 * - Includes ALL linked photos in full color (1st photo and 2nd validation photo when present, for both normal and alert readings)
 * - Preserves full legibility of the meter dial and the 4-line watermark stamp
 * - Reads exclusively from IndexedDB (zero Firestore reads) with live progress and zero silent photo omissions
 */
export async function generateConsolidatedCycleA4ColorPdfBlob(params: {
  mode: OperatingMode;
  cycleId: string;
  services: ServiceType[];
  towers?: number[];
  onProgress?: (progress: PdfGenerationProgress) => void;
}): Promise<{
  pdfBlob: Blob;
  fileName: string;
  totalReadingsIncluded: number;
  embeddedPhotosCount: number;
}> {
  const { mode, cycleId, services, onProgress } = params;
  const towersFilter =
    params.towers && params.towers.length > 0
      ? [...params.towers].sort((a, b) => a - b)
      : Array.from({ length: TOTAL_TOWERS }, (_, i) => i + 1);

  const settings = await getOrInitCycleSettings(mode, cycleId);

  onProgress?.({
    phase: 'preparing',
    currentReadingIndex: 0,
    totalReadings: 0,
    embeddedPhotosCount: 0,
    totalExpectedPhotos: 0,
    label: 'Lendo leituras e referências do IndexedDB...',
  });

  interface ServiceGroupData {
    service: ServiceType;
    serviceLabel: string;
    tariffPerM3: number | null;
    readingsByTower: Map<number, ReadingRecord[]>;
    totalReadings: number;
    normalReadings: number;
    alertReadings: number;
    meterReplacedCount: number;
    totalValidConsumptionM3: number;
    totalAmountBrl: number;
    expectedPhotos: number;
  }

  const serviceGroups: ServiceGroupData[] = [];
  let grandTotalReadings = 0;
  let grandTotalExpectedPhotos = 0;

  for (const service of services) {
    const readingsMap = await getReadingsForCycleService(mode, cycleId, service);
    const tariffPerM3 =
      service === 'water'
        ? settings.waterTariffPerM3
        : settings.gasTariffPerM3;

    const readingsByTower = new Map<number, ReadingRecord[]>();
    let totalReadings = 0;
    let normalReadings = 0;
    let alertReadings = 0;
    let meterReplacedCount = 0;
    let totalValidConsScaled = 0;
    let totalBrlCents = 0;
    let expectedPhotos = 0;

    for (const tower of towersFilter) {
      const towerList: ReadingRecord[] = [];
      for (const apt of SEQUENTIAL_APARTMENTS) {
        const unitId = buildUnitKey(cycleId, service, tower, apt);
        const r = readingsMap.get(unitId);
        if (!r) continue;
        towerList.push(r);
        totalReadings++;
        if (r.photo1Id) expectedPhotos++;
        if (r.photo2Id) expectedPhotos++;

        const evalRes = evaluateReading({
          service,
          previousValue: r.previousValue,
          currentValue: r.currentValue,
          limits: settings,
          exceptionType: r.exceptionType,
          overrideTariffPerM3: r.appliedTariff,
        });
        const fin = getAuditedReadingFinancials(r, tariffPerM3);

        if (evalRes.status === 'alert') {
          alertReadings++;
        } else {
          normalReadings++;
        }
        if (r.exceptionType === 'meter_replaced') {
          meterReplacedCount++;
        }
        if (
          evalRes.consumption !== null &&
          evalRes.consumption >= 0 &&
          !evalRes.excludeFromTotals
        ) {
          totalValidConsScaled += Math.round(evalRes.consumption * 10000);
        }
        if (fin.calculatedAmountBrl !== null && fin.calculatedAmountBrl >= 0) {
          totalBrlCents += Math.round(fin.calculatedAmountBrl * 100);
        }
      }

      if (towerList.length > 0) {
        readingsByTower.set(tower, towerList);
      }
    }

    grandTotalReadings += totalReadings;
    grandTotalExpectedPhotos += expectedPhotos;

    serviceGroups.push({
      service,
      serviceLabel: service === 'water' ? 'ÁGUA' : 'GÁS',
      tariffPerM3,
      readingsByTower,
      totalReadings,
      normalReadings,
      alertReadings,
      meterReplacedCount,
      totalValidConsumptionM3: totalValidConsScaled / 10000,
      totalAmountBrl: totalBrlCents / 100,
      expectedPhotos,
    });
  }

  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
    compress: true,
  });

  // Top Consolidated Title Header
  doc.setFillColor(10, 34, 57);
  doc.rect(10, 10, 190, 26, 'F');

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(255, 255, 255);
  doc.text(
    `SN - LEITURAS • ${CONDOMINIUM_NAME.toUpperCase()}`,
    14,
    17.5
  );

  doc.setFontSize(10.5);
  doc.setTextColor(253, 230, 138);
  doc.text(
    `RELATÓRIO A4 COLORIDO CONSOLIDADO DO CICLO ${cycleId} (${serviceGroups
      .map((g) => g.serviceLabel)
      .join(' + ')})`,
    14,
    24
  );

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(226, 232, 240);
  doc.text(
    `Unidades com Leitura Incluídas: ${grandTotalReadings}   |   Fotos Coloridas Vinculadas: ${grandTotalExpectedPhotos}   |   Fonte: IndexedDB Local   |   Emitido: ${new Date().toLocaleString(
      'pt-BR'
    )}`,
    14,
    31
  );

  let y = 41;

  // Executive Totals per Service Box
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9.5);
  doc.setTextColor(10, 34, 57);
  doc.text('RESUMO EXECUTIVO E TOTAIS POR SERVIÇO NO CICLO', 10, y);
  y += 3;

  for (const grp of serviceGroups) {
    const isWater = grp.service === 'water';
    doc.setFillColor(isWater ? 224 : 254, isWater ? 242 : 243, isWater ? 254 : 199);
    doc.setDrawColor(isWater ? 2 : 217, isWater ? 132 : 119, isWater ? 199 : 6);
    doc.setLineWidth(0.35);
    doc.rect(10, y, 190, 15, 'FD');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(15, 23, 42);
    doc.text(
      `SERVIÇO: ${grp.serviceLabel}   |   Tarifa do Ciclo: ${formatTariffBrl(
        grp.tariffPerM3,
        true
      )}   |   Torres com Leitura: ${grp.readingsByTower.size}`,
      13,
      y + 5.5
    );

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.2);
    doc.text(
      `Leituras Registradas: ${grp.totalReadings} (Normais: ${
        grp.normalReadings
      } · Com Alerta: ${grp.alertReadings} · Trocas: ${
        grp.meterReplacedCount
      })   |   Consumo Total Válido: ${formatDecimal4(
        grp.totalValidConsumptionM3,
        true
      )} m³   |   Total Faturável: ${formatCurrencyBrl(grp.totalAmountBrl, true)}`,
      13,
      y + 11.5
    );

    y += 18;
  }

  let processedReadingsCount = 0;
  let embeddedPhotosCount = 0;

  if (grandTotalReadings === 0) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(9.5);
    doc.setTextColor(100, 116, 139);
    doc.text(
      'Nenhuma leitura registrada no ciclo para os serviços e torres selecionados.',
      10,
      y + 6
    );
  }

  // Hierarchical Iteration: Service -> Tower -> Apartment
  for (const grp of serviceGroups) {
    if (grp.totalReadings === 0) continue;

    if (y > 225) {
      doc.addPage();
      y = 15;
    }

    // Service Divider Banner
    const isWater = grp.service === 'water';
    doc.setFillColor(isWater ? 13 : 217, isWater ? 138 : 119, isWater ? 158 : 6);
    doc.rect(10, y, 190, 9, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(255, 255, 255);
    doc.text(
      `SEÇÃO DE SERVIÇO: ${grp.serviceLabel} — ${
        grp.totalReadings
      } LEITURA(S) • CONSUMO: ${formatDecimal4(
        grp.totalValidConsumptionM3,
        true
      )} m³ • TOTAL: ${formatCurrencyBrl(grp.totalAmountBrl, true)}`,
      13,
      y + 6
    );
    y += 12;

    const sortedTowers = Array.from(grp.readingsByTower.keys()).sort(
      (a, b) => a - b
    );

    for (const tower of sortedTowers) {
      const towerReadings = grp.readingsByTower.get(tower) || [];
      if (towerReadings.length === 0) continue;

      // Compute Tower Subtotals
      let towerConsScaled = 0;
      let towerBrlCents = 0;
      let towerAlertCount = 0;
      for (const r of towerReadings) {
        const evalRes = evaluateReading({
          service: grp.service,
          previousValue: r.previousValue,
          currentValue: r.currentValue,
          limits: settings,
          exceptionType: r.exceptionType,
          overrideTariffPerM3: r.appliedTariff,
        });
        const fin = getAuditedReadingFinancials(r, grp.tariffPerM3);
        if (evalRes.status === 'alert') towerAlertCount++;
        if (
          evalRes.consumption !== null &&
          evalRes.consumption >= 0 &&
          !evalRes.excludeFromTotals
        ) {
          towerConsScaled += Math.round(evalRes.consumption * 10000);
        }
        if (fin.calculatedAmountBrl !== null && fin.calculatedAmountBrl >= 0) {
          towerBrlCents += Math.round(fin.calculatedAmountBrl * 100);
        }
      }

      if (y > 220) {
        doc.addPage();
        y = 15;
      }

      // Tower Subtotal Strip
      doc.setFillColor(226, 232, 240);
      doc.setDrawColor(100, 116, 139);
      doc.setLineWidth(0.25);
      doc.rect(10, y, 190, 7.5, 'FD');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.3);
      doc.setTextColor(15, 23, 42);
      doc.text(
        `${grp.serviceLabel} • TORRE ${formatTowerNumber(tower)} — ${
          towerReadings.length
        } unidade(s) lida(s) (${towerAlertCount} c/ alerta)   |   Subtotal Consumo: ${formatDecimal4(
          towerConsScaled / 10000,
          true
        )} m³   |   Subtotal R$: ${formatCurrencyBrl(
          towerBrlCents / 100,
          true
        )}`,
        13,
        y + 5.1
      );
      y += 9.5;

      for (const reading of towerReadings) {
        processedReadingsCount++;
        const unitLabel = `${grp.serviceLabel} • Torre ${formatTowerNumber(
          tower
        )} • Apto ${reading.apartment}`;

        onProgress?.({
          phase: 'processing_reading',
          currentReadingIndex: processedReadingsCount,
          totalReadings: grandTotalReadings,
          embeddedPhotosCount,
          totalExpectedPhotos: grandTotalExpectedPhotos,
          label: `Processando ${unitLabel} (${processedReadingsCount}/${grandTotalReadings})...`,
        });

        await yieldToMainThread();

        const photosMap = await getPhotosForReading(mode, reading.id);
        const p1 = photosMap.get('1');
        const p2 = photosMap.get('2');

        if (reading.photo1Id && !p1) {
          throw new Error(
            `A 1ª foto vinculada de ${unitLabel} não foi encontrada no IndexedDB. Geração abortada para evitar omissão silenciosa.`
          );
        }
        if (reading.photo2Id && !p2) {
          throw new Error(
            `A 2ª foto de validação vinculada de ${unitLabel} não foi encontrada no IndexedDB. Geração abortada para evitar omissão silenciosa.`
          );
        }

        if (y > 224) {
          doc.addPage();
          y = 15;
        }

        const evalRes = evaluateReading({
          service: grp.service,
          previousValue: reading.previousValue,
          currentValue: reading.currentValue,
          limits: settings,
          exceptionType: reading.exceptionType,
          overrideTariffPerM3: reading.appliedTariff,
        });
        const fin = getAuditedReadingFinancials(reading, grp.tariffPerM3);
        const isAlert = evalRes.status === 'alert';

        doc.setDrawColor(
          isAlert ? 220 : 148,
          isAlert ? 38 : 163,
          isAlert ? 38 : 184
        );
        doc.setLineWidth(isAlert ? 0.45 : 0.25);
        doc.rect(10, y, 190, 58);

        if (isAlert) {
          doc.setFillColor(254, 226, 226);
        } else {
          doc.setFillColor(248, 250, 252);
        }
        doc.rect(10.2, y + 0.2, 189.6, 13, 'F');

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(8.4);
        doc.setTextColor(15, 23, 42);

        const brlText =
          fin.calculatedAmountBrl !== null
            ? formatCurrencyBrl(fin.calculatedAmountBrl, true)
            : `Indisponível (${fin.amountUnavailableReason || 'Sem tarifa'})`;

        doc.text(
          `${grp.serviceLabel} • Torre ${formatTowerNumber(tower)} • Apto ${
            reading.apartment
          }   |   Ant: ${
            reading.previousValue !== null
              ? `${formatDecimal4(reading.previousValue, true)} m³`
              : 'Sem ant.'
          }   |   Atual: ${formatDecimal4(
            reading.currentValue,
            true
          )} m³   |   Consumo: ${
            evalRes.consumption !== null
              ? `${formatDecimal4(evalRes.consumption, true)} m³`
              : 'Excluído (Troca)'
          }`,
          13,
          y + 5.2
        );

        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        doc.text(
          `Tarifa: ${formatTariffBrl(
            fin.appliedTariff,
            true
          )}   |   Valor R$: ${brlText}   |   Status: ${
            isAlert
              ? `ALERTA (${evalRes.alerts.map(formatAlertLabel).join(', ')})`
              : 'NORMAL'
          }   |   Obs: ${(reading.observation || '—').slice(0, 42)}`,
          13,
          y + 10.5
        );

        if (p1) {
          const img1DataUrl = await blobToColorJpegDataUrl(
            p1.stampedBlob,
            `${unitLabel} - 1ª Foto`
          );
          doc.addImage(img1DataUrl, 'JPEG', 13, y + 14.5, 84, 41.5);
          embeddedPhotosCount++;
        } else {
          doc.setTextColor(185, 28, 28);
          doc.text('[Sem 1ª foto registrada]', 16, y + 32);
        }

        if (p2) {
          const img2DataUrl = await blobToColorJpegDataUrl(
            p2.stampedBlob,
            `${unitLabel} - 2ª Foto de Validação`
          );
          doc.addImage(img2DataUrl, 'JPEG', 103, y + 14.5, 84, 41.5);
          embeddedPhotosCount++;
        } else {
          doc.setFont('helvetica', 'italic');
          doc.setFontSize(7.2);
          doc.setTextColor(100, 116, 139);
          doc.text(
            `1ª Foto Auditada: ${reading.auditCode1 || '—'}`,
            105,
            y + 26
          );
          doc.text(
            `Coletado por: ${reading.createdByName} (${new Date(
              reading.createdAt
            ).toLocaleString('pt-BR')})`,
            105,
            y + 32
          );
          doc.text(
            '2ª Foto de validação: não exigida (leitura normal).',
            105,
            y + 38
          );
        }

        y += 60.5;
      }
    }
  }

  onProgress?.({
    phase: 'encoding_pdf',
    currentReadingIndex: grandTotalReadings,
    totalReadings: grandTotalReadings,
    embeddedPhotosCount,
    totalExpectedPhotos: grandTotalExpectedPhotos,
    label: 'Codificando PDF A4 Colorido Consolidado...',
  });

  await yieldToMainThread();

  const pdfArrayBuffer = doc.output('arraybuffer');
  const pdfBlob = new Blob([pdfArrayBuffer], { type: 'application/pdf' });
  const svcSuffix =
    services.length === 2
      ? 'AGUA_E_GAS'
      : services[0] === 'water'
      ? 'AGUA'
      : 'GAS';
  const fileName = `Relatorio_A4_Colorido_Consolidado_${cycleId}_${svcSuffix}.pdf`;

  return {
    pdfBlob,
    fileName,
    totalReadingsIncluded: grandTotalReadings,
    embeddedPhotosCount,
  };
}

/**
 * Legacy alias preserved for compatibility while routing to the full-color generator.
 */
export const generateTowerA4BwPdfBlob = generateTowerA4ColorPdfBlob;

/**
 * Generates a multi-tower export package (single PDF/CSV or a ZIP bundle when multiple files are selected).
 * Supports both per-tower PDF reports and the single Consolidated Cycle Color PDF.
 */
export async function exportReportsBundle(params: {
  mode: OperatingMode;
  cycleId: string;
  services: ServiceType[];
  towers: number[];
  includeCsv: boolean;
  includePdf: boolean;
  consolidatedSinglePdf?: boolean;
  onProgress?: (progress: PdfGenerationProgress) => void;
}): Promise<{ blob: Blob; fileName: string }> {
  const {
    mode,
    cycleId,
    services,
    towers,
    includeCsv,
    includePdf,
    consolidatedSinglePdf = false,
    onProgress,
  } = params;

  const settings = await getOrInitCycleSettings(mode, cycleId);
  const generatedFiles: { name: string; blob: Blob }[] = [];

  for (const service of services) {
    const referencesMap = await getReferencesForCycleService(
      mode,
      cycleId,
      service
    );
    const readingsMap = await getReadingsForCycleService(
      mode,
      cycleId,
      service
    );
    const svcCode = service === 'water' ? 'AGUA' : 'GAS';
    const fallbackTariff =
      service === 'water'
        ? settings.waterTariffPerM3
        : settings.gasTariffPerM3;

    if (includeCsv) {
      const csvStr = buildExportCsv({
        cycleId,
        service,
        towers,
        referencesMap,
        readingsMap,
        fallbackTariffPerM3: fallbackTariff,
      });
      const towerSuffix =
        towers.length === 1
          ? formatTowerCode(towers[0])
          : `T${formatTowerNumber(towers[0])}_a_T${formatTowerNumber(
              towers[towers.length - 1]
            )}`;
      generatedFiles.push({
        name: `Leituras_${cycleId}_${svcCode}_${towerSuffix}.csv`,
        blob: new Blob([csvStr], { type: 'text/csv;charset=utf-8' }),
      });
    }

    if (includePdf && !consolidatedSinglePdf) {
      for (const tower of towers) {
        const { pdfBlob, fileName } = await generateTowerA4ColorPdfBlob({
          mode,
          cycleId,
          service,
          tower,
          referencesMap,
          readingsMap,
          onProgress,
        });
        generatedFiles.push({ name: fileName, blob: pdfBlob });
      }
    }
  }

  if (includePdf && consolidatedSinglePdf) {
    const { pdfBlob, fileName } =
      await generateConsolidatedCycleA4ColorPdfBlob({
        mode,
        cycleId,
        services,
        towers,
        onProgress,
      });
    generatedFiles.push({ name: fileName, blob: pdfBlob });
  }

  if (generatedFiles.length === 1) {
    return {
      blob: generatedFiles[0].blob,
      fileName: generatedFiles[0].name,
    };
  }

  const zip = new JSZip();
  for (const f of generatedFiles) {
    zip.file(f.name, f.blob);
  }
  const zipBlob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
  });
  const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return {
    blob: zipBlob,
    fileName: `Relatorios_Coloridos_SN_Leituras_${cycleId}_${ts}.zip`,
  };
}
