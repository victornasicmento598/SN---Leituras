import {
  AlertCode,
  AlertLimitsConfig,
  ReadingRecord,
  ReferenceRecord,
  SEQUENTIAL_APARTMENTS,
  ServiceType,
  TOTAL_TOWERS,
  buildUnitKey,
} from '../types/domain';
import {
  evaluateReading,
  formatAlertLabel,
  formatDecimal4,
  parseDecimalInput,
} from './consumptionEngine';

export const EXPECTED_CSV_HEADER = 'Bloco;Apartamento;Anterior;Atual';

export interface ParsedCsvRow {
  lineNumber: number;
  tower: number;
  apartment: string;
  pastPreviousValue: number | null;
  /** The 'Atual' column from the past report becomes the 'previousValue' for the new cycle */
  newPreviousValue: number | null;
  rawLine: string;
}

export interface InvalidCsvRow {
  lineNumber: number;
  rawLine: string;
  reason: string;
}

export interface DuplicateCsvRow {
  lineNumber: number;
  firstSeenLine: number;
  tower: number;
  apartment: string;
  rawLine: string;
}

export interface MissingUnitItem {
  tower: number;
  apartment: string;
}

export interface SavedReadingImpactItem {
  unitId: string;
  tower: number;
  apartment: string;
  currentReadingValue: number;
  oldPreviousValue: number | null;
  newPreviousValue: number | null;
  oldConsumption: number | null;
  newConsumption: number | null;
  oldAlerts: AlertCode[];
  newAlerts: AlertCode[];
  oldStatus: 'read' | 'alert';
  newStatus: 'read' | 'alert';
}

export interface ReimportReferenceDiff {
  unitId: string;
  tower: number;
  apartment: string;
  oldPreviousValue: number | null;
  newPreviousValue: number | null;
  hasSavedReading: boolean;
}

export interface CsvParseAndDiffPreview {
  headerValid: boolean;
  headerError?: string;
  service: ServiceType;
  cycleId: string;
  sourceFileName: string;
  validRows: ParsedCsvRow[];
  duplicateRows: DuplicateCsvRow[];
  invalidRows: InvalidCsvRow[];
  missingUnits: MissingUnitItem[];
  isReimport: boolean;
  unchangedCount: number;
  newUnitsCount: number;
  changedWithoutSavedReading: ReimportReferenceDiff[];
  impactedSavedReadings: SavedReadingImpactItem[];
  affectedTowers: number[];
}

function parseTowerNumber(rawBloco: string): number | null {
  const cleaned = rawBloco
    .trim()
    .replace(/^(bloco|torre|bl|t)\s*/i, '')
    .trim();
  if (!/^\d{1,2}$/.test(cleaned)) return null;
  const num = Number(cleaned);
  if (num < 1 || num > TOTAL_TOWERS) return null;
  return num;
}

function parseApartmentCode(rawApto: string): string | null {
  const cleaned = rawApto
    .trim()
    .replace(/^(apartamento|apto|ap)\s*/i, '')
    .trim();
  if (!SEQUENTIAL_APARTMENTS.includes(cleaned)) return null;
  return cleaned;
}

/**
 * Parses a UTF-8 CSV (with or without BOM) using exact header `Bloco;Apartamento;Anterior;Atual`
 * and compares against existing references and saved readings for the target cycle & service.
 */
export function parseAndAnalyzeStartingCsv(params: {
  csvContent: string;
  sourceFileName: string;
  service: ServiceType;
  cycleId: string;
  existingReferences: Map<string, ReferenceRecord>;
  existingReadings: Map<string, ReadingRecord>;
  limits: AlertLimitsConfig;
}): CsvParseAndDiffPreview {
  const {
    csvContent,
    sourceFileName,
    service,
    cycleId,
    existingReferences,
    existingReadings,
    limits,
  } = params;

  // Strip UTF-8 BOM if present
  const withoutBom = csvContent.replace(/^\uFEFF/, '');
  const lines = withoutBom.split(/\r?\n/);

  // Find first non-empty line for header
  let headerLineIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().length > 0) {
      headerLineIdx = i;
      break;
    }
  }

  if (headerLineIdx === -1) {
    return {
      headerValid: false,
      headerError: 'O arquivo CSV está vazio.',
      service,
      cycleId,
      sourceFileName,
      validRows: [],
      duplicateRows: [],
      invalidRows: [],
      missingUnits: [],
      isReimport: existingReferences.size > 0,
      unchangedCount: 0,
      newUnitsCount: 0,
      changedWithoutSavedReading: [],
      impactedSavedReadings: [],
      affectedTowers: [],
    };
  }

  const rawHeader = lines[headerLineIdx].trim();
  if (rawHeader !== EXPECTED_CSV_HEADER) {
    return {
      headerValid: false,
      headerError: `Cabeçalho inválido: "${rawHeader}". O cabeçalho exato exigido é "${EXPECTED_CSV_HEADER}".`,
      service,
      cycleId,
      sourceFileName,
      validRows: [],
      duplicateRows: [],
      invalidRows: [],
      missingUnits: [],
      isReimport: existingReferences.size > 0,
      unchangedCount: 0,
      newUnitsCount: 0,
      changedWithoutSavedReading: [],
      impactedSavedReadings: [],
      affectedTowers: [],
    };
  }

  const validRows: ParsedCsvRow[] = [];
  const duplicateRows: DuplicateCsvRow[] = [];
  const invalidRows: InvalidCsvRow[] = [];
  const seenUnits = new Map<string, number>(); // key: T_A -> first lineNumber

  for (let i = headerLineIdx + 1; i < lines.length; i++) {
    const rawLine = lines[i];
    if (!rawLine || rawLine.trim().length === 0) continue;
    const lineNumber = i + 1;
    const cols = rawLine.split(';');
    if (cols.length !== 4) {
      invalidRows.push({
        lineNumber,
        rawLine,
        reason: `Esperadas 4 colunas separadas por ';', encontradas ${cols.length}.`,
      });
      continue;
    }

    const [rawBloco, rawApto, rawAnterior, rawAtual] = cols;
    const tower = parseTowerNumber(rawBloco);
    if (tower === null) {
      invalidRows.push({
        lineNumber,
        rawLine,
        reason: `Bloco/Torre inválido ("${rawBloco.trim()}"). Deve ser de 1 a 28.`,
      });
      continue;
    }

    const apartment = parseApartmentCode(rawApto);
    if (apartment === null) {
      invalidRows.push({
        lineNumber,
        rawLine,
        reason: `Apartamento inválido ("${rawApto.trim()}"). Deve estar entre 101 e 504 (4 por andar).`,
      });
      continue;
    }

    const trimmedAnterior = rawAnterior.trim();
    const pastPreviousValue =
      trimmedAnterior === '' || trimmedAnterior === '-'
        ? null
        : parseDecimalInput(trimmedAnterior);

    if (trimmedAnterior !== '' && trimmedAnterior !== '-' && pastPreviousValue === null) {
      invalidRows.push({
        lineNumber,
        rawLine,
        reason: `Coluna Anterior inválida ("${trimmedAnterior}"). Use decimal com até 4 casas sem separador de milhar.`,
      });
      continue;
    }

    const trimmedAtual = rawAtual.trim();
    const newPreviousValue =
      trimmedAtual === '' || trimmedAtual === '-'
        ? null
        : parseDecimalInput(trimmedAtual);

    if (trimmedAtual !== '' && trimmedAtual !== '-' && newPreviousValue === null) {
      invalidRows.push({
        lineNumber,
        rawLine,
        reason: `Coluna Atual (que vira referência anterior) inválida ("${trimmedAtual}"). Use decimal com até 4 casas sem separador de milhar.`,
      });
      continue;
    }

    const unitKeyShort = `${tower}_${apartment}`;
    const firstSeen = seenUnits.get(unitKeyShort);
    if (firstSeen !== undefined) {
      duplicateRows.push({
        lineNumber,
        firstSeenLine: firstSeen,
        tower,
        apartment,
        rawLine,
      });
      continue;
    }

    seenUnits.set(unitKeyShort, lineNumber);
    validRows.push({
      lineNumber,
      tower,
      apartment,
      pastPreviousValue,
      newPreviousValue,
      rawLine,
    });
  }

  // Calculate missing units out of the 560 total units
  const missingUnits: MissingUnitItem[] = [];
  for (let t = 1; t <= TOTAL_TOWERS; t++) {
    for (const apt of SEQUENTIAL_APARTMENTS) {
      if (!seenUnits.has(`${t}_${apt}`)) {
        missingUnits.push({ tower: t, apartment: apt });
      }
    }
  }

  // Compare against existing references & saved readings
  let unchangedCount = 0;
  let newUnitsCount = 0;
  const changedWithoutSavedReading: ReimportReferenceDiff[] = [];
  const impactedSavedReadings: SavedReadingImpactItem[] = [];
  const affectedTowersSet = new Set<number>();

  for (const row of validRows) {
    const unitId = buildUnitKey(cycleId, service, row.tower, row.apartment);
    const existingRef = existingReferences.get(unitId);
    const savedReading = existingReadings.get(unitId);

    if (!existingRef) {
      newUnitsCount++;
      affectedTowersSet.add(row.tower);
      if (savedReading && savedReading.previousValue !== row.newPreviousValue) {
        const oldEval = evaluateReading({
          service,
          previousValue: savedReading.previousValue,
          currentValue: savedReading.currentValue,
          limits,
          exceptionType: savedReading.exceptionType,
        });
        const newEval = evaluateReading({
          service,
          previousValue: row.newPreviousValue,
          currentValue: savedReading.currentValue,
          limits,
          exceptionType: savedReading.exceptionType,
        });
        impactedSavedReadings.push({
          unitId,
          tower: row.tower,
          apartment: row.apartment,
          currentReadingValue: savedReading.currentValue,
          oldPreviousValue: savedReading.previousValue,
          newPreviousValue: row.newPreviousValue,
          oldConsumption: oldEval.consumption,
          newConsumption: newEval.consumption,
          oldAlerts: oldEval.alerts,
          newAlerts: newEval.alerts,
          oldStatus: oldEval.status,
          newStatus: newEval.status,
        });
      }
    } else if (existingRef.previousValue === row.newPreviousValue) {
      unchangedCount++;
    } else {
      affectedTowersSet.add(row.tower);
      if (savedReading) {
        const oldEval = evaluateReading({
          service,
          previousValue: savedReading.previousValue,
          currentValue: savedReading.currentValue,
          limits,
          exceptionType: savedReading.exceptionType,
        });
        const newEval = evaluateReading({
          service,
          previousValue: row.newPreviousValue,
          currentValue: savedReading.currentValue,
          limits,
          exceptionType: savedReading.exceptionType,
        });
        impactedSavedReadings.push({
          unitId,
          tower: row.tower,
          apartment: row.apartment,
          currentReadingValue: savedReading.currentValue,
          oldPreviousValue: savedReading.previousValue,
          newPreviousValue: row.newPreviousValue,
          oldConsumption: oldEval.consumption,
          newConsumption: newEval.consumption,
          oldAlerts: oldEval.alerts,
          newAlerts: newEval.alerts,
          oldStatus: oldEval.status,
          newStatus: newEval.status,
        });
      } else {
        changedWithoutSavedReading.push({
          unitId,
          tower: row.tower,
          apartment: row.apartment,
          oldPreviousValue: existingRef.previousValue,
          newPreviousValue: row.newPreviousValue,
          hasSavedReading: false,
        });
      }
    }
  }

  return {
    headerValid: true,
    service,
    cycleId,
    sourceFileName,
    validRows,
    duplicateRows,
    invalidRows,
    missingUnits,
    isReimport: existingReferences.size > 0,
    unchangedCount,
    newUnitsCount,
    changedWithoutSavedReading,
    impactedSavedReadings,
    affectedTowers: Array.from(affectedTowersSet).sort((a, b) => a - b),
  };
}

/**
 * Validates that a custom physical panel order for a tower contains each of the
 * 20 apartments (101..504) exactly once.
 */
export function validatePhysicalOrderInput(rawText: string): {
  valid: boolean;
  apartments: string[];
  error?: string;
} {
  const tokens = rawText
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);

  if (tokens.length !== SEQUENTIAL_APARTMENTS.length) {
    return {
      valid: false,
      apartments: [],
      error: `A ordem física deve conter exatamente 20 apartamentos. Informados: ${tokens.length}.`,
    };
  }

  const invalidTokens = tokens.filter((t) => !SEQUENTIAL_APARTMENTS.includes(t));
  if (invalidTokens.length > 0) {
    return {
      valid: false,
      apartments: [],
      error: `Apartamentos inválidos encontrados: ${invalidTokens.join(', ')}. Use números de 101 a 504.`,
    };
  }

  const unique = new Set(tokens);
  if (unique.size !== SEQUENTIAL_APARTMENTS.length) {
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const t of tokens) {
      if (seen.has(t)) dupes.push(t);
      seen.add(t);
    }
    return {
      valid: false,
      apartments: [],
      error: `Cada apartamento deve aparecer uma única vez. Duplicados: ${Array.from(new Set(dupes)).join(', ')}.`,
    };
  }

  return {
    valid: true,
    apartments: tokens,
  };
}

/**
 * Generates a complete 560-unit homologated CSV for Gas or Water,
 * guaranteeing that Bloco 1, Apartamento 303, Gas has Atual = 266,0070
 * (so in the new cycle, Anterior = 266,0070 and entering 266,8440 yields 0,8370 m³).
 */
export function generateHomologatedPilotCsv(service: ServiceType): string {
  const rows: string[] = [EXPECTED_CSV_HEADER];

  for (let tower = 1; tower <= TOTAL_TOWERS; tower++) {
    for (let idx = 0; idx < SEQUENTIAL_APARTMENTS.length; idx++) {
      const apt = SEQUENTIAL_APARTMENTS[idx];
      if (service === 'gas' && tower === 1 && apt === '303') {
        // Explicit homologation case requested by user:
        // Bloco 1, apto 303, Gás: anterior becomes 266.0070
        rows.push('1;303;265,1200;266,0070');
        continue;
      }

      if (service === 'gas' && tower === 1 && apt === '101') {
        rows.push('1;101;140,2500;142,5000');
        continue;
      }

      if (service === 'gas' && tower === 1 && apt === '102') {
        rows.push('1;102;98,0000;99,1250');
        continue;
      }

      // Deterministic realistic meter readings with 4 decimal places
      const base =
        service === 'water'
          ? 310 + tower * 7 + idx * 3.125
          : 120 + tower * 4 + idx * 1.6425;
      const prev = formatDecimal4(base - 2.45, true);
      const curr = formatDecimal4(base, true);
      rows.push(`${tower};${apt};${prev};${curr}`);
    }
  }

  return rows.join('\n');
}

/**
 * Exports collected readings and references for selected towers/services into CSV format.
 */
export function buildExportCsv(params: {
  cycleId: string;
  service: ServiceType;
  towers: number[];
  referencesMap: Map<string, ReferenceRecord>;
  readingsMap: Map<string, ReadingRecord>;
}): string {
  const { cycleId, service, towers, referencesMap, readingsMap } = params;
  const lines: string[] = [
    'Ciclo;Servico;Bloco;Apartamento;Anterior;Atual;Consumo;Status;Alertas;Excecao;Observacao;AutorRegistro;DataRegistro;AutorUltimaEdicao;Sincronizacao;CodigoAuditoriaFoto1;CodigoAuditoriaFoto2',
  ];

  const serviceLabel = service === 'water' ? 'Agua' : 'Gas';

  for (const tower of towers) {
    for (const apt of SEQUENTIAL_APARTMENTS) {
      const unitId = buildUnitKey(cycleId, service, tower, apt);
      const ref = referencesMap.get(unitId);
      const reading = readingsMap.get(unitId);

      const prevStr =
        reading?.previousValue !== undefined && reading?.previousValue !== null
          ? formatDecimal4(reading.previousValue, true)
          : ref?.previousValue !== undefined && ref?.previousValue !== null
          ? formatDecimal4(ref.previousValue, true)
          : '';

      const currStr = reading ? formatDecimal4(reading.currentValue, true) : '';
      const consStr =
        reading && reading.consumption !== null
          ? formatDecimal4(reading.consumption, true)
          : '';
      const statusStr = reading
        ? reading.status === 'alert'
          ? 'Alerta'
          : 'Lida'
        : 'Pendente';
      const alertsStr = reading
        ? reading.alerts.map(formatAlertLabel).join(' | ')
        : '';
      const excStr = reading ? reading.exceptionType : '';
      const obsStr = reading
        ? (reading.observation || '').replace(/[;\r\n]+/g, ' ')
        : '';
      const authorStr = reading ? reading.createdByName : '';
      const dateStr = reading ? reading.createdAt : '';
      const editorStr = reading ? reading.updatedByName : '';
      const syncStr = reading
        ? reading.syncStatus === 'synced'
          ? 'Sincronizada'
          : reading.syncStatus === 'conflict'
          ? 'Conflito'
          : 'Salva no aparelho'
        : '';
      const aud1 = reading ? reading.auditCode1 : '';
      const aud2 = reading ? reading.auditCode2 : '';

      lines.push(
        [
          cycleId,
          serviceLabel,
          tower,
          apt,
          prevStr,
          currStr,
          consStr,
          statusStr,
          alertsStr,
          excStr,
          obsStr,
          authorStr,
          dateStr,
          editorStr,
          syncStr,
          aud1,
          aud2,
        ].join(';')
      );
    }
  }

  return '\uFEFF' + lines.join('\n');
}
