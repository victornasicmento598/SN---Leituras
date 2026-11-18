import {
  AlertCode,
  AlertLimitsConfig,
  DEFAULT_ALERT_LIMITS,
  ExceptionType,
  ReferenceSourceType,
  ServiceType,
} from '../types/domain';

const DECIMAL_SCALE = 10000;

/**
 * Parses a decimal string with either comma or dot, rejecting thousand separators,
 * preserving up to 4 decimal places. Treats "0" or "0,0000" as valid zero.
 */
export function parseDecimalInput(raw: string | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw < 0) return null;
    return Math.round(raw * DECIMAL_SCALE) / DECIMAL_SCALE;
  }
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Reject strings with both comma and dot (thousand separator ambiguity) or multiple separators
  const commaCount = (trimmed.match(/,/g) || []).length;
  const dotCount = (trimmed.match(/\./g) || []).length;
  if (commaCount + dotCount > 1) return null;

  const normalized = trimmed.replace(',', '.');
  if (!/^\d+(\.\d{1,4})?$/.test(normalized)) {
    return null;
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * DECIMAL_SCALE) / DECIMAL_SCALE;
}

/**
 *Exact fixed-point subtraction scaled by 10,000 to avoid IEEE-754 drift.
 * Example: 266.8440 - 266.0070 = 0.8370
 */
export function computeExactConsumption(
  currentValue: number | null,
  previousValue: number | null
): number | null {
  if (currentValue === null || previousValue === null) return null;
  const currentScaled = Math.round(currentValue * DECIMAL_SCALE);
  const previousScaled = Math.round(previousValue * DECIMAL_SCALE);
  return (currentScaled - previousScaled) / DECIMAL_SCALE;
}

export function formatDecimal4(
  value: number | null | undefined,
  useComma = true
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  const fixed = (Math.round(value * DECIMAL_SCALE) / DECIMAL_SCALE).toFixed(4);
  return useComma ? fixed.replace('.', ',') : fixed;
}

export interface ConsumptionEvaluationResult {
  previousValue: number | null;
  currentValue: number | null;
  consumption: number | null;
  alerts: AlertCode[];
  status: 'read' | 'alert';
  requiresSecondPhoto: boolean;
  requiresJustification: boolean;
  excludeFromTotals: boolean;
  referenceSource: ReferenceSourceType;
  alertLimitUsed: number;
  ceilingLimitUsed: number;
  noiseLimitUsed: number | null;
  primaryAlertMessage: string | null;
}

/**
 * Unified consumption and alert classification engine shared across
 * Field Collection, Management Table, CSV Exports, and A4 B&W PDF reports.
 */
export function evaluateReading(params: {
  service: ServiceType;
  previousValue: number | null;
  currentValue: number | null;
  limits?: AlertLimitsConfig;
  exceptionType?: ExceptionType;
  historicalAverage?: number | null;
}): ConsumptionEvaluationResult {
  const limits = params.limits || DEFAULT_ALERT_LIMITS;
  const exceptionType = params.exceptionType || 'none';
  const isWater = params.service === 'water';

  const alertLimitUsed = isWater ? limits.waterAlertLimit : limits.gasAlertLimit;
  const ceilingLimitUsed = isWater ? limits.waterCeilingLimit : limits.gasCeilingLimit;
  const noiseLimitUsed = isWater ? null : limits.gasNoiseLimit;
  const referenceSource: ReferenceSourceType =
    params.historicalAverage !== undefined && params.historicalAverage !== null
      ? 'historical'
      : 'configured_limits';

  const alerts: AlertCode[] = [];

  if (params.previousValue === null) {
    alerts.push('NO_PREVIOUS_READING');
  }

  if (exceptionType === 'meter_replaced') {
    alerts.push('METER_REPLACED');
  }

  const rawConsumption = computeExactConsumption(
    params.currentValue,
    params.previousValue
  );

  // If meter was replaced, exclude distorted consumption from totals
  const excludeFromTotals = exceptionType === 'meter_replaced';

  if (rawConsumption !== null && !excludeFromTotals) {
    if (rawConsumption < 0) {
      alerts.push('NEGATIVE_CONSUMPTION');
    } else {
      if (rawConsumption > ceilingLimitUsed) {
        alerts.push('CEILING_EXCEEDED');
      } else if (rawConsumption > alertLimitUsed) {
        alerts.push('HIGH_CONSUMPTION');
      }

      if (
        !isWater &&
        noiseLimitUsed !== null &&
        rawConsumption > 0 &&
        rawConsumption <= noiseLimitUsed
      ) {
        alerts.push('GAS_NOISE');
      }
    }
  }

  const hasCriticalAnomaly =
    alerts.includes('NEGATIVE_CONSUMPTION') ||
    alerts.includes('HIGH_CONSUMPTION') ||
    alerts.includes('CEILING_EXCEEDED') ||
    alerts.includes('METER_REPLACED');

  const status: 'read' | 'alert' = hasCriticalAnomaly ? 'alert' : 'read';

  const requiresSecondPhoto = hasCriticalAnomaly;
  const requiresJustification = hasCriticalAnomaly;

  let primaryAlertMessage: string | null = null;
  if (alerts.includes('METER_REPLACED')) {
    primaryAlertMessage =
      'Medidor novo/trocado registrado. Consumo distorcido excluído da soma da torre. Exige justificativa e 2ª foto.';
  } else if (alerts.includes('NEGATIVE_CONSUMPTION')) {
    primaryAlertMessage = `Leitura menor que a anterior (${formatDecimal4(rawConsumption)} m³). Confirme o mostrador, informe justificativa ou troca de medidor e tire a 2ª foto.`;
  } else if (alerts.includes('CEILING_EXCEEDED')) {
    primaryAlertMessage = `Consumo acima do teto crítico de ${formatDecimal4(ceilingLimitUsed)} m³ (${formatDecimal4(rawConsumption)} m³). Exige justificativa e 2ª foto de validação.`;
  } else if (alerts.includes('HIGH_CONSUMPTION')) {
    primaryAlertMessage = `Consumo elevado acima do limite de ${formatDecimal4(alertLimitUsed)} m³ (${formatDecimal4(rawConsumption)} m³). Exige justificativa e 2ª foto de validação.`;
  } else if (alerts.includes('NO_PREVIOUS_READING')) {
    primaryAlertMessage =
      'Sem leitura anterior cadastrada para esta unidade. A leitura atual será salva como base.';
  } else if (alerts.includes('GAS_NOISE')) {
    primaryAlertMessage = `Variação residual de Gás até ${formatDecimal4(noiseLimitUsed)} m³ (${formatDecimal4(rawConsumption)} m³ • faixa de ruído).`;
  }

  return {
    previousValue: params.previousValue,
    currentValue: params.currentValue,
    consumption: excludeFromTotals ? null : rawConsumption,
    alerts,
    status,
    requiresSecondPhoto,
    requiresJustification,
    excludeFromTotals,
    referenceSource,
    alertLimitUsed,
    ceilingLimitUsed,
    noiseLimitUsed,
    primaryAlertMessage,
  };
}

export function formatAlertLabel(code: AlertCode): string {
  switch (code) {
    case 'NEGATIVE_CONSUMPTION':
      return 'Menor que anterior';
    case 'CEILING_EXCEEDED':
      return 'Acima do teto crítico';
    case 'HIGH_CONSUMPTION':
      return 'Consumo elevado';
    case 'METER_REPLACED':
      return 'Troca de medidor';
    case 'NO_PREVIOUS_READING':
      return 'Sem leitura anterior';
    case 'GAS_NOISE':
      return 'Ruído de Gás (≤ 0,5 m³)';
  }
}
