import {
  CONDOMINIUM_NAME,
  ServiceType,
  formatTowerCode,
  formatTowerNumber,
} from '../types/domain';
import {
  formatCurrencyBrl,
  formatDecimal4,
  formatTariffBrl,
} from './consumptionEngine';

export interface StampPhotoInput {
  rawBlob: Blob;
  cycleId: string;
  tower: number;
  apartment: string;
  service: ServiceType;
  previousValue?: number | null;
  currentValue: number | null;
  consumption?: number | null;
  appliedTariff?: number | null;
  calculatedAmountBrl?: number | null;
  amountUnavailableReason?: string | null;
  slot: 1 | 2;
  capturedAtIso: string;
  existingAuditCode?: string;
}

export interface StampedPhotoOutput {
  stampedBlob: Blob;
  rawBlob: Blob;
  auditCode: string;
  fileName: string;
  stampedValue: number;
  stampedTariff: number | null;
  stampedAmountBrl: number | null;
  capturedAt: string;
  width: number;
  height: number;
  sizeBytes: number;
}

export function generateAuditCode(params: {
  tower: number;
  apartment: string;
  service: ServiceType;
  slot: 1 | 2;
  capturedAtIso: string;
  value: number | null;
}): string {
  const svcChar = params.service === 'water' ? 'A' : 'G';
  const valPart =
    params.value !== null
      ? Math.round(params.value * 10000).toString(36).toUpperCase()
      : '0';
  const tsPart = new Date(params.capturedAtIso)
    .getTime()
    .toString(36)
    .slice(-5)
    .toUpperCase();
  return `SN-${formatTowerCode(params.tower)}-${params.apartment}-${svcChar}F${params.slot}-${valPart}-${tsPart}`;
}

export function buildPhotoFileName(params: {
  tower: number;
  apartment: string;
  service: ServiceType;
  slot: 1 | 2;
  capturedAtIso: string;
}): string {
  const d = new Date(params.capturedAtIso);
  const pad = (n: number) => String(n).padStart(2, '0');
  const datePart = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(
    d.getDate()
  )}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const svc = params.service === 'water' ? 'AGUA' : 'GAS';
  return `${datePart}_${formatTowerCode(params.tower)}_A${params.apartment}_${svc}_F${params.slot}.jpg`;
}

function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = (err) => {
      URL.revokeObjectURL(url);
      reject(err);
    };
    img.src = url;
  });
}

function formatDateTimePtBr(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

/**
 * Compresses raw image blob to a clean base JPEG before keeping in IndexedDB draft
 * so memory is never bloated by 12MP camera captures.
 */
export async function normalizeRawImageBlob(fileOrBlob: Blob): Promise<Blob> {
  const img = await loadImageFromBlob(fileOrBlob);
  const maxDim = 1440;
  let w = img.naturalWidth || img.width || 1280;
  let h = img.naturalHeight || img.height || 960;
  if (w > maxDim || h > maxDim) {
    const ratio = Math.min(maxDim / w, maxDim / h);
    w = Math.round(w * ratio);
    h = Math.round(h * ratio);
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return fileOrBlob;
  ctx.drawImage(img, 0, 0, w, h);

  return new Promise<Blob>((resolve) => {
    canvas.toBlob(
      (b) => {
        canvas.width = 0;
        canvas.height = 0;
        resolve(b || fileOrBlob);
      },
      'image/jpeg',
      0.84
    );
  });
}

/**
 * Renders the full-color audit stamp directly onto the meter photo while keeping the
 * meter dial 100% clear, colored, and readable.
 * Includes the reading, previous reading, consumption (m³), applied tariff (R$/m³),
 * and calculated BRL value (R$) or unavailability reason inside the bottom audit bar.
 */
export async function stampMeterPhoto(
  input: StampPhotoInput
): Promise<StampedPhotoOutput> {
  const normalizedRaw = await normalizeRawImageBlob(input.rawBlob);
  const img = await loadImageFromBlob(normalizedRaw);

  const maxW = 1280;
  const srcW = img.naturalWidth || img.width || 1024;
  const srcH = img.naturalHeight || img.height || 768;
  const scale = srcW > maxW ? maxW / srcW : 1;
  const width = Math.max(640, Math.round(srcW * scale));
  const imageHeight = Math.max(480, Math.round(srcH * scale));
  const bannerHeight = Math.round(width * 0.21);
  const height = imageHeight + bannerHeight;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Não foi possível inicializar o canvas para carimbar a foto.');
  }

  // Draw original meter image in upper frame so the stamp never covers the meter dial
  ctx.fillStyle = '#0A2239';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, imageHeight);

  // Top badge for 2nd validation photo or service identification
  const serviceLabel = input.service === 'water' ? 'ÁGUA' : 'GÁS';
  const topPillText =
    input.slot === 2
      ? `2ª FOTO • VALIDAÇÃO DE EXCEÇÃO • ${serviceLabel}`
      : `1ª FOTO • LEITURA PRINCIPAL • ${serviceLabel}`;

  const topFontSize = Math.max(15, Math.round(width * 0.022));
  ctx.font = `700 ${topFontSize}px "Plus Jakarta Sans", sans-serif`;
  const textMetrics = ctx.measureText(topPillText);
  const pillW = textMetrics.width + 32;
  const pillH = topFontSize + 18;

  ctx.fillStyle =
    input.slot === 2 ? 'rgba(185, 28, 28, 0.92)' : 'rgba(10, 34, 57, 0.88)';
  ctx.fillRect(16, 16, pillW, pillH);
  ctx.strokeStyle = '#FFFFFF';
  ctx.lineWidth = 2;
  ctx.strokeRect(16, 16, pillW, pillH);
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(topPillText, 32, 16 + topFontSize + 4);

  // Bottom solid audit stamp bar (100% readable in sunlight, zero obstruction of meter dial)
  const barY = imageHeight;
  ctx.fillStyle = '#0A2239';
  ctx.fillRect(0, barY, width, bannerHeight);

  // Accent top stripe on stamp bar
  ctx.fillStyle = input.service === 'water' ? '#0D8A9E' : '#E08E00';
  ctx.fillRect(0, barY, width, 6);

  const numericValue = input.currentValue ?? 0;
  const auditCode =
    input.existingAuditCode ||
    generateAuditCode({
      tower: input.tower,
      apartment: input.apartment,
      service: input.service,
      slot: input.slot,
      capturedAtIso: input.capturedAtIso,
      value: numericValue,
    });

  const padX = Math.round(width * 0.024);
  const line1Y = barY + Math.round(bannerHeight * 0.23);
  const line2Y = barY + Math.round(bannerHeight * 0.48);
  const line3Y = barY + Math.round(bannerHeight * 0.72);
  const line4Y = barY + Math.round(bannerHeight * 0.92);

  const titleFont = Math.max(15, Math.round(width * 0.022));
  const valueFont = Math.max(17, Math.round(width * 0.025));
  const tariffFont = Math.max(15, Math.round(width * 0.022));
  const metaFont = Math.max(12, Math.round(width * 0.0175));

  // Line 1: Condominium + Tower + Apartment + Service
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `700 ${titleFont}px "Plus Jakarta Sans", sans-serif`;
  ctx.fillText(
    `${CONDOMINIUM_NAME} • Torre ${formatTowerNumber(input.tower)} • Apto ${input.apartment} • ${serviceLabel}`,
    padX,
    line1Y
  );

  // Line 2: Final Stamped Reading Value + Previous + Consumption
  ctx.fillStyle = '#FCD34D';
  ctx.font = `700 ${valueFont}px "JetBrains Mono", monospace`;
  const currDisplay =
    input.currentValue !== null
      ? `LEITURA: ${formatDecimal4(input.currentValue, true)} m³`
      : 'LEITURA: PENDENTE';
  const prevDisplay =
    input.previousValue !== undefined && input.previousValue !== null
      ? `ANT: ${formatDecimal4(input.previousValue, true)} m³`
      : 'ANT: SEM REF.';
  const consDisplay =
    input.consumption !== undefined && input.consumption !== null
      ? `CONS: ${formatDecimal4(input.consumption, true)} m³`
      : 'CONS: —';
  ctx.fillText(`${currDisplay}   |   ${prevDisplay}   |   ${consDisplay}`, padX, line2Y);

  // Line 3: Tariff (R$/m³) & Calculated Amount in Reais (R$) (Confirmed Decision 2)
  const tariffDisplay =
    input.appliedTariff !== undefined &&
    input.appliedTariff !== null &&
    input.appliedTariff > 0
      ? `TARIFA: ${formatTariffBrl(input.appliedTariff, true)}`
      : 'TARIFA: NÃO CONFIGURADA';
  const amountDisplay =
    input.calculatedAmountBrl !== undefined && input.calculatedAmountBrl !== null
      ? `VALOR: ${formatCurrencyBrl(input.calculatedAmountBrl, true)}`
      : `VALOR R$: INDISPONÍVEL (${input.amountUnavailableReason || 'Sem tarifa configurada'})`;

  ctx.fillStyle =
    input.calculatedAmountBrl !== undefined && input.calculatedAmountBrl !== null
      ? '#6EE7B7'
      : '#FDE68A';
  ctx.font = `700 ${tariffFont}px "JetBrains Mono", monospace`;
  ctx.fillText(`${tariffDisplay}   |   ${amountDisplay}`, padX, line3Y);

  // Line 4: Timestamp + Audit Code + Cycle
  ctx.fillStyle = '#E2E8F0';
  ctx.font = `600 ${metaFont}px "JetBrains Mono", monospace`;
  ctx.fillText(
    `DATA/HORA: ${formatDateTimePtBr(input.capturedAtIso)}   |   AUDITORIA: ${auditCode}   |   CICLO: ${input.cycleId}`,
    padX,
    line4Y
  );

  const stampedBlob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        canvas.width = 0;
        canvas.height = 0;
        if (b) resolve(b);
        else reject(new Error('Falha ao codificar JPEG carimbado.'));
      },
      'image/jpeg',
      0.8
    );
  });

  const fileName = buildPhotoFileName({
    tower: input.tower,
    apartment: input.apartment,
    service: input.service,
    slot: input.slot,
    capturedAtIso: input.capturedAtIso,
  });

  return {
    stampedBlob,
    rawBlob: normalizedRaw,
    auditCode,
    fileName,
    stampedValue: numericValue,
    stampedTariff: input.appliedTariff ?? null,
    stampedAmountBrl: input.calculatedAmountBrl ?? null,
    capturedAt: input.capturedAtIso,
    width,
    height,
    sizeBytes: stampedBlob.size,
  };
}

/**
 * Generates a synthetic realistic color meter dial JPEG for Training Mode or quick simulator testing
 * when testing inside a desktop preview without a physical gas/water meter.
 */
export async function createSimulatedMeterRawBlob(params: {
  tower: number;
  apartment: string;
  service: ServiceType;
  value: number;
}): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = 960;
  canvas.height = 640;
  const ctx = canvas.getContext('2d')!;

  // Distinct color-coded metallic meter casing background (Blue tint for Water, Amber/Gold tint for Gas)
  const grad = ctx.createLinearGradient(0, 0, 960, 640);
  if (params.service === 'water') {
    grad.addColorStop(0, '#BAE6FD');
    grad.addColorStop(0.5, '#E0F2FE');
    grad.addColorStop(1, '#7DD3FC');
  } else {
    grad.addColorStop(0, '#FDE68A');
    grad.addColorStop(0.5, '#FEF3C7');
    grad.addColorStop(1, '#FCD34D');
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 960, 640);

  // Colored outer meter ring
  ctx.strokeStyle = params.service === 'water' ? '#0284C7' : '#D97706';
  ctx.lineWidth = 14;
  ctx.strokeRect(24, 24, 912, 592);

  // Inner meter housing bezel
  ctx.fillStyle = '#FFFFFF';
  ctx.strokeStyle = params.service === 'water' ? '#0369A1' : '#B45309';
  ctx.lineWidth = 8;
  ctx.beginPath();
  ctx.roundRect(110, 80, 740, 480, 36);
  ctx.fill();
  ctx.stroke();

  // Service header inside meter faceplate
  ctx.fillStyle = params.service === 'water' ? '#0369A1' : '#B45309';
  ctx.font = '800 34px "Plus Jakarta Sans", sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(
    params.service === 'water' ? 'HIDRÔMETRO • ÁGUA (m³)' : 'MEDIDOR DE GÁS (m³)',
    480,
    165
  );

  // Odometer drum window
  ctx.fillStyle = '#0F172A';
  ctx.fillRect(190, 225, 500, 110);

  const formatted = (Math.round(params.value * 10000) / 10000)
    .toFixed(4)
    .replace('.', '');
  const paddedDigits = formatted.padStart(8, '0'); // 4 integer + 4 decimal digits

  for (let i = 0; i < 8; i++) {
    const isDecimal = i >= 4;
    const boxX = 202 + i * 60;
    ctx.fillStyle = isDecimal ? '#DC2626' : '#1E293B';
    ctx.fillRect(boxX, 237, 52, 86);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '700 52px "JetBrains Mono", monospace';
    ctx.textAlign = 'center';
    ctx.fillText(paddedDigits[i], boxX + 26, 299);
  }

  ctx.fillStyle = '#0F172A';
  ctx.font = '700 36px "Plus Jakarta Sans", sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('m³', 705, 295);

  ctx.fillStyle = '#1E293B';
  ctx.font = '700 24px "JetBrains Mono", monospace';
  ctx.textAlign = 'center';
  ctx.fillText(
    `Torre ${formatTowerNumber(params.tower)} • Apto ${params.apartment} • ${formatDecimal4(
      params.value,
      true
    )} m³`,
    480,
    435
  );

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        canvas.width = 0;
        canvas.height = 0;
        if (b) resolve(b);
        else reject(new Error('Erro ao gerar imagem simulada.'));
      },
      'image/jpeg',
      0.84
    );
  });
}

/**
 * Converts a stamped JPEG Blob into a bounded DataURL (<= 350,000 chars) so two photos
 * inside a single Firestore document stay strictly within the 1MB Firestore limit
 * and pass the 380,000-character security rule guard.
 */
export async function blobToBoundedDataUrl(
  blob: Blob,
  maxChars = 340000
): Promise<string> {
  const directDataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = (err) => reject(err);
    reader.readAsDataURL(blob);
  });

  if (directDataUrl.length <= maxChars) {
    return directDataUrl;
  }

  // Adaptive downscale/compression if needed
  const img = await loadImageFromBlob(blob);
  let targetW = Math.min(1024, img.naturalWidth || 1024);
  let targetH = Math.round(
    targetW * ((img.naturalHeight || 768) / (img.naturalWidth || 1024))
  );
  let quality = 0.68;

  for (let attempt = 0; attempt < 4; attempt++) {
    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) break;
    ctx.drawImage(img, 0, 0, targetW, targetH);
    const compressedUrl = canvas.toDataURL('image/jpeg', quality);
    canvas.width = 0;
    canvas.height = 0;
    if (compressedUrl.length <= maxChars) {
      return compressedUrl;
    }
    targetW = Math.round(targetW * 0.82);
    targetH = Math.round(targetH * 0.82);
    quality = Math.max(0.45, quality - 0.1);
  }

  return directDataUrl.slice(0, maxChars);
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return res.blob();
}

export function triggerPhotoDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

export function canBrowserShareFiles(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.share === 'function' &&
    typeof navigator.canShare === 'function'
  );
}

export async function sharePhotoFile(
  blob: Blob,
  fileName: string,
  title: string
): Promise<boolean> {
  if (!canBrowserShareFiles()) return false;
  const file = new File([blob], fileName, { type: 'image/jpeg' });
  if (!navigator.canShare({ files: [file] })) return false;
  await navigator.share({
    title,
    text: title,
    files: [file],
  });
  return true;
}
