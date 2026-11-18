import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALERT_LIMITS,
  ReadingRecord,
  ReferenceRecord,
  SEQUENTIAL_APARTMENTS,
  ServerCursor,
  TOTAL_TOWERS,
  TOTAL_UNITS_PER_SERVICE,
  buildUnitKey,
} from './src/types/domain';
import {
  computeExactConsumption,
  evaluateReading,
  formatDecimal4,
  parseDecimalInput,
} from './src/utils/consumptionEngine';
import {
  EXPECTED_CSV_HEADER,
  generateHomologatedPilotCsv,
  parseAndAnalyzeStartingCsv,
  validatePhysicalOrderInput,
} from './src/utils/csvEngine';

describe('SN - Leituras • Motor de Consumo, CSV, Cursores e Regras Firestore', () => {
  it('valida o caso homologado Bloco 1, Apto 303, Gás: 266.8440 - 266.0070 = 0.8370 m³', () => {
    const anterior = parseDecimalInput('266,0070');
    const atual = parseDecimalInput('266.8440');
    expect(anterior).toBe(266.007);
    expect(atual).toBe(266.844);

    const consumo = computeExactConsumption(atual, anterior);
    expect(consumo).toBe(0.837);
    expect(formatDecimal4(consumo, false)).toBe('0.8370');
    expect(formatDecimal4(consumo, true)).toBe('0,8370');

    const evalRes = evaluateReading({
      service: 'gas',
      previousValue: anterior,
      currentValue: atual,
      limits: DEFAULT_ALERT_LIMITS,
    });
    expect(evalRes.consumption).toBe(0.837);
    expect(evalRes.status).toBe('read');
    expect(evalRes.alerts).toEqual([]);
  });

  it('classifica leitura menor que anterior, consumo elevado, teto crítico, ruído de gás e troca de medidor', () => {
    // 1. Leitura menor que a anterior (negativa)
    const neg = evaluateReading({
      service: 'gas',
      previousValue: 266.007,
      currentValue: 265.5,
      limits: DEFAULT_ALERT_LIMITS,
    });
    expect(neg.consumption).toBe(-0.507);
    expect(neg.status).toBe('alert');
    expect(neg.alerts).toContain('NEGATIVE_CONSUMPTION');
    expect(neg.requiresSecondPhoto).toBe(true);
    expect(neg.requiresJustification).toBe(true);

    // 2. Consumo elevado Gás (> 15 m³ e <= 50 m³)
    const highGas = evaluateReading({
      service: 'gas',
      previousValue: 100.0,
      currentValue: 118.25,
      limits: DEFAULT_ALERT_LIMITS,
    });
    expect(highGas.consumption).toBe(18.25);
    expect(highGas.status).toBe('alert');
    expect(highGas.alerts).toContain('HIGH_CONSUMPTION');
    expect(highGas.requiresSecondPhoto).toBe(true);

    // 3. Teto crítico Água (> 100 m³)
    const ceilingWater = evaluateReading({
      service: 'water',
      previousValue: 200.0,
      currentValue: 315.0,
      limits: DEFAULT_ALERT_LIMITS,
    });
    expect(ceilingWater.consumption).toBe(115.0);
    expect(ceilingWater.status).toBe('alert');
    expect(ceilingWater.alerts).toContain('CEILING_EXCEEDED');

    // 4. Ruído de Gás (<= 0,5 m³)
    const noiseGas = evaluateReading({
      service: 'gas',
      previousValue: 50.0,
      currentValue: 50.35,
      limits: DEFAULT_ALERT_LIMITS,
    });
    expect(noiseGas.consumption).toBe(0.35);
    expect(noiseGas.alerts).toContain('GAS_NOISE');
    expect(noiseGas.status).toBe('read');

    // 5. Troca de medidor exclui consumo distorcido dos totais
    const replaced = evaluateReading({
      service: 'water',
      previousValue: 450.1234,
      currentValue: 2.5,
      limits: DEFAULT_ALERT_LIMITS,
      exceptionType: 'meter_replaced',
    });
    expect(replaced.excludeFromTotals).toBe(true);
    expect(replaced.consumption).toBeNull();
    expect(replaced.alerts).toContain('METER_REPLACED');
    expect(replaced.requiresSecondPhoto).toBe(true);
  });

  it('importa CSV UTF-8 com e sem BOM, transforma Atual em Anterior e calcula impacto na reimportação', () => {
    expect(TOTAL_TOWERS).toBe(28);
    expect(SEQUENTIAL_APARTMENTS.length).toBe(20);
    expect(TOTAL_UNITS_PER_SERVICE).toBe(560);

    const csvWithBom =
      '\uFEFF' +
      [
        EXPECTED_CSV_HEADER,
        '1;101;10,0000;12,5000',
        '1;303;265,1200;266,0070',
        '1;303;265,1200;266,0070', // duplicada
        '99;101;10;12', // bloco inválido
        '1;102;0,0000;0,0000', // zero válido
        '1;103;;', // sem leitura anterior
      ].join('\n');

    const preview1 = parseAndAnalyzeStartingCsv({
      csvContent: csvWithBom,
      sourceFileName: 'teste_bom.csv',
      service: 'gas',
      cycleId: '2026-11',
      existingReferences: new Map(),
      existingReadings: new Map(),
      limits: DEFAULT_ALERT_LIMITS,
    });

    expect(preview1.headerValid).toBe(true);
    expect(preview1.validRows.length).toBe(4);
    expect(preview1.duplicateRows.length).toBe(1);
    expect(preview1.invalidRows.length).toBe(1);
    expect(preview1.missingUnits.length).toBe(560 - 4);

    const row303 = preview1.validRows.find(
      (r) => r.tower === 1 && r.apartment === '303'
    );
    expect(row303?.newPreviousValue).toBe(266.007);

    const rowZero = preview1.validRows.find(
      (r) => r.tower === 1 && r.apartment === '102'
    );
    expect(rowZero?.newPreviousValue).toBe(0);

    const rowEmpty = preview1.validRows.find(
      (r) => r.tower === 1 && r.apartment === '103'
    );
    expect(rowEmpty?.newPreviousValue).toBeNull();

    // Simular reimportação com leitura já coletada no Bloco 1, Apto 303
    const existingRefs = new Map<string, ReferenceRecord>();
    const unit303 = buildUnitKey('2026-11', 'gas', 1, '303');
    existingRefs.set(unit303, {
      id: unit303,
      cycleId: '2026-11',
      service: 'gas',
      tower: 1,
      apartment: '303',
      previousValue: 266.007,
      sourceFile: 'original.csv',
      importedAt: '2026-11-01T10:00:00.000Z',
      importedByUid: 'u1',
      importedByName: 'Leiturista 1',
    });

    const existingReadings = new Map<string, ReadingRecord>();
    existingReadings.set(unit303, {
      id: unit303,
      condominiumId: 'campos-do-sul',
      cycleId: '2026-11',
      service: 'gas',
      tower: 1,
      apartment: '303',
      previousValue: 266.007,
      currentValue: 266.844,
      consumption: 0.837,
      referenceSource: 'configured_limits',
      status: 'read',
      alerts: [],
      exceptionType: 'none',
      observation: 'Leitura preservada',
      photo1Id: 'p1',
      photo2Id: null,
      auditCode1: 'SN-T01-303-GF1',
      auditCode2: '',
      syncStatus: 'local_only',
      revision: 1,
      revisionToken: 'rv_1',
      baseRevisionToken: '',
      createdByUid: 'u1',
      createdByName: 'Leiturista 1',
      createdAt: '2026-11-02T10:00:00.000Z',
      updatedByUid: 'u1',
      updatedByName: 'Leiturista 1',
      updatedAt: '2026-11-02T10:00:00.000Z',
    });

    // Reimportar corrigindo a referência de 266,0070 para 250,0000 (gera impacto > 15 m³)
    const reimportCsv = [
      EXPECTED_CSV_HEADER,
      '1;303;248,0000;250,0000',
    ].join('\n');

    const preview2 = parseAndAnalyzeStartingCsv({
      csvContent: reimportCsv,
      sourceFileName: 'reimport.csv',
      service: 'gas',
      cycleId: '2026-11',
      existingReferences: existingRefs,
      existingReadings,
      limits: DEFAULT_ALERT_LIMITS,
    });

    expect(preview2.isReimport).toBe(true);
    expect(preview2.impactedSavedReadings.length).toBe(1);
    const imp = preview2.impactedSavedReadings[0];
    expect(imp.currentReadingValue).toBe(266.844);
    expect(imp.oldConsumption).toBe(0.837);
    expect(imp.newConsumption).toBe(16.844);
    expect(imp.oldStatus).toBe('read');
    expect(imp.newStatus).toBe('alert');
  });

  it('valida o CSV homologado de 560 unidades e a ordem física do painel de Gás', () => {
    const fullGasCsv = generateHomologatedPilotCsv('gas');
    const preview = parseAndAnalyzeStartingCsv({
      csvContent: fullGasCsv,
      sourceFileName: 'homologado_gas.csv',
      service: 'gas',
      cycleId: '2026-11',
      existingReferences: new Map(),
      existingReadings: new Map(),
      limits: DEFAULT_ALERT_LIMITS,
    });
    expect(preview.validRows.length).toBe(560);
    expect(preview.missingUnits.length).toBe(0);

    const validOrder = validatePhysicalOrderInput(
      [...SEQUENTIAL_APARTMENTS].reverse().join(', ')
    );
    expect(validOrder.valid).toBe(true);
    expect(validOrder.apartments.length).toBe(20);

    const duplicateOrder = validatePhysicalOrderInput(
      ['101', ...SEQUENTIAL_APARTMENTS.slice(1, 19), '101'].join(', ')
    );
    expect(duplicateOrder.valid).toBe(false);
  });

  it('preserva o cursor completo do servidor com seconds, nanoseconds e docId sem reduzir para milissegundos', () => {
    const cursor: ServerCursor = {
      seconds: 1763474400,
      nanoseconds: 987654321,
      docId: '2026-11_gas_T01_A303',
    };
    expect(cursor.seconds).toBe(1763474400);
    expect(cursor.nanoseconds).toBe(987654321);
    expect(cursor.docId).toBe('2026-11_gas_T01_A303');
  });

  it('verifica as regras endurecidas do Firestore (Dirty Dozen invariants, lista fixa de 2 UIDs e revisão sem leitura prévia)', () => {
    const rulesPath = path.resolve(__dirname, 'firestore.rules');
    const rulesText = fs.readFileSync(rulesPath, 'utf-8');

    // 1. Default deny catch-all
    expect(rulesText).toContain('match /{document=**}');
    expect(rulesText).toContain('allow read, write: if false;');

    // 2. Fixed 2-UID allowlist directly on request.auth.uid without extra collection read
    expect(rulesText).toContain(
      "request.auth.uid in ['UID_LEITURISTA_1', 'UID_LEITURISTA_2']"
    );
    expect(rulesText).toContain('request.auth.token.email_verified == true');

    // 3. Revision enforcement on create and update (eliminating pre-reads on queue flush)
    expect(rulesText).toContain('incoming().revision == 1');
    expect(rulesText).toContain('incoming().baseRevisionToken == ""');
    expect(rulesText).toContain(
      'incoming().revision == existing().revision + 1'
    );
    expect(rulesText).toContain(
      'incoming().baseRevisionToken == existing().revisionToken'
    );

    // 4. Server timestamp enforcement for composite cursor integrity
    expect(rulesText).toContain('data.serverUpdatedAt == request.time');

    // 5. Original authorship immutability on update
    expect(rulesText).toContain(
      'incoming().createdByUid == existing().createdByUid'
    );
    expect(rulesText).toContain(
      'incoming().createdByName == existing().createdByName'
    );
    expect(rulesText).toContain(
      'incoming().createdAt == existing().createdAt'
    );

    // 6. Photo payload size guard (<= 380,000 chars each, keeping 2 photos well under 1MB document limit)
    expect(rulesText).toContain('data.photo1DataUrl.size() <= 380000');
    expect(rulesText).toContain('data.photo2DataUrl.size() <= 380000');
  });
});
