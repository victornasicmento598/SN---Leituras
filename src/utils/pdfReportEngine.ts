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
  buildUnitKey,
  formatTowerCode,
  formatTowerNumber,
} from '../types/domain';
import {
  evaluateReading,
  formatAlertLabel,
  formatDecimal4,
} from './consumptionEngine';
import { buildExportCsv } from './csvEngine';

async function blobToGrayscaleJpegDataUrl(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const targetW = 420;
      const ratio = (img.naturalHeight || 300) / (img.naturalWidth || 400);
      const targetH = Math.round(targetW * ratio);
      const canvas = document.createElement('canvas');
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(null);
        return;
      }
      ctx.drawImage(img, 0, 0, targetW, targetH);
      // Convert to crisp high-contrast B&W grayscale for A4 printing
      const imgData = ctx.getImageData(0, 0, targetW, targetH);
      const d = imgData.data;
      for (let i = 0; i < d.length; i += 4) {
        const lum = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
        d[i] = lum;
        d[i + 1] = lum;
        d[i + 2] = lum;
      }
      ctx.putImageData(imgData, 0, 0);
      resolve(canvas.toDataURL('image/jpeg', 0.76));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

/**
 * Generates an A4 Black & White PDF report for a single tower and service:
 * - Complete 20-unit table with previous reading, current reading, exact consumption (4 decimals),
 *   status/alerts, observation, and author
 * - Tower totals excluding replaced meters
 * - Grayscale thumbnail photos of all readings that triggered an alert (including 2nd validation photo)
 */
export async function generateTowerA4BwPdfBlob(params: {
  mode: OperatingMode;
  cycleId: string;
  service: ServiceType;
  tower: number;
  referencesMap: Map<string, ReferenceRecord>;
  readingsMap: Map<string, ReadingRecord>;
}): Promise<{ pdfBlob: Blob; fileName: string }> {
  const { mode, cycleId, service, tower, referencesMap, readingsMap } = params;
  const settings = await getOrInitCycleSettings(mode, cycleId);
  const doc = new jsPDF({
    orientation: 'portrait',
    unit: 'mm',
    format: 'a4',
  });

  const serviceName = service === 'water' ? 'ÁGUA' : 'GÁS';
  const alertLimit =
    service === 'water' ? settings.waterAlertLimit : settings.gasAlertLimit;
  const ceilingLimit =
    service === 'water' ? settings.waterCeilingLimit : settings.gasCeilingLimit;

  // Header Box (Strictly B&W)
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.5);
  doc.rect(12, 12, 186, 24);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(0, 0, 0);
  doc.text(
    `SN - LEITURAS • ${CONDOMINIUM_NAME.toUpperCase()}`,
    16,
    19
  );

  doc.setFontSize(11);
  doc.text(
    `RELATÓRIO DE CONFERÊNCIA • TORRE ${formatTowerNumber(tower)} • SERVIÇO: ${serviceName} • CICLO: ${cycleId}`,
    16,
    26
  );

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.text(
    `Critério de Alerta: Limite Configurado (${formatDecimal4(
      alertLimit
    )} m³ / Teto ${formatDecimal4(ceilingLimit)} m³)   |   Emitido em: ${new Date().toLocaleString(
      'pt-BR'
    )}`,
    16,
    32.5
  );

  // Compute summary metrics across all 20 units using the exact same evaluateReading engine
  let readUnits = 0;
  let pendingUnits = 0;
  let alertUnits = 0;
  let meterReplacedUnits = 0;
  let totalValidConsumptionScaled = 0;
  const alertReadingsWithPhotos: ReadingRecord[] = [];

  interface RowRenderData {
    apt: string;
    prevStr: string;
    currStr: string;
    consStr: string;
    statusStr: string;
    obsAndAlertStr: string;
    authorStr: string;
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
        statusStr: 'PENDENTE',
        obsAndAlertStr: '',
        authorStr: '—',
      });
      continue;
    }

    readUnits++;
    const evalRes = evaluateReading({
      service,
      previousValue: reading.previousValue,
      currentValue: reading.currentValue,
      limits: settings,
      exceptionType: reading.exceptionType,
    });

    if (evalRes.status === 'alert') {
      alertUnits++;
      alertReadingsWithPhotos.push(reading);
    }
    if (reading.exceptionType === 'meter_replaced') {
      meterReplacedUnits++;
    }
    if (evalRes.consumption !== null && !evalRes.excludeFromTotals) {
      totalValidConsumptionScaled += Math.round(evalRes.consumption * 10000);
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
          : 'Excluído (Troca)',
      statusStr: evalRes.status === 'alert' ? 'ALERTA' : 'LIDA',
      obsAndAlertStr: combinedObs.slice(0, 48),
      authorStr: (reading.updatedByName || reading.createdByName || 'Local').slice(
        0,
        14
      ),
    });
  }

  const totalConsumptionM3 = totalValidConsumptionScaled / 10000;

  // Summary strip
  doc.setLineWidth(0.3);
  doc.rect(12, 39, 186, 10);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text(
    `Lidas: ${readUnits}/20   |   Pendentes: ${pendingUnits}   |   Com Alerta: ${alertUnits}   |   Trocas de Medidor: ${meterReplacedUnits}   |   Consumo Total Válido: ${formatDecimal4(
      totalConsumptionM3,
      true
    )} m³`,
    16,
    45.3
  );

  // Table Header
  let y = 55;
  const colX = {
    apt: 12,
    prev: 26,
    curr: 52,
    cons: 78,
    status: 104,
    obs: 124,
    author: 174,
  };

  doc.setFillColor(230, 230, 230);
  doc.rect(12, y - 4.5, 186, 6.5, 'FD');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(8);
  doc.text('APTO', colX.apt + 1.5, y);
  doc.text('ANTERIOR (m³)', colX.prev + 1.5, y);
  doc.text('ATUAL (m³)', colX.curr + 1.5, y);
  doc.text('CONSUMO (m³)', colX.cons + 1.5, y);
  doc.text('STATUS', colX.status + 1.5, y);
  doc.text('ALERTAS / OBSERVAÇÃO', colX.obs + 1.5, y);
  doc.text('AUTOR', colX.author + 1.5, y);

  y += 2;

  // Table Rows (20 units)
  doc.setFontSize(8);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rowY = y + i * 6.2;
    doc.setDrawColor(180, 180, 180);
    doc.setLineWidth(0.15);
    doc.rect(12, rowY, 186, 6.2);

    doc.setFont('helvetica', 'bold');
    doc.text(r.apt, colX.apt + 2, rowY + 4.3);

    doc.setFont('courier', 'normal');
    doc.text(r.prevStr, colX.prev + 2, rowY + 4.3);
    doc.text(r.currStr, colX.curr + 2, rowY + 4.3);
    doc.setFont('courier', 'bold');
    doc.text(r.consStr, colX.cons + 2, rowY + 4.3);

    doc.setFont('helvetica', r.statusStr === 'ALERTA' ? 'bold' : 'normal');
    doc.text(r.statusStr, colX.status + 2, rowY + 4.3);

    doc.setFont('helvetica', 'normal');
    doc.text(r.obsAndAlertStr || '—', colX.obs + 2, rowY + 4.3);
    doc.text(r.authorStr, colX.author + 2, rowY + 4.3);
  }

  y += rows.length * 6.2 + 8;

  // Thumbnails section for readings with alert (Decision 3 confirmed by user!)
  if (alertReadingsWithPhotos.length > 0) {
    if (y > 230) {
      doc.addPage();
      y = 18;
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text(
      `EVIDÊNCIAS FOTOGRÁFICAS DAS LEITURAS COM ALERTA (${alertReadingsWithPhotos.length})`,
      12,
      y
    );
    y += 5;

    for (const alertReading of alertReadingsWithPhotos) {
      const photosMap = await getPhotosForReading(mode, alertReading.id);
      const p1 = photosMap.get('1');
      const p2 = photosMap.get('2');

      if (y > 235) {
        doc.addPage();
        y = 18;
      }

      doc.setDrawColor(0, 0, 0);
      doc.setLineWidth(0.3);
      doc.rect(12, y, 186, 44);

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.text(
        `Apto ${alertReading.apartment} • Atual: ${formatDecimal4(
          alertReading.currentValue,
          true
        )} m³ • Consumo: ${
          alertReading.consumption !== null
            ? `${formatDecimal4(alertReading.consumption, true)} m³`
            : 'Troca de Medidor'
        }`,
        15,
        y + 5.5
      );

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.text(
        `Alertas: ${alertReading.alerts.map(formatAlertLabel).join(', ')} | Obs: ${
          alertReading.observation || 'Sem observação'
        }`,
        15,
        y + 10.5
      );
      doc.text(
        `Registrado por: ${alertReading.createdByName} (${new Date(
          alertReading.createdAt
        ).toLocaleString('pt-BR')}) | Auditoria 1: ${
          alertReading.auditCode1 || '—'
        } | Auditoria 2: ${alertReading.auditCode2 || '—'}`,
        15,
        y + 15
      );

      if (p1) {
        const img1 = await blobToGrayscaleJpegDataUrl(p1.stampedBlob);
        if (img1) {
          doc.addImage(img1, 'JPEG', 15, y + 17, 46, 25);
        }
      } else {
        doc.text('[Sem 1ª foto]', 20, y + 29);
      }

      if (p2) {
        const img2 = await blobToGrayscaleJpegDataUrl(p2.stampedBlob);
        if (img2) {
          doc.addImage(img2, 'JPEG', 68, y + 17, 46, 25);
        }
      }

      y += 47;
    }
  } else {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8.5);
    doc.text(
      'Nenhuma leitura com alerta registrada nesta torre até o momento.',
      12,
      y
    );
  }

  const pdfArrayBuffer = doc.output('arraybuffer');
  const pdfBlob = new Blob([pdfArrayBuffer], { type: 'application/pdf' });
  const svcCode = service === 'water' ? 'AGUA' : 'GAS';
  const fileName = `Relatorio_A4_PB_${cycleId}_${svcCode}_${formatTowerCode(
    tower
  )}.pdf`;

  return { pdfBlob, fileName };
}

/**
 * Generates a multi-tower export package (single PDF/CSV or a ZIP bundle when multiple towers/files are selected).
 */
export async function exportReportsBundle(params: {
  mode: OperatingMode;
  cycleId: string;
  services: ServiceType[];
  towers: number[];
  includeCsv: boolean;
  includePdf: boolean;
}): Promise<{ blob: Blob; fileName: string }> {
  const { mode, cycleId, services, towers, includeCsv, includePdf } = params;

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

    if (includeCsv) {
      const csvStr = buildExportCsv({
        cycleId,
        service,
        towers,
        referencesMap,
        readingsMap,
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

    if (includePdf) {
      for (const tower of towers) {
        const { pdfBlob, fileName } = await generateTowerA4BwPdfBlob({
          mode,
          cycleId,
          service,
          tower,
          referencesMap,
          readingsMap,
        });
        generatedFiles.push({ name: fileName, blob: pdfBlob });
      }
    }
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
    fileName: `Relatorios_SN_Leituras_${cycleId}_${ts}.zip`,
  };
}
