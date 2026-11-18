export type ServiceType = 'water' | 'gas';
export type OperatingMode = 'real' | 'training';
export type CollectionOrderMode = 'sequential' | 'physical';

export type AlertCode =
  | 'NO_PREVIOUS_READING'
  | 'NEGATIVE_CONSUMPTION'
  | 'HIGH_CONSUMPTION'
  | 'CEILING_EXCEEDED'
  | 'GAS_NOISE'
  | 'METER_REPLACED';

export type ExceptionType =
  | 'none'
  | 'confirmed_high'
  | 'confirmed_negative'
  | 'meter_replaced';

export type SyncStatus = 'local_only' | 'synced' | 'conflict';

export type ReferenceSourceType = 'configured_limits' | 'historical';

/**
 * Full server cursor persisted in IndexedDB without reducing to milliseconds.
 */
export interface ServerCursor {
  seconds: number;
  nanoseconds: number;
  docId: string;
}

export interface CycleCursors {
  settings?: ServerCursor;
  references?: ServerCursor;
  readings?: ServerCursor;
}

export interface AlertLimitsConfig {
  waterAlertLimit: number;          // default 22 m³
  waterCeilingLimit: number;        // default 100 m³
  gasAlertLimit: number;            // default 15 m³
  gasCeilingLimit: number;          // default 50 m³
  gasNoiseLimit: number;            // default 0.5 m³
  waterTariffPerM3: number | null;  // starts null in a new cycle (requires configuration in Gestão)
  gasTariffPerM3: number | null;    // starts null in a new cycle (requires configuration in Gestão)
}

export interface CycleSettingsRecord extends AlertLimitsConfig {
  id: string; // cycleId (e.g., "2026-11")
  condominiumId: 'campos-do-sul';
  cycleId: string;
  /** Keyed by tower code "T01".."T28", array of 20 apartment numbers */
  physicalOrders: Record<string, string[]>;
  revision: number;
  revisionToken: string;
  baseRevisionToken: string;
  updatedByUid: string;
  updatedByName: string;
  updatedAt: string;
  serverUpdatedAt?: { seconds: number; nanoseconds: number };
  cursors: CycleCursors;
  syncStatus: SyncStatus;
}

export interface ReferenceRecord {
  id: string; // `${cycleId}_${service}_T${tower}_A${apartment}`
  cycleId: string;
  service: ServiceType;
  tower: number; // 1..28
  apartment: string; // "101".."504"
  previousValue: number | null;
  sourceFile: string;
  importedAt: string;
  importedByUid: string;
  importedByName: string;
}

export interface TowerReferenceSyncMeta {
  id: string; // `${cycleId}_${service}_T${tower}`
  cycleId: string;
  service: ServiceType;
  tower: number;
  sourceFile: string;
  revision: number;
  revisionToken: string;
  baseRevisionToken: string;
  importedByUid: string;
  importedByName: string;
  importedAt: string;
  serverUpdatedAt?: { seconds: number; nanoseconds: number };
  syncStatus: SyncStatus;
}

export interface ConflictReadingVersion {
  source: 'local' | 'remote';
  previousValue: number | null;
  currentValue: number;
  consumption: number | null;
  appliedTariff: number | null;
  calculatedAmountBrl: number | null;
  amountUnavailableReason: string | null;
  status: 'read' | 'alert';
  alerts: AlertCode[];
  exceptionType: ExceptionType;
  observation: string;
  auditCode1: string;
  auditCode2: string;
  photo1Id: string | null;
  photo2Id: string | null;
  revision: number;
  revisionToken: string;
  baseRevisionToken: string;
  createdByUid: string;
  createdByName: string;
  createdAt: string;
  updatedByUid: string;
  updatedByName: string;
  updatedAt: string;
}

export interface ReadingRecord {
  id: string; // `${cycleId}_${service}_T${tower}_A${apartment}`
  condominiumId: 'campos-do-sul';
  cycleId: string;
  service: ServiceType;
  tower: number; // 1..28
  apartment: string; // "101".."504"
  previousValue: number | null;
  currentValue: number;
  consumption: number | null;
  /** Audited snapshot of the tariff (R$/m³) applied when the reading was saved/recalculated */
  appliedTariff: number | null;
  /** Audited snapshot of the calculated monetary amount in BRL (R$) rounded to 2 decimal places */
  calculatedAmountBrl: number | null;
  /** Explicit reason when calculatedAmountBrl is null (e.g. "Sem tarifa configurada", "Sem leitura anterior", "Troca de medidor (consumo excluído)", "Consumo negativo (em revisão)") */
  amountUnavailableReason: string | null;
  referenceSource: ReferenceSourceType;
  status: 'read' | 'alert';
  alerts: AlertCode[];
  exceptionType: ExceptionType;
  observation: string;
  photo1Id: string | null;
  photo2Id: string | null;
  auditCode1: string;
  auditCode2: string;
  syncStatus: SyncStatus;
  revision: number;
  revisionToken: string;
  baseRevisionToken: string;
  createdByUid: string;
  createdByName: string;
  createdAt: string;
  updatedByUid: string;
  updatedByName: string;
  updatedAt: string;
  serverUpdatedAt?: { seconds: number; nanoseconds: number };
  /** Populated when a concurrent offline edit collides with a synced remote record */
  conflictCandidate?: ConflictReadingVersion;
}

export type PhotoSlot = '1' | '2' | 'conflict_1' | 'conflict_2';

export interface PhotoRecord {
  id: string; // `${readingId}_slot_${slot}`
  readingId: string;
  slot: PhotoSlot;
  stampedBlob: Blob;
  rawBlob?: Blob;
  fileName: string;
  mimeType: 'image/jpeg';
  sizeBytes: number;
  width: number;
  height: number;
  auditCode: string;
  stampedValue: number;
  stampedTariff?: number | null;
  stampedAmountBrl?: number | null;
  capturedAt: string;
}

export interface DraftRecord {
  unitKey: string; // `${cycleId}_${service}_T${tower}_A${apartment}`
  cycleId: string;
  service: ServiceType;
  tower: number;
  apartment: string;
  currentValueInput: string;
  observation: string;
  exceptionType: ExceptionType;
  rawPhoto1?: Blob;
  stampedPhoto1?: Blob;
  auditCode1?: string;
  stampedValue1?: number;
  capturedAt1?: string;
  rawPhoto2?: Blob;
  stampedPhoto2?: Blob;
  auditCode2?: string;
  stampedValue2?: number;
  capturedAt2?: string;
  updatedAt: string;
}

export interface SyncQueueItem {
  id: string; // `${targetCollection}__${docId}`
  targetCollection: 'readings' | 'references' | 'settings';
  docId: string;
  cycleId: string;
  expectedOperation: 'create' | 'update';
  revision: number;
  baseRevisionToken: string;
  attempts: number;
  lastError?: string;
  queuedAt: string;
}

export interface TowerProgressSummary {
  tower: number;
  totalUnits: number; // 20
  readCount: number;
  alertCount: number;
  localOnlyCount: number;
  syncedCount: number;
  conflictCount: number;
  hasReferencesCount: number;
}

export const CONDOMINIUM_NAME = 'Residencial Campos do Sul';
export const CONDOMINIUM_ID = 'campos-do-sul' as const;
export const TOTAL_TOWERS = 28;
export const APARTMENTS_PER_TOWER = 20;
export const TOTAL_UNITS_PER_SERVICE = TOTAL_TOWERS * APARTMENTS_PER_TOWER; // 560

export const SEQUENTIAL_APARTMENTS: readonly string[] = [
  '101', '102', '103', '104',
  '201', '202', '203', '204',
  '301', '302', '303', '304',
  '401', '402', '403', '404',
  '501', '502', '503', '504',
];

export const DEFAULT_ALERT_LIMITS: AlertLimitsConfig = {
  waterAlertLimit: 22,
  waterCeilingLimit: 100,
  gasAlertLimit: 15,
  gasCeilingLimit: 50,
  gasNoiseLimit: 0.5,
  waterTariffPerM3: null,
  gasTariffPerM3: null,
};

export function formatTowerCode(tower: number): string {
  return `T${String(tower).padStart(2, '0')}`;
}

export function formatTowerNumber(tower: number): string {
  return String(tower).padStart(2, '0');
}

export function buildUnitKey(
  cycleId: string,
  service: ServiceType,
  tower: number,
  apartment: string
): string {
  return `${cycleId}_${service}_${formatTowerCode(tower)}_A${apartment}`;
}

export function buildTowerRefDocId(
  cycleId: string,
  service: ServiceType,
  tower: number
): string {
  return `${cycleId}_${service}_${formatTowerCode(tower)}`;
}

export function generateRevisionToken(uid: string): string {
  const rand = Math.random().toString(36).substring(2, 10);
  const ts = Date.now().toString(36);
  const cleanUid = (uid || 'local').replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
  return `rv_${cleanUid}_${ts}_${rand}`;
}
