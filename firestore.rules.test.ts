import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  AlertLimitsConfig,
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
  computeMonetaryAmountBrl,
  evaluateReading,
  formatCurrencyBrl,
  formatDecimal4,
  formatTariffBrl,
  getAuditedReadingFinancials,
  parseDecimalInput,
} from './src/utils/consumptionEngine';
import {
  EXPECTED_CSV_HEADER,
  EXPORT_CSV_HEADER,
  buildExportCsv,
  generateHomologatedPilotCsv,
  parseAndAnalyzeStartingCsv,
  validatePhysicalOrderInput,
} from './src/utils/csvEngine';

describe('SN - Leituras • Motor de Consumo, Tarifas R$, CSV, Cursores e Regras Firestore', () => {
  it('inicia novo ciclo sem tarifa cadastrada (null) e exibe motivo Sem tarifa configurada', () => {
    expect(DEFAULT_ALERT_LIMITS.waterTariffPerM3).toBeNull();
    expect(DEFAULT_ALERT_LIMITS.gasTariffPerM3).toBeNull();

    const evalWithoutTariff = evaluateReading({
      service: 'gas',
      previousValue: 266.007,
      currentValue: 266.844,
      limits: DEFAULT_ALERT_LIMITS,
    });

    expect(evalWithoutTariff.consumption).toBe(0.837);
    expect(evalWithoutTariff.appliedTariff).toBeNull();
    expect(evalWithoutTariff.calculatedAmountBrl).toBeNull();
    expect(evalWithoutTariff.amountUnavailableReason).toBe(
      'Sem tarifa configurada'
    );
  });

  it('valida o caso homologado Bloco 1, Apto 303, Gás: 266.8440 - 266.0070 = 0.8370 m³ e cálculo em R$', () => {
    const anterior = parseDecimalInput('266,0070');
    const atual = parseDecimalInput('266.8440');
    expect(anterior).toBe(266.007);
    expect(atual).toBe(266.844);

    const consumo = computeExactConsumption(atual, anterior);
    expect(consumo).toBe(0.837);
    expect(formatDecimal4(consumo, false)).toBe('0.8370');
    expect(formatDecimal4(consumo, true)).toBe('0,8370');

    const limitsWithGasTariff: AlertLimitsConfig = {
      ...DEFAULT_ALERT_LIMITS,
      waterTariffPerM3: 6.5,
      gasTariffPerM3: 32.8,
    };

    const evalRes = evaluateReading({
      service: 'gas',
      previousValue: anterior,
      currentValue: atual,
      limits: limitsWithGasTariff,
    });
    expect(evalRes.consumption).toBe(0.837);
    expect(evalRes.appliedTariff).toBe(32.8);
    // 0.8370 * 32.80 = 27.4536 -> rounded to 27.45
    expect(evalRes.calculatedAmountBrl).toBe(27.45);
    expect(evalRes.amountUnavailableReason).toBeNull();
    expect(formatCurrencyBrl(evalRes.calculatedAmountBrl)).toBe('R$ 27,45');
    expect(formatTariffBrl(evalRes.appliedTariff)).toBe('R$ 32,80/m³');
    expect(evalRes.status).toBe('read');
    expect(evalRes.alerts).toEqual([]);
  });

  it('classifica leitura menor que anterior, consumo elevado, teto crítico, ruído de gás, sem referência anterior e troca de medidor (com motivos de R$ indisponível)', () => {
    const configuredLimits: AlertLimitsConfig = {
      ...DEFAULT_ALERT_LIMITS,
      waterTariffPerM3: 6.5,
      gasTariffPerM3: 32.8,
    };

    // 1. Leitura menor que a anterior (negativa) -> valor R$ indisponível
    const neg = evaluateReading({
      service: 'gas',
      previousValue: 266.007,
      currentValue: 265.5,
      limits: configuredLimits,
    });
    expect(neg.consumption).toBe(-0.507);
    expect(neg.status).toBe('alert');
    expect(neg.alerts).toContain('NEGATIVE_CONSUMPTION');
    expect(neg.requiresSecondPhoto).toBe(true);
    expect(neg.requiresJustification).toBe(true);
    expect(neg.calculatedAmountBrl).toBeNull();
    expect(neg.amountUnavailableReason).toBe('Consumo negativo (em revisão)');

    // 2. Consumo elevado Gás (> 15 m³ e <= 50 m³) -> calcula valor em R$ normalmente e exige 2ª foto
    const highGas = evaluateReading({
      service: 'gas',
      previousValue: 100.0,
      currentValue: 118.25,
      limits: configuredLimits,
    });
    expect(highGas.consumption).toBe(18.25);
    expect(highGas.status).toBe('alert');
    expect(highGas.alerts).toContain('HIGH_CONSUMPTION');
    expect(highGas.requiresSecondPhoto).toBe(true);
    expect(highGas.calculatedAmountBrl).toBe(598.6); // 18.25 * 32.8 = 598.60

    // 3. Teto crítico Água (> 100 m³)
    const ceilingWater = evaluateReading({
      service: 'water',
      previousValue: 200.0,
      currentValue: 315.0,
      limits: configuredLimits,
    });
    expect(ceilingWater.consumption).toBe(115.0);
    expect(ceilingWater.status).toBe('alert');
    expect(ceilingWater.alerts).toContain('CEILING_EXCEEDED');
    expect(ceilingWater.calculatedAmountBrl).toBe(747.5); // 115 * 6.5 = 747.50

    // 4. Ruído de Gás (<= 0,5 m³)
    const noiseGas = evaluateReading({
      service: 'gas',
      previousValue: 50.0,
      currentValue: 50.35,
      limits: configuredLimits,
    });
    expect(noiseGas.consumption).toBe(0.35);
    expect(noiseGas.alerts).toContain('GAS_NOISE');
    expect(noiseGas.status).toBe('read');
    expect(noiseGas.calculatedAmountBrl).toBe(11.48); // 0.35 * 32.8 = 11.48

    // 5. Troca de medidor exclui consumo e valor R$ distorcido dos totais
    const replaced = evaluateReading({
      service: 'water',
      previousValue: 450.1234,
      currentValue: 2.5,
      limits: configuredLimits,
      exceptionType: 'meter_replaced',
    });
    expect(replaced.excludeFromTotals).toBe(true);
    expect(replaced.consumption).toBeNull();
    expect(replaced.calculatedAmountBrl).toBeNull();
    expect(replaced.amountUnavailableReason).toBe(
      'Troca de medidor (consumo excluído)'
    );
    expect(replaced.alerts).toContain('METER_REPLACED');
    expect(replaced.requiresSecondPhoto).toBe(true);

    // 6. Sem leitura anterior -> valor R$ indisponível com motivo explícito
    const missingPrev = evaluateReading({
      service: 'water',
      previousValue: null,
      currentValue: 14.2,
      limits: configuredLimits,
    });
    expect(missingPrev.consumption).toBeNull();
    expect(missingPrev.calculatedAmountBrl).toBeNull();
    expect(missingPrev.amountUnavailableReason).toBe('Sem leitura anterior');
  });

  it('preserva os valores auditados (appliedTariff e calculatedAmountBrl) de leituras já salvas quando a tarifa do ciclo muda', () => {
    const savedReading: ReadingRecord = {
      id: buildUnitKey('2026-11', 'water', 1, '101'),
      condominiumId: 'campos-do-sul',
      cycleId: '2026-11',
      service: 'water',
      tower: 1,
      apartment: '101',
      previousValue: 100.0,
      currentValue: 110.0,
      consumption: 10.0,
      appliedTariff: 6.5, // Tarifa original na coleta: R$ 6,5000/m³
      calculatedAmountBrl: 65.0, // Valor auditado na coleta: R$ 65,00
      amountUnavailableReason: null,
      referenceSource: 'configured_limits',
      status: 'read',
      alerts: [],
      exceptionType: 'none',
      observation: '',
      photo1Id: 'p1',
      photo2Id: null,
      auditCode1: 'SN-T01-101-AF1',
      auditCode2: '',
      syncStatus: 'local_only',
      revision: 1,
      revisionToken: 'rv_1',
      baseRevisionToken: '',
      createdByUid: 'u1',
      createdByName: 'Leiturista 1',
      createdAt: '2026-11-10T10:00:00.000Z',
      updatedByUid: 'u1',
      updatedByName: 'Leiturista 1',
      updatedAt: '2026-11-10T10:00:00.000Z',
    };

    // Mesmo que a tarifa do ciclo suba depois para R$ 8,00/m³, a leitura salva preserva R$ 6,50/m³ e R$ 65,00
    const auditedFin = getAuditedReadingFinancials(savedReading, 8.0);
    expect(auditedFin.appliedTariff).toBe(6.5);
    expect(auditedFin.calculatedAmountBrl).toBe(65.0);
    expect(auditedFin.amountUnavailableReason).toBeNull();

    // Quando o gestor aciona explicitamente o recálculo com a nova tarifa (R$ 8,00/m³):
    const recalcFin = computeMonetaryAmountBrl({
      rawConsumption: savedReading.consumption,
      previousValue: savedReading.previousValue,
      currentValue: savedReading.currentValue,
      tariffPerM3: 8.0,
      exceptionType: savedReading.exceptionType,
    });
    expect(recalcFin.appliedTariff).toBe(8.0);
    expect(recalcFin.calculatedAmountBrl).toBe(80.0);
  });

  it('valida cenário integrado com 2 torres (01 e 02), ambos os serviços (Água e Gás), leituras normais e com alerta, e simetria entre Coleta, Foto, CSV e PDF', () => {
    const cycleId = '2026-11';
    const waterTariff = 6.5;
    const gasTariff = 32.8;
    const limits: AlertLimitsConfig = {
      ...DEFAULT_ALERT_LIMITS,
      waterTariffPerM3: waterTariff,
      gasTariffPerM3: gasTariff,
    };

    const scenarios = [
      // Torre 01 & Torre 02 - Água (normal + alerta consumo alto + troca de medidor)
      {
        service: 'water' as const,
        tower: 1,
        apartment: '101',
        prev: 100.0,
        curr: 112.5,
        exc: 'none' as const,
        expectedCons: 12.5,
        expectedBrl: 81.25, // 12.5 * 6.5
        expectedPhotos: 1,
      },
      {
        service: 'water' as const,
        tower: 1,
        apartment: '102',
        prev: 200.0,
        curr: 228.0,
        exc: 'confirmed_high' as const,
        expectedCons: 28.0,
        expectedBrl: 182.0, // 28.0 * 6.5
        expectedPhotos: 2,
      },
      {
        service: 'water' as const,
        tower: 2,
        apartment: '201',
        prev: 150.0,
        curr: 160.25,
        exc: 'none' as const,
        expectedCons: 10.25,
        expectedBrl: 66.63, // 10.25 * 6.5 = 66.625 -> 66.63
        expectedPhotos: 1,
      },
      {
        service: 'water' as const,
        tower: 2,
        apartment: '202',
        prev: 310.0,
        curr: 4.5,
        exc: 'meter_replaced' as const,
        expectedCons: null,
        expectedBrl: null,
        expectedPhotos: 2,
      },
      // Torre 01 & Torre 02 - Gás (normal + alerta consumo alto + alerta consumo negativo)
      {
        service: 'gas' as const,
        tower: 1,
        apartment: '303',
        prev: 266.007,
        curr: 266.844,
        exc: 'none' as const,
        expectedCons: 0.837,
        expectedBrl: 27.45, // 0.837 * 32.8 = 27.4536 -> 27.45
        expectedPhotos: 1,
      },
      {
        service: 'gas' as const,
        tower: 1,
        apartment: '304',
        prev: 110.0,
        curr: 128.5,
        exc: 'confirmed_high' as const,
        expectedCons: 18.5,
        expectedBrl: 606.8, // 18.5 * 32.8 = 606.80
        expectedPhotos: 2,
      },
      {
        service: 'gas' as const,
        tower: 2,
        apartment: '101',
        prev: 85.0,
        curr: 86.2,
        exc: 'none' as const,
        expectedCons: 1.2,
        expectedBrl: 39.36, // 1.2 * 32.8 = 39.36
        expectedPhotos: 1,
      },
      {
        service: 'gas' as const,
        tower: 2,
        apartment: '102',
        prev: 92.0,
        curr: 91.2,
        exc: 'confirmed_negative' as const,
        expectedCons: -0.8,
        expectedBrl: null,
        expectedPhotos: 2,
      },
    ];

    const waterRefs = new Map<string, ReferenceRecord>();
    const waterReadings = new Map<string, ReadingRecord>();
    const gasRefs = new Map<string, ReferenceRecord>();
    const gasReadings = new Map<string, ReadingRecord>();

    for (const s of scenarios) {
      const evalRes = evaluateReading({
        service: s.service,
        previousValue: s.prev,
        currentValue: s.curr,
        limits,
        exceptionType: s.exc,
      });

      expect(evalRes.consumption).toBe(s.expectedCons);
      expect(evalRes.calculatedAmountBrl).toBe(s.expectedBrl);
      expect(evalRes.requiresSecondPhoto).toBe(s.expectedPhotos === 2);

      const unitId = buildUnitKey(cycleId, s.service, s.tower, s.apartment);
      const refRec: ReferenceRecord = {
        id: unitId,
        cycleId,
        service: s.service,
        tower: s.tower,
        apartment: s.apartment,
        previousValue: s.prev,
        sourceFile: 'homologacao.csv',
        importedAt: '2026-11-18T10:00:00.000Z',
        importedByUid: 'u1',
        importedByName: 'Leiturista 1',
      };
      const readRec: ReadingRecord = {
        id: unitId,
        condominiumId: 'campos-do-sul',
        cycleId,
        service: s.service,
        tower: s.tower,
        apartment: s.apartment,
        previousValue: s.prev,
        currentValue: s.curr,
        consumption: evalRes.consumption,
        appliedTariff: evalRes.appliedTariff,
        calculatedAmountBrl: evalRes.calculatedAmountBrl,
        amountUnavailableReason: evalRes.amountUnavailableReason,
        referenceSource: evalRes.referenceSource,
        status: evalRes.status,
        alerts: evalRes.alerts,
        exceptionType: s.exc,
        observation: 'Homologação 2 torres',
        photo1Id: `${unitId}_slot_1`,
        photo2Id: s.expectedPhotos === 2 ? `${unitId}_slot_2` : null,
        auditCode1: `SN-T0${s.tower}-${s.apartment}-F1`,
        auditCode2:
          s.expectedPhotos === 2 ? `SN-T0${s.tower}-${s.apartment}-F2` : '',
        syncStatus: 'local_only',
        revision: 1,
        revisionToken: 'rv_1',
        baseRevisionToken: '',
        createdByUid: 'u1',
        createdByName: 'Leiturista 1',
        createdAt: '2026-11-18T10:05:00.000Z',
        updatedByUid: 'u1',
        updatedByName: 'Leiturista 1',
        updatedAt: '2026-11-18T10:05:00.000Z',
      };

      if (s.service === 'water') {
        waterRefs.set(unitId, refRec);
        waterReadings.set(unitId, readRec);
      } else {
        gasRefs.set(unitId, refRec);
        gasReadings.set(unitId, readRec);
      }
    }

    const waterCsv = buildExportCsv({
      cycleId,
      service: 'water',
      towers: [1, 2],
      referencesMap: waterRefs,
      readingsMap: waterReadings,
      fallbackTariffPerM3: waterTariff,
    });
    const gasCsv = buildExportCsv({
      cycleId,
      service: 'gas',
      towers: [1, 2],
      referencesMap: gasRefs,
      readingsMap: gasReadings,
      fallbackTariffPerM3: gasTariff,
    });

    expect(waterCsv.replace(/^\uFEFF/, '').startsWith(EXPORT_CSV_HEADER)).toBe(
      true
    );
    expect(gasCsv.replace(/^\uFEFF/, '').startsWith(EXPORT_CSV_HEADER)).toBe(
      true
    );

    // Conferir simetria entre avaliação da coleta, CSV e dados do PDF para cada cenário
    for (const s of scenarios) {
      const csvText = (s.service === 'water' ? waterCsv : gasCsv).replace(
        /^\uFEFF/,
        ''
      );
      const serviceLabel = s.service === 'water' ? 'Agua' : 'Gas';
      const line = csvText
        .split('\n')
        .find((l) =>
          l.startsWith(`${cycleId};${serviceLabel};${s.tower};${s.apartment};`)
        );
      expect(line).toBeDefined();
      const cols = line!.split(';');
      // Col 5: Atual, Col 6: Consumo, Col 7: Tarifa_R$_m3, Col 8: Valor_R$, Col 9: Motivo_Valor_R$
      expect(cols[5]).toBe(formatDecimal4(s.curr, true));
      expect(cols[6]).toBe(
        s.expectedCons !== null ? formatDecimal4(s.expectedCons, true) : ''
      );
      expect(cols[7]).toBe(
        formatTariffBrl(
          s.service === 'water' ? waterTariff : gasTariff,
          false,
          true
        )
      );
      expect(cols[8]).toBe(
        s.expectedBrl !== null
          ? formatCurrencyBrl(s.expectedBrl, false, true)
          : ''
      );
    }
  });

  it('importa CSV UTF-8 com e sem BOM, transforma Atual em Anterior e calcula impacto (m³ e R$) na reimportação', () => {
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

    // Simular reimportação com leitura já coletada no Bloco 1, Apto 303 com tarifa de R$ 32,80/m³
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
      appliedTariff: 32.8,
      calculatedAmountBrl: 27.45,
      amountUnavailableReason: null,
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
      limits: {
        ...DEFAULT_ALERT_LIMITS,
        gasTariffPerM3: 32.8,
      },
    });

    expect(preview2.isReimport).toBe(true);
    expect(preview2.impactedSavedReadings.length).toBe(1);
    const imp = preview2.impactedSavedReadings[0];
    expect(imp.currentReadingValue).toBe(266.844);
    expect(imp.oldConsumption).toBe(0.837);
    expect(imp.newConsumption).toBe(16.844);
    expect(imp.oldAmountBrl).toBe(27.45);
    expect(imp.newAmountBrl).toBe(552.48); // 16.844 * 32.8 = 552.4832 -> 552.48
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

  it('verifica as regras endurecidas do Firestore (Dirty Dozen invariants, tarifas, valores R$, lista fixa de 2 UIDs e revisão sem leitura prévia)', () => {
    const rulesPath = path.resolve(__dirname, 'firestore.rules');
    const rulesText = fs.readFileSync(rulesPath, 'utf-8');

    // 1. Default deny catch-all
    expect(rulesText).toContain('match /{document=**}');
    expect(rulesText).toContain('allow read, write: if false;');

    // 2. Fixed 2-UID allowlist directly on request.auth.uid without extra collection read
    expect(rulesText).toContain(
      "request.auth.uid in ['Gs87xj1DKRg0RrnOXVnCuZAEeW63', 'UID_LEITURISTA_2']"
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

    // 7. Tariff and audited monetary snapshot validation in CycleSettings and MeterReading
    expect(rulesText).toContain('data.hasWaterTariff is bool');
    expect(rulesText).toContain('data.hasGasTariff is bool');
    expect(rulesText).toContain('data.hasAppliedTariff is bool');
    expect(rulesText).toContain('data.hasCalculatedAmountBrl is bool');
    expect(rulesText).toContain('data.amountUnavailableReason.size() <= 120');
  });
});
