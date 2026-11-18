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
 * Exact fixed-point subtraction scaled by 10,000 to avoid IEEE-754 drift.
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

/**
 * Formats a monetary value in BRL with 2 decimal places (e.g., "R$ 7,11" or "7,11").
 */
export function formatCurrencyBrl(
  value: number | null | undefined,
  includePrefix = true,
  useComma = true
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  const rounded = Math.round((value + Number.EPSILON) * 100) / 100;
  const fixed = rounded.toFixed(2);
  const formatted = useComma ? fixed.replace('.', ',') : fixed;
  return includePrefix ? `R$ ${formatted}` : formatted;
}

/**
 * Formats a tariff in R$/m³. Displays 2 decimal places when the 3rd/4th decimals are zero,
 * or 4 decimal places when fractional precision beyond cents is used.
 */
export function formatTariffBrl(
  tariff: number | null | undefined,
  includeUnit = true,
  useComma = true
): string {
  if (tariff === null || tariff === undefined || !Number.isFinite(tariff) || tariff <= 0) {
    return 'Sem tarifa';
  }
  const scaled = Math.round(tariff * DECIMAL_SCALE);
  const hasSubCentDecimals = scaled % 100 !== 0;
  const fixed = (scaled / DECIMAL_SCALE).toFixed(hasSubCentDecimals ? 4 : 2);
  const numStr = useComma ? fixed.replace('.', ',') : fixed;
  if (!includeUnit) return numStr;
  return `R$ ${numStr}/m³`;
}

export interface MonetaryCalculationResult {
  appliedTariff: number | null;
  calculatedAmountBrl: number | null;
  amountUnavailableReason: string | null;
}

/**
 * Computes the monetary amount in BRL (consumo × tarifa aplicável) with consistent
 * 2-decimal half-up rounding, or returns null with an explicit unavailability reason
 * when previous reading is missing, tariff is missing, meter was replaced, or consumption is negative.
 */
export function computeMonetaryAmountBrl(params: {
  previousValue: number | null;
  currentValue: number | null;
  rawConsumption: number | null;
  tariffPerM3: number | null | undefined;
  exceptionType?: ExceptionType;
}): MonetaryCalculationResult {
  const exceptionType = params.exceptionType || 'none';
  const normalizedTariff =
    params.tariffPerM3 !== null &&
    params.tariffPerM3 !== undefined &&
    Number.isFinite(params.tariffPerM3) &&
    params.tariffPerM3 > 0
      ? Math.round(params.tariffPerM3 * DECIMAL_SCALE) / DECIMAL_SCALE
      : null;

  if (exceptionType === 'meter_replaced') {
    return {
      appliedTariff: normalizedTariff,
      calculatedAmountBrl: null,
      amountUnavailableReason: 'Troca de medidor (consumo excluído)',
    };
  }

  if (params.previousValue === null) {
    return {
      appliedTariff: normalizedTariff,
      calculatedAmountBrl: null,
      amountUnavailableReason: 'Sem leitura anterior',
    };
  }

  if (params.currentValue === null || params.rawConsumption === null) {
    return {
      appliedTariff: normalizedTariff,
      calculatedAmountBrl: null,
      amountUnavailableReason:
        normalizedTariff === null ? 'Sem tarifa configurada' : null,
    };
  }

  if (params.rawConsumption < 0) {
    return {
      appliedTariff: normalizedTariff,
      calculatedAmountBrl: null,
      amountUnavailableReason: 'Consumo negativo (em revisão)',
    };
  }

  if (normalizedTariff === null) {
    return {
      appliedTariff: null,
      calculatedAmountBrl: null,
      amountUnavailableReason: 'Sem tarifa configurada',
    };
  }

  // Exact fixed-point product before cent rounding:
  // rawConsumption (scaled by 10,000) * normalizedTariff (scaled by 10,000) / 100,000,000
  const consScaled = Math.round(params.rawConsumption * DECIMAL_SCALE);
  const tariffScaled = Math.round(normalizedTariff * DECIMAL_SCALE);
  const exactBrl = (consScaled * tariffScaled) / (DECIMAL_SCALE * DECIMAL_SCALE);
  const roundedCents = Math.round((exactBrl + Number.EPSILON) * 100) / 100;

  return {
    appliedTariff: normalizedTariff,
    calculatedAmountBrl: roundedCents,
    amountUnavailableReason: null,
  };
}

export interface ConsumptionEvaluationResult {
  previousValue: number | null;
  currentValue: number | null;
  consumption: number | null;
  appliedTariff: number | null;
  calculatedAmountBrl: number | null;
  amountUnavailableReason: string | null;
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
 * Unified consumption, tariff/BRL monetary value, and alert classification engine
 * shared across Field Collection, Photo Stamp, Management Table, CSV Exports, and Full-Color A4 PDF reports.
 */
export function evaluateReading(params: {
  service: ServiceType;
  previousValue: number | null;
  currentValue: number | null;
  limits?: AlertLimitsConfig;
  exceptionType?: ExceptionType;
  historicalAverage?: number | null;
  overrideTariffPerM3?: number | null;
  tariffOverridePerM3?: number | null;
}): ConsumptionEvaluationResult {
  const limits = params.limits || DEFAULT_ALERT_LIMITS;
  const exceptionType = params.exceptionType || 'none';
  const isWater = params.service === 'water';

  const alertLimitUsed = isWater ? limits.waterAlertLimit : limits.gasAlertLimit;
  const ceilingLimitUsed = isWater ? limits.waterCeilingLimit : limits.gasCeilingLimit;
  const noiseLimitUsed = isWater ? null : limits.gasNoiseLimit;
  const explicitOverride =
    params.overrideTariffPerM3 !== undefined
      ? params.overrideTariffPerM3
      : params.tariffOverridePerM3;
  const configuredTariff =
    explicitOverride !== undefined
      ? explicitOverride
      : isWater
      ? limits.waterTariffPerM3
      : limits.gasTariffPerM3;

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

  const monetary = computeMonetaryAmountBrl({
    previousValue: params.previousValue,
    currentValue: params.currentValue,
    rawConsumption,
    tariffPerM3: configuredTariff,
    exceptionType,
  });

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
      'Medidor novo/trocado registrado. Consumo distorcido e valor em R$ excluídos da soma da torre. Exige justificativa e 2ª foto.';
  } else if (alerts.includes('NEGATIVE_CONSUMPTION')) {
    primaryAlertMessage = `Leitura menor que a anterior (${formatDecimal4(rawConsumption)} m³). Valor em R$ indisponível. Confirme o mostrador, informe justificativa ou troca de medidor e tire a 2ª foto.`;
  } else if (alerts.includes('CEILING_EXCEEDED')) {
    primaryAlertMessage = `Consumo acima do teto crítico de ${formatDecimal4(ceilingLimitUsed)} m³ (${formatDecimal4(rawConsumption)} m³). Exige justificativa e 2ª foto de validação.`;
  } else if (alerts.includes('HIGH_CONSUMPTION')) {
    primaryAlertMessage = `Consumo elevado acima do limite de ${formatDecimal4(alertLimitUsed)} m³ (${formatDecimal4(rawConsumption)} m³). Exige justificativa e 2ª foto de validação.`;
  } else if (alerts.includes('NO_PREVIOUS_READING')) {
    primaryAlertMessage =
      'Sem leitura anterior cadastrada para esta unidade. A leitura atual será salva como base (consumo e valor em R$ indisponíveis).';
  } else if (alerts.includes('GAS_NOISE')) {
    primaryAlertMessage = `Variação residual de Gás até ${formatDecimal4(noiseLimitUsed)} m³ (${formatDecimal4(rawConsumption)} m³ • faixa de ruído).`;
  }

  return {
    previousValue: params.previousValue,
    currentValue: params.currentValue,
    consumption: excludeFromTotals ? null : rawConsumption,
    appliedTariff: monetary.appliedTariff,
    calculatedAmountBrl: monetary.calculatedAmountBrl,
    amountUnavailableReason: monetary.amountUnavailableReason,
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

/**
 * Resolves the audited monetary snapshot for a saved ReadingRecord,
 * falling back to deterministic computation only for legacy records saved before tariffs were introduced.
 */
export function getAuditedReadingFinancials(
  reading: {
    previousValue: number | null;
    currentValue: number;
    consumption: number | null;
    exceptionType: ExceptionType;
    appliedTariff?: number | null;
    calculatedAmountBrl?: number | null;
    amountUnavailableReason?: string | null;
  },
  fallbackTariff: number | null = null
): MonetaryCalculationResult {
  if (
    reading.appliedTariff !== undefined ||
    reading.calculatedAmountBrl !== undefined ||
    reading.amountUnavailableReason !== undefined
  ) {
    return {
      appliedTariff: reading.appliedTariff ?? null,
      calculatedAmountBrl: reading.calculatedAmountBrl ?? null,
      amountUnavailableReason: reading.amountUnavailableReason ?? null,
    };
  }
  return computeMonetaryAmountBrl({
    previousValue: reading.previousValue,
    currentValue: reading.currentValue,
    rawConsumption: reading.consumption,
    tariffPerM3: fallbackTariff,
    exceptionType: reading.exceptionType,
  });
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
