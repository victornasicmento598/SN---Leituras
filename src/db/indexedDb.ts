import {
  APARTMENTS_PER_TOWER,
  AlertLimitsConfig,
  CONDOMINIUM_ID,
  CycleCursors,
  CycleSettingsRecord,
  DEFAULT_ALERT_LIMITS,
  DraftRecord,
  ExceptionType,
  OperatingMode,
  PhotoRecord,
  PhotoSlot,
  ReadingRecord,
  ReferenceRecord,
  SEQUENTIAL_APARTMENTS,
  ServerCursor,
  ServiceType,
  SyncQueueItem,
  TOTAL_TOWERS,
  TowerProgressSummary,
  TowerReferenceSyncMeta,
  buildTowerRefDocId,
  buildUnitKey,
  generateRevisionToken,
} from '../types/domain';
import { evaluateReading } from '../utils/consumptionEngine';
import { ParsedCsvRow } from '../utils/csvEngine';
import {
  createSimulatedMeterRawBlob,
  stampMeterPhoto,
} from '../utils/photoStampEngine';

const PROD_DB_NAME = 'sn_leituras_prod_db';
const TRAINING_DB_NAME = 'sn_leituras_training_db';
const DB_VERSION = 1;

const dbPromises = new Map<string, Promise<IDBDatabase>>();

function getDbName(mode: OperatingMode): string {
  return mode === 'training' ? TRAINING_DB_NAME : PROD_DB_NAME;
}

export function openLocalDatabase(mode: OperatingMode): Promise<IDBDatabase> {
  const dbName = getDbName(mode);
  const existing = dbPromises.get(dbName);
  if (existing) return existing;

  const promise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(dbName, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains('references')) {
        const refStore = db.createObjectStore('references', { keyPath: 'id' });
        refStore.createIndex('by_cycle_service', ['cycleId', 'service'], {
          unique: false,
        });
      }

      if (!db.objectStoreNames.contains('towerRefMeta')) {
        const metaStore = db.createObjectStore('towerRefMeta', { keyPath: 'id' });
        metaStore.createIndex('by_cycle', 'cycleId', { unique: false });
      }

      if (!db.objectStoreNames.contains('readings')) {
        const readStore = db.createObjectStore('readings', { keyPath: 'id' });
        readStore.createIndex('by_cycle_service', ['cycleId', 'service'], {
          unique: false,
        });
      }

      if (!db.objectStoreNames.contains('photos')) {
        const photoStore = db.createObjectStore('photos', { keyPath: 'id' });
        photoStore.createIndex('by_reading', 'readingId', { unique: false });
      }

      if (!db.objectStoreNames.contains('drafts')) {
        db.createObjectStore('drafts', { keyPath: 'unitKey' });
      }

      if (!db.objectStoreNames.contains('syncQueue')) {
        const queueStore = db.createObjectStore('syncQueue', { keyPath: 'id' });
        queueStore.createIndex('by_cycle', 'cycleId', { unique: false });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      dbPromises.delete(dbName);
      reject(req.error);
    };
  });

  dbPromises.set(dbName, promise);
  return promise;
}

function idbReq<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbTxDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Transação IndexedDB abortada.'));
  });
}

export async function getOrInitCycleSettings(
  mode: OperatingMode,
  cycleId: string
): Promise<CycleSettingsRecord> {
  const db = await openLocalDatabase(mode);
  const tx = db.transaction('settings', 'readwrite');
  const store = tx.objectStore('settings');
  const existing = await idbReq<CycleSettingsRecord | undefined>(store.get(cycleId));
  if (existing) {
    return existing;
  }

  const initial: CycleSettingsRecord = {
    id: cycleId,
    condominiumId: CONDOMINIUM_ID,
    cycleId,
    ...DEFAULT_ALERT_LIMITS,
    physicalOrders: {},
    revision: 0,
    revisionToken: '',
    baseRevisionToken: '',
    updatedByUid: 'local',
    updatedByName: 'Piloto Local',
    updatedAt: new Date().toISOString(),
    cursors: {},
    syncStatus: 'local_only',
  };

  store.put(initial);
  await idbTxDone(tx);
  return initial;
}

export async function updateCycleSettingsAtomically(params: {
  mode: OperatingMode;
  cycleId: string;
  updater: (prev: CycleSettingsRecord) => Partial<CycleSettingsRecord>;
  authorUid: string;
  authorName: string;
  enqueueSync?: boolean;
}): Promise<CycleSettingsRecord> {
  const db = await openLocalDatabase(params.mode);
  const current = await getOrInitCycleSettings(params.mode, params.cycleId);
  const patch = params.updater(current);
  const nowIso = new Date().toISOString();

  const isFirstWrite = current.revision === 0;
  const nextRevision = isFirstWrite ? 1 : current.revision + 1;
  const nextBaseToken = isFirstWrite ? '' : current.revisionToken;
  const nextToken = generateRevisionToken(params.authorUid);

  const updated: CycleSettingsRecord = {
    ...current,
    ...patch,
    revision: params.enqueueSync ? nextRevision : current.revision,
    revisionToken: params.enqueueSync ? nextToken : current.revisionToken,
    baseRevisionToken: params.enqueueSync ? nextBaseToken : current.baseRevisionToken,
    updatedByUid: params.authorUid || current.updatedByUid,
    updatedByName: params.authorName || current.updatedByName,
    updatedAt: nowIso,
    syncStatus: params.enqueueSync ? 'local_only' : current.syncStatus,
  };

  const tx = db.transaction(['settings', 'syncQueue'], 'readwrite');
  tx.objectStore('settings').put(updated);

  if (params.enqueueSync && params.mode === 'real') {
    const queueId = `settings__config`;
    const existingQueue = await idbReq<SyncQueueItem | undefined>(
      tx.objectStore('syncQueue').get(queueId)
    );
    const expectedOp: 'create' | 'update' =
      existingQueue?.expectedOperation === 'create' || isFirstWrite
        ? 'create'
        : 'update';
    const baseToken =
      expectedOp === 'create'
        ? ''
        : existingQueue
        ? existingQueue.baseRevisionToken
        : nextBaseToken;
    const revToSend =
      expectedOp === 'create'
        ? 1
        : existingQueue
        ? existingQueue.revision
        : nextRevision;

    updated.revision = revToSend;
    updated.baseRevisionToken = baseToken;
    tx.objectStore('settings').put(updated);

    const queueItem: SyncQueueItem = {
      id: queueId,
      targetCollection: 'settings',
      docId: 'config',
      cycleId: params.cycleId,
      expectedOperation: expectedOp,
      revision: revToSend,
      baseRevisionToken: baseToken,
      attempts: 0,
      queuedAt: nowIso,
    };
    tx.objectStore('syncQueue').put(queueItem);
  }

  await idbTxDone(tx);
  return updated;
}

export async function saveCycleCursor(
  mode: OperatingMode,
  cycleId: string,
  collectionKey: keyof CycleCursors,
  cursor: ServerCursor
): Promise<CycleSettingsRecord> {
  const db = await openLocalDatabase(mode);
  const current = await getOrInitCycleSettings(mode, cycleId);
  const updated: CycleSettingsRecord = {
    ...current,
    cursors: {
      ...current.cursors,
      [collectionKey]: {
        seconds: cursor.seconds,
        nanoseconds: cursor.nanoseconds,
        docId: cursor.docId,
      },
    },
  };
  const tx = db.transaction('settings', 'readwrite');
  tx.objectStore('settings').put(updated);
  await idbTxDone(tx);
  return updated;
}

export async function getReferencesForCycleService(
  mode: OperatingMode,
  cycleId: string,
  service: ServiceType
): Promise<Map<string, ReferenceRecord>> {
  const db = await openLocalDatabase(mode);
  const tx = db.transaction('references', 'readonly');
  const idx = tx.objectStore('references').index('by_cycle_service');
  const list = await idbReq<ReferenceRecord[]>(
    idx.getAll(IDBKeyRange.only([cycleId, service]))
  );
  const map = new Map<string, ReferenceRecord>();
  for (const item of list) {
    map.set(item.id, item);
  }
  return map;
}

export async function getReadingsForCycleService(
  mode: OperatingMode,
  cycleId: string,
  service: ServiceType
): Promise<Map<string, ReadingRecord>> {
  const db = await openLocalDatabase(mode);
  const tx = db.transaction('readings', 'readonly');
  const idx = tx.objectStore('readings').index('by_cycle_service');
  const list = await idbReq<ReadingRecord[]>(
    idx.getAll(IDBKeyRange.only([cycleId, service]))
  );
  const map = new Map<string, ReadingRecord>();
  for (const item of list) {
    map.set(item.id, item);
  }
  return map;
}

export async function getSyncQueueForCycle(
  mode: OperatingMode,
  cycleId: string
): Promise<SyncQueueItem[]> {
  const db = await openLocalDatabase(mode);
  const tx = db.transaction('syncQueue', 'readonly');
  const idx = tx.objectStore('syncQueue').index('by_cycle');
  const items = await idbReq<SyncQueueItem[]>(
    idx.getAll(IDBKeyRange.only(cycleId))
  );
  return items.sort((a, b) => a.queuedAt.localeCompare(b.queuedAt));
}

export async function getDraftByUnitKey(
  mode: OperatingMode,
  unitKey: string
): Promise<DraftRecord | null> {
  const db = await openLocalDatabase(mode);
  const tx = db.transaction('drafts', 'readonly');
  const res = await idbReq<DraftRecord | undefined>(
    tx.objectStore('drafts').get(unitKey)
  );
  return res || null;
}

export async function getAllDraftsForCycle(
  mode: OperatingMode,
  cycleId: string
): Promise<DraftRecord[]> {
  const db = await openLocalDatabase(mode);
  const tx = db.transaction('drafts', 'readonly');
  const all = await idbReq<DraftRecord[]>(tx.objectStore('drafts').getAll());
  return all.filter((d) => d.cycleId === cycleId);
}

export async function saveDraftRecord(
  mode: OperatingMode,
  draft: DraftRecord
): Promise<void> {
  const db = await openLocalDatabase(mode);
  const tx = db.transaction('drafts', 'readwrite');
  tx.objectStore('drafts').put(draft);
  await idbTxDone(tx);
}

export async function deleteDraftRecord(
  mode: OperatingMode,
  unitKey: string
): Promise<void> {
  const db = await openLocalDatabase(mode);
  const tx = db.transaction('drafts', 'readwrite');
  tx.objectStore('drafts').delete(unitKey);
  await idbTxDone(tx);
}

export async function getPhotosForReading(
  mode: OperatingMode,
  readingId: string
): Promise<Map<PhotoSlot, PhotoRecord>> {
  const db = await openLocalDatabase(mode);
  const tx = db.transaction('photos', 'readonly');
  const idx = tx.objectStore('photos').index('by_reading');
  const list = await idbReq<PhotoRecord[]>(
    idx.getAll(IDBKeyRange.only(readingId))
  );
  const map = new Map<PhotoSlot, PhotoRecord>();
  for (const p of list) {
    map.set(p.slot, p);
  }
  return map;
}

/**
 * Atomically saves a reading, its stamped photos (slot 1 and optional slot 2),
 * enqueues the syncQueue item without any pre-read, and deletes the temporary draft.
 */
export async function saveReadingAtomically(params: {
  mode: OperatingMode;
  cycleId: string;
  service: ServiceType;
  tower: number;
  apartment: string;
  previousValue: number | null;
  currentValue: number;
  exceptionType: ExceptionType;
  observation: string;
  limits: AlertLimitsConfig;
  photo1: {
    stampedBlob: Blob;
    rawBlob?: Blob;
    auditCode: string;
    fileName: string;
    width: number;
    height: number;
    capturedAt: string;
  } | null;
  photo2: {
    stampedBlob: Blob;
    rawBlob?: Blob;
    auditCode: string;
    fileName: string;
    width: number;
    height: number;
    capturedAt: string;
  } | null;
  authorUid: string;
  authorName: string;
}): Promise<ReadingRecord> {
  const db = await openLocalDatabase(params.mode);
  const readingId = buildUnitKey(
    params.cycleId,
    params.service,
    params.tower,
    params.apartment
  );

  const evaluation = evaluateReading({
    service: params.service,
    previousValue: params.previousValue,
    currentValue: params.currentValue,
    limits: params.limits,
    exceptionType: params.exceptionType,
  });

  const tx = db.transaction(
    ['readings', 'photos', 'drafts', 'syncQueue'],
    'readwrite'
  );
  const readingsStore = tx.objectStore('readings');
  const photosStore = tx.objectStore('photos');
  const draftsStore = tx.objectStore('drafts');
  const queueStore = tx.objectStore('syncQueue');

  const existingReading = await idbReq<ReadingRecord | undefined>(
    readingsStore.get(readingId)
  );
  const queueId = `readings__${readingId}`;
  const existingQueue = await idbReq<SyncQueueItem | undefined>(
    queueStore.get(queueId)
  );

  const nowIso = new Date().toISOString();

  // Preserve original authorship on edits!
  const createdByUid = existingReading
    ? existingReading.createdByUid
    : params.authorUid;
  const createdByName = existingReading
    ? existingReading.createdByName
    : params.authorName;
  const createdAt = existingReading ? existingReading.createdAt : nowIso;

  // Determine revision and expectedOperation for Firestore rules enforcement:
  // If never synced yet (no existingReading or existingQueue is 'create'), stay on revision 1 + 'create'.
  // If previously synced (existingReading.syncStatus === 'synced' or had a server revision), increment revision by 1 + 'update'.
  let expectedOperation: 'create' | 'update' = 'create';
  let revision = 1;
  let baseRevisionToken = '';

  if (existingReading) {
    if (existingQueue) {
      expectedOperation = existingQueue.expectedOperation;
      revision = existingQueue.revision;
      baseRevisionToken = existingQueue.baseRevisionToken;
    } else if (existingReading.syncStatus === 'synced' || existingReading.serverUpdatedAt) {
      expectedOperation = 'update';
      revision = existingReading.revision + 1;
      baseRevisionToken = existingReading.revisionToken;
    } else {
      expectedOperation = 'create';
      revision = 1;
      baseRevisionToken = '';
    }
  }

  const revisionToken = generateRevisionToken(params.authorUid);

  let photo1Id: string | null = existingReading?.photo1Id || null;
  let auditCode1 = existingReading?.auditCode1 || '';
  if (params.photo1) {
    photo1Id = `${readingId}_slot_1`;
    auditCode1 = params.photo1.auditCode;
    const p1: PhotoRecord = {
      id: photo1Id,
      readingId,
      slot: '1',
      stampedBlob: params.photo1.stampedBlob,
      rawBlob: params.photo1.rawBlob,
      fileName: params.photo1.fileName,
      mimeType: 'image/jpeg',
      sizeBytes: params.photo1.stampedBlob.size,
      width: params.photo1.width,
      height: params.photo1.height,
      auditCode: params.photo1.auditCode,
      stampedValue: params.currentValue,
      capturedAt: params.photo1.capturedAt,
    };
    photosStore.put(p1);
  }

  let photo2Id: string | null = existingReading?.photo2Id || null;
  let auditCode2 = existingReading?.auditCode2 || '';
  if (params.photo2) {
    photo2Id = `${readingId}_slot_2`;
    auditCode2 = params.photo2.auditCode;
    const p2: PhotoRecord = {
      id: photo2Id,
      readingId,
      slot: '2',
      stampedBlob: params.photo2.stampedBlob,
      rawBlob: params.photo2.rawBlob,
      fileName: params.photo2.fileName,
      mimeType: 'image/jpeg',
      sizeBytes: params.photo2.stampedBlob.size,
      width: params.photo2.width,
      height: params.photo2.height,
      auditCode: params.photo2.auditCode,
      stampedValue: params.currentValue,
      capturedAt: params.photo2.capturedAt,
    };
    photosStore.put(p2);
  }

  const record: ReadingRecord = {
    id: readingId,
    condominiumId: CONDOMINIUM_ID,
    cycleId: params.cycleId,
    service: params.service,
    tower: params.tower,
    apartment: params.apartment,
    previousValue: params.previousValue,
    currentValue: params.currentValue,
    consumption: evaluation.consumption,
    referenceSource: evaluation.referenceSource,
    status: evaluation.status,
    alerts: evaluation.alerts,
    exceptionType: params.exceptionType,
    observation: params.observation.trim(),
    photo1Id,
    photo2Id,
    auditCode1,
    auditCode2,
    syncStatus: 'local_only',
    revision,
    revisionToken,
    baseRevisionToken,
    createdByUid,
    createdByName,
    createdAt,
    updatedByUid: params.authorUid,
    updatedByName: params.authorName,
    updatedAt: nowIso,
    serverUpdatedAt: existingReading?.serverUpdatedAt,
    conflictCandidate: undefined,
  };

  readingsStore.put(record);
  draftsStore.delete(readingId);

  // Clean up any old conflict photos if present
  photosStore.delete(`${readingId}_slot_conflict_1`);
  photosStore.delete(`${readingId}_slot_conflict_2`);

  if (params.mode === 'real') {
    const queueItem: SyncQueueItem = {
      id: queueId,
      targetCollection: 'readings',
      docId: readingId,
      cycleId: params.cycleId,
      expectedOperation,
      revision,
      baseRevisionToken,
      attempts: 0,
      queuedAt: nowIso,
    };
    queueStore.put(queueItem);
  }

  await idbTxDone(tx);
  return record;
}

/**
 * Applies a validated CSV import or re-import atomically:
 * - Saves all valid reference rows
 * - Preserves existing readings' currentValue, photos, dates, observation, and authorship
 * - Recalculates consumption & alerts for saved readings whose reference changed (when user confirmed)
 * - Enqueues affected towers in syncQueue so the second device receives the CSV import/re-import on 'Atualizar'
 */
export async function applyCsvImportAtomically(params: {
  mode: OperatingMode;
  cycleId: string;
  service: ServiceType;
  sourceFileName: string;
  validRows: ParsedCsvRow[];
  applyToImpactedReadings: boolean;
  limits: AlertLimitsConfig;
  authorUid: string;
  authorName: string;
}): Promise<{
  importedCount: number;
  updatedReadingsCount: number;
  queuedTowersCount: number;
}> {
  const db = await openLocalDatabase(params.mode);
  const nowIso = new Date().toISOString();

  const tx = db.transaction(
    ['references', 'towerRefMeta', 'readings', 'syncQueue'],
    'readwrite'
  );
  const refStore = tx.objectStore('references');
  const metaStore = tx.objectStore('towerRefMeta');
  const readStore = tx.objectStore('readings');
  const queueStore = tx.objectStore('syncQueue');

  let importedCount = 0;
  let updatedReadingsCount = 0;
  const changedTowers = new Set<number>();

  for (const row of params.validRows) {
    const unitId = buildUnitKey(
      params.cycleId,
      params.service,
      row.tower,
      row.apartment
    );
    const existingRef = await idbReq<ReferenceRecord | undefined>(
      refStore.get(unitId)
    );
    const existingReading = await idbReq<ReadingRecord | undefined>(
      readStore.get(unitId)
    );

    // If this unit has a saved reading and the reference changed, only apply if user confirmed impact
    if (
      existingReading &&
      existingReading.previousValue !== row.newPreviousValue &&
      !params.applyToImpactedReadings
    ) {
      continue;
    }

    const isChanged =
      !existingRef || existingRef.previousValue !== row.newPreviousValue;

    const refRecord: ReferenceRecord = {
      id: unitId,
      cycleId: params.cycleId,
      service: params.service,
      tower: row.tower,
      apartment: row.apartment,
      previousValue: row.newPreviousValue,
      sourceFile: params.sourceFileName,
      importedAt: nowIso,
      importedByUid: params.authorUid,
      importedByName: params.authorName,
    };

    refStore.put(refRecord);
    importedCount++;

    if (isChanged) {
      changedTowers.add(row.tower);
    }

    // If a reading already exists on this unit, preserve its value, photos, date, observation, and author,
    // and recalculate consumption and alert classification with the new reference!
    if (
      existingReading &&
      existingReading.previousValue !== row.newPreviousValue &&
      params.applyToImpactedReadings
    ) {
      const newEval = evaluateReading({
        service: params.service,
        previousValue: row.newPreviousValue,
        currentValue: existingReading.currentValue,
        limits: params.limits,
        exceptionType: existingReading.exceptionType,
      });

      const updatedReading: ReadingRecord = {
        ...existingReading,
        previousValue: row.newPreviousValue,
        consumption: newEval.consumption,
        status: newEval.status,
        alerts: newEval.alerts,
      };
      readStore.put(updatedReading);
      updatedReadingsCount++;
    }
  }

  // Update TowerReferenceSyncMeta and enqueue affected towers for delta sync
  for (const tower of changedTowers) {
    const towerDocId = buildTowerRefDocId(params.cycleId, params.service, tower);
    const existingMeta = await idbReq<TowerReferenceSyncMeta | undefined>(
      metaStore.get(towerDocId)
    );
    const queueId = `references__${towerDocId}`;
    const existingQueue = await idbReq<SyncQueueItem | undefined>(
      queueStore.get(queueId)
    );

    let expectedOperation: 'create' | 'update' = 'create';
    let revision = 1;
    let baseRevisionToken = '';

    if (existingMeta) {
      if (existingQueue) {
        expectedOperation = existingQueue.expectedOperation;
        revision = existingQueue.revision;
        baseRevisionToken = existingQueue.baseRevisionToken;
      } else if (existingMeta.syncStatus === 'synced' || existingMeta.serverUpdatedAt) {
        expectedOperation = 'update';
        revision = existingMeta.revision + 1;
        baseRevisionToken = existingMeta.revisionToken;
      }
    }

    const revisionToken = generateRevisionToken(params.authorUid);

    const meta: TowerReferenceSyncMeta = {
      id: towerDocId,
      cycleId: params.cycleId,
      service: params.service,
      tower,
      sourceFile: params.sourceFileName,
      revision,
      revisionToken,
      baseRevisionToken,
      importedByUid: params.authorUid,
      importedByName: params.authorName,
      importedAt: nowIso,
      serverUpdatedAt: existingMeta?.serverUpdatedAt,
      syncStatus: 'local_only',
    };
    metaStore.put(meta);

    if (params.mode === 'real') {
      const qItem: SyncQueueItem = {
        id: queueId,
        targetCollection: 'references',
        docId: towerDocId,
        cycleId: params.cycleId,
        expectedOperation,
        revision,
        baseRevisionToken,
        attempts: 0,
        queuedAt: nowIso,
      };
      queueStore.put(qItem);
    }
  }

  await idbTxDone(tx);
  return {
    importedCount,
    updatedReadingsCount,
    queuedTowersCount: changedTowers.size,
  };
}

/**
 * Resolves a dual-device conflict by choosing either the 'remote' (already synchronized)
 * version or promoting the 'local' attempt to a new revision (remote.revision + 1).
 */
export async function resolveReadingConflict(params: {
  mode: OperatingMode;
  readingId: string;
  chosenSource: 'remote' | 'local';
  authorUid: string;
  authorName: string;
}): Promise<ReadingRecord> {
  const db = await openLocalDatabase(params.mode);
  const tx = db.transaction(['readings', 'photos', 'syncQueue'], 'readwrite');
  const readStore = tx.objectStore('readings');
  const photoStore = tx.objectStore('photos');
  const queueStore = tx.objectStore('syncQueue');

  const reading = await idbReq<ReadingRecord | undefined>(
    readStore.get(params.readingId)
  );
  if (!reading || !reading.conflictCandidate) {
    throw new Error('Registro em conflito não encontrado.');
  }

  const candidate = reading.conflictCandidate;
  const nowIso = new Date().toISOString();

  if (params.chosenSource === 'remote') {
    // Keep remote version which is already in the primary fields of `reading`
    const resolved: ReadingRecord = {
      ...reading,
      syncStatus: 'synced',
      conflictCandidate: undefined,
    };
    readStore.put(resolved);
    photoStore.delete(`${params.readingId}_slot_conflict_1`);
    photoStore.delete(`${params.readingId}_slot_conflict_2`);
    queueStore.delete(`readings__${params.readingId}`);
    await idbTxDone(tx);
    return resolved;
  }

  // Promote local conflict candidate as an update on top of the remote revision!
  const c1 = await idbReq<PhotoRecord | undefined>(
    photoStore.get(`${params.readingId}_slot_conflict_1`)
  );
  const c2 = await idbReq<PhotoRecord | undefined>(
    photoStore.get(`${params.readingId}_slot_conflict_2`)
  );

  let photo1Id: string | null = null;
  if (c1) {
    photo1Id = `${params.readingId}_slot_1`;
    photoStore.put({
      ...c1,
      id: photo1Id,
      slot: '1',
    });
    photoStore.delete(`${params.readingId}_slot_conflict_1`);
  }

  let photo2Id: string | null = null;
  if (c2) {
    photo2Id = `${params.readingId}_slot_2`;
    photoStore.put({
      ...c2,
      id: photo2Id,
      slot: '2',
    });
    photoStore.delete(`${params.readingId}_slot_conflict_2`);
  } else {
    photoStore.delete(`${params.readingId}_slot_2`);
  }

  const nextRevision = reading.revision + 1;
  const baseRevisionToken = reading.revisionToken;
  const nextRevisionToken = generateRevisionToken(params.authorUid);

  const promoted: ReadingRecord = {
    ...reading,
    previousValue: candidate.previousValue,
    currentValue: candidate.currentValue,
    consumption: candidate.consumption,
    status: candidate.status,
    alerts: candidate.alerts,
    exceptionType: candidate.exceptionType,
    observation: candidate.observation,
    auditCode1: candidate.auditCode1,
    auditCode2: candidate.auditCode2,
    photo1Id,
    photo2Id,
    syncStatus: 'local_only',
    revision: nextRevision,
    revisionToken: nextRevisionToken,
    baseRevisionToken,
    updatedByUid: params.authorUid,
    updatedByName: params.authorName,
    updatedAt: nowIso,
    conflictCandidate: undefined,
  };

  readStore.put(promoted);

  if (params.mode === 'real') {
    const qItem: SyncQueueItem = {
      id: `readings__${params.readingId}`,
      targetCollection: 'readings',
      docId: params.readingId,
      cycleId: reading.cycleId,
      expectedOperation: 'update',
      revision: nextRevision,
      baseRevisionToken,
      attempts: 0,
      queuedAt: nowIso,
    };
    queueStore.put(qItem);
  }

  await idbTxDone(tx);
  return promoted;
}

/**
 * Computes lightweight per-tower progress indicators from local IndexedDB maps.
 */
export function computeTowersProgress(
  cycleId: string,
  service: ServiceType,
  referencesMap: Map<string, ReferenceRecord>,
  readingsMap: Map<string, ReadingRecord>
): TowerProgressSummary[] {
  const summaries: TowerProgressSummary[] = [];

  for (let tower = 1; tower <= TOTAL_TOWERS; tower++) {
    let readCount = 0;
    let alertCount = 0;
    let localOnlyCount = 0;
    let syncedCount = 0;
    let conflictCount = 0;
    let hasReferencesCount = 0;

    for (const apt of SEQUENTIAL_APARTMENTS) {
      const unitId = buildUnitKey(cycleId, service, tower, apt);
      const ref = referencesMap.get(unitId);
      if (ref && ref.previousValue !== null) {
        hasReferencesCount++;
      }

      const reading = readingsMap.get(unitId);
      if (reading) {
        readCount++;
        if (reading.status === 'alert') alertCount++;
        if (reading.syncStatus === 'local_only') localOnlyCount++;
        if (reading.syncStatus === 'synced') syncedCount++;
        if (reading.syncStatus === 'conflict') conflictCount++;
      }
    }

    summaries.push({
      tower,
      totalUnits: APARTMENTS_PER_TOWER,
      readCount,
      alertCount,
      localOnlyCount,
      syncedCount,
      conflictCount,
      hasReferencesCount,
    });
  }

  return summaries;
}

/**
 * Seeds isolated demo data ONLY inside the separate Training Mode database (`sn_leituras_training_db`).
 * Never touches the real local pilot database (`sn_leituras_prod_db`).
 */
export async function ensureTrainingDatabaseSeeded(
  cycleId: string
): Promise<void> {
  const existingRefs = await getReferencesForCycleService('training', cycleId, 'gas');
  if (existingRefs.size > 0) return;

  const settings = await getOrInitCycleSettings('training', cycleId);

  // Seed references for Tower 1 & Tower 2 in Training Mode
  const demoRowsGas: ParsedCsvRow[] = [];
  const demoRowsWater: ParsedCsvRow[] = [];

  for (let t = 1; t <= 3; t++) {
    for (let i = 0; i < SEQUENTIAL_APARTMENTS.length; i++) {
      const apt = SEQUENTIAL_APARTMENTS[i];
      const gasVal =
        t === 1 && apt === '303' ? 266.007 : 120 + t * 5 + i * 1.45;
      demoRowsGas.push({
        lineNumber: i + 2,
        tower: t,
        apartment: apt,
        pastPreviousValue: gasVal - 1.2,
        newPreviousValue: gasVal,
        rawLine: `${t};${apt};${gasVal - 1.2};${gasVal}`,
      });

      const waterVal = 240 + t * 10 + i * 3.2;
      demoRowsWater.push({
        lineNumber: i + 2,
        tower: t,
        apartment: apt,
        pastPreviousValue: waterVal - 8.5,
        newPreviousValue: waterVal,
        rawLine: `${t};${apt};${waterVal - 8.5};${waterVal}`,
      });
    }
  }

  await applyCsvImportAtomically({
    mode: 'training',
    cycleId,
    service: 'gas',
    sourceFileName: 'treino_gas_campos_do_sul.csv',
    validRows: demoRowsGas,
    applyToImpactedReadings: true,
    limits: settings,
    authorUid: 'treino_uid',
    authorName: 'Modo Treinamento',
  });

  await applyCsvImportAtomically({
    mode: 'training',
    cycleId,
    service: 'water',
    sourceFileName: 'treino_agua_campos_do_sul.csv',
    validRows: demoRowsWater,
    applyToImpactedReadings: true,
    limits: settings,
    authorUid: 'treino_uid',
    authorName: 'Modo Treinamento',
  });

  // Pre-seed 2 sample readings in Training Mode (101 and 102 of Tower 1 Gas)
  for (const sample of [
    { apt: '101', prev: 125.0, curr: 126.42 },
    { apt: '102', prev: 126.45, curr: 127.9 },
  ]) {
    const rawBlob = await createSimulatedMeterRawBlob({
      tower: 1,
      apartment: sample.apt,
      service: 'gas',
      value: sample.curr,
    });
    const stamped = await stampMeterPhoto({
      rawBlob,
      cycleId,
      tower: 1,
      apartment: sample.apt,
      service: 'gas',
      currentValue: sample.curr,
      slot: 1,
      capturedAtIso: new Date().toISOString(),
    });
    await saveReadingAtomically({
      mode: 'training',
      cycleId,
      service: 'gas',
      tower: 1,
      apartment: sample.apt,
      previousValue: sample.prev,
      currentValue: sample.curr,
      exceptionType: 'none',
      observation: 'Leitura de exemplo do Modo Treinamento',
      limits: settings,
      photo1: stamped,
      photo2: null,
      authorUid: 'treino_uid',
      authorName: 'Leiturista Treino',
    });
  }
}
