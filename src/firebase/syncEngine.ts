import {
  Timestamp,
  collection,
  doc,
  documentId,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  startAfter,
  updateDoc,
} from 'firebase/firestore';
import {
  getOrInitCycleSettings,
  getPhotosForReading,
  getSyncQueueForCycle,
  openLocalDatabase,
  saveCycleCursor,
} from '../db/indexedDb';
import {
  AlertCode,
  CONDOMINIUM_ID,
  ConflictReadingVersion,
  CycleSettingsRecord,
  ExceptionType,
  PhotoRecord,
  ReadingRecord,
  ReferenceRecord,
  SEQUENTIAL_APARTMENTS,
  ServerCursor,
  ServiceType,
  TowerReferenceSyncMeta,
  buildUnitKey,
} from '../types/domain';
import { evaluateReading } from '../utils/consumptionEngine';
import {
  blobToBoundedDataUrl,
  buildPhotoFileName,
  dataUrlToBlob,
} from '../utils/photoStampEngine';
import { OperationType, auth, db, handleFirestoreError } from './config';

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
    tx.onabort = () =>
      reject(tx.error || new Error('Transação IndexedDB abortada.'));
  });
}

function extractServerCursor(
  rawServerTimestamp: unknown,
  docId: string
): ServerCursor | null {
  if (
    rawServerTimestamp &&
    typeof rawServerTimestamp === 'object' &&
    'seconds' in rawServerTimestamp &&
    'nanoseconds' in rawServerTimestamp
  ) {
    const ts = rawServerTimestamp as { seconds: number; nanoseconds: number };
    return {
      seconds: Number(ts.seconds),
      nanoseconds: Number(ts.nanoseconds),
      docId,
    };
  }
  return null;
}

function isPermissionDeniedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
  return (
    msg.includes('permission-denied') ||
    msg.includes('missing or insufficient permissions') ||
    msg.includes('not-found')
  );
}

export interface SyncExecutionSummary {
  pushedSettings: number;
  pushedReferences: number;
  pushedReadings: number;
  conflictsDetected: number;
  pulledSettings: number;
  pulledReferenceTowers: number;
  recalculatedLocalReadingsFromCsvDelta: number;
  pulledReadings: number;
  cursors: {
    settings?: ServerCursor;
    references?: ServerCursor;
    readings?: ServerCursor;
  };
}

/**
 * Preserves BOTH the synchronized remote record (and its photos) AND the local offline
 * attempt (and its photos) in IndexedDB when Firestore rules reject a stale revision
 * or when an incoming delta collides with an unsent local reading.
 */
async function preserveReadingConflictLocally(params: {
  cycleId: string;
  readingId: string;
  remoteData: Record<string, unknown>;
  localReading: ReadingRecord;
}): Promise<void> {
  const localDb = await openLocalDatabase('real');
  const existingPhotos = await getPhotosForReading('real', params.readingId);
  const localPhoto1 = existingPhotos.get('1') || existingPhotos.get('conflict_1');
  const localPhoto2 = existingPhotos.get('2') || existingPhotos.get('conflict_2');

  const remotePhoto1DataUrl = String(params.remoteData.photo1DataUrl || '');
  const remotePhoto2DataUrl = String(params.remoteData.photo2DataUrl || '');

  const remoteBlob1 = remotePhoto1DataUrl
    ? await dataUrlToBlob(remotePhoto1DataUrl)
    : null;
  const remoteBlob2 = remotePhoto2DataUrl
    ? await dataUrlToBlob(remotePhoto2DataUrl)
    : null;

  const tx = localDb.transaction(
    ['readings', 'photos', 'syncQueue'],
    'readwrite'
  );
  const readStore = tx.objectStore('readings');
  const photoStore = tx.objectStore('photos');
  const queueStore = tx.objectStore('syncQueue');

  // 1. Move local photos to slot 'conflict_1' and 'conflict_2' so they are never lost
  let conflictPhoto1Id: string | null = null;
  if (localPhoto1) {
    conflictPhoto1Id = `${params.readingId}_slot_conflict_1`;
    photoStore.put({
      ...localPhoto1,
      id: conflictPhoto1Id,
      slot: 'conflict_1',
    });
  }

  let conflictPhoto2Id: string | null = null;
  if (localPhoto2) {
    conflictPhoto2Id = `${params.readingId}_slot_conflict_2`;
    photoStore.put({
      ...localPhoto2,
      id: conflictPhoto2Id,
      slot: 'conflict_2',
    });
  }

  // 2. Save remote photos into primary slots '1' and '2'
  const service = params.remoteData.service as ServiceType;
  const tower = Number(params.remoteData.tower);
  const apartment = String(params.remoteData.apartment);
  const remoteUpdatedAt = String(
    params.remoteData.updatedAt || new Date().toISOString()
  );
  const remoteCurrentVal = Number(params.remoteData.currentValue);
  const remoteAppliedTariff = params.remoteData.hasAppliedTariff
    ? Number(params.remoteData.appliedTariff)
    : null;
  const remoteCalculatedAmountBrl = params.remoteData.hasCalculatedAmountBrl
    ? Number(params.remoteData.calculatedAmountBrl)
    : null;
  const remoteAmountUnavailableReason = params.remoteData.amountUnavailableReason
    ? String(params.remoteData.amountUnavailableReason)
    : null;

  let remotePhoto1Id: string | null = null;
  if (remoteBlob1) {
    remotePhoto1Id = `${params.readingId}_slot_1`;
    const p1: PhotoRecord = {
      id: remotePhoto1Id,
      readingId: params.readingId,
      slot: '1',
      stampedBlob: remoteBlob1,
      fileName: buildPhotoFileName({
        tower,
        apartment,
        service,
        slot: 1,
        capturedAtIso: remoteUpdatedAt,
      }),
      mimeType: 'image/jpeg',
      sizeBytes: remoteBlob1.size,
      width: 1024,
      height: 768,
      auditCode: String(params.remoteData.auditCode1 || ''),
      stampedValue: remoteCurrentVal,
      stampedTariff: remoteAppliedTariff,
      stampedAmountBrl: remoteCalculatedAmountBrl,
      capturedAt: remoteUpdatedAt,
    };
    photoStore.put(p1);
  }

  let remotePhoto2Id: string | null = null;
  if (remoteBlob2) {
    remotePhoto2Id = `${params.readingId}_slot_2`;
    const p2: PhotoRecord = {
      id: remotePhoto2Id,
      readingId: params.readingId,
      slot: '2',
      stampedBlob: remoteBlob2,
      fileName: buildPhotoFileName({
        tower,
        apartment,
        service,
        slot: 2,
        capturedAtIso: remoteUpdatedAt,
      }),
      mimeType: 'image/jpeg',
      sizeBytes: remoteBlob2.size,
      width: 1024,
      height: 768,
      auditCode: String(params.remoteData.auditCode2 || ''),
      stampedValue: remoteCurrentVal,
      stampedTariff: remoteAppliedTariff,
      stampedAmountBrl: remoteCalculatedAmountBrl,
      capturedAt: remoteUpdatedAt,
    };
    photoStore.put(p2);
  } else {
    photoStore.delete(`${params.readingId}_slot_2`);
  }

  // 3. Build conflictCandidate from the local attempt
  const localCandidate: ConflictReadingVersion = {
    source: 'local',
    previousValue: params.localReading.previousValue,
    currentValue: params.localReading.currentValue,
    consumption: params.localReading.consumption,
    appliedTariff: params.localReading.appliedTariff,
    calculatedAmountBrl: params.localReading.calculatedAmountBrl,
    amountUnavailableReason: params.localReading.amountUnavailableReason,
    status: params.localReading.status,
    alerts: params.localReading.alerts,
    exceptionType: params.localReading.exceptionType,
    observation: params.localReading.observation,
    auditCode1: params.localReading.auditCode1,
    auditCode2: params.localReading.auditCode2,
    photo1Id: conflictPhoto1Id,
    photo2Id: conflictPhoto2Id,
    revision: params.localReading.revision,
    revisionToken: params.localReading.revisionToken,
    baseRevisionToken: params.localReading.baseRevisionToken,
    createdByUid: params.localReading.createdByUid,
    createdByName: params.localReading.createdByName,
    createdAt: params.localReading.createdAt,
    updatedByUid: params.localReading.updatedByUid,
    updatedByName: params.localReading.updatedByName,
    updatedAt: params.localReading.updatedAt,
  };

  const remoteAlertsRaw = String(params.remoteData.alerts || '');
  const remoteAlerts = remoteAlertsRaw
    ? (remoteAlertsRaw.split(',').filter(Boolean) as AlertCode[])
    : [];
  const serverCursor = extractServerCursor(
    params.remoteData.serverUpdatedAt,
    params.readingId
  );

  const mergedConflictRecord: ReadingRecord = {
    id: params.readingId,
    condominiumId: CONDOMINIUM_ID,
    cycleId: params.cycleId,
    service,
    tower,
    apartment,
    previousValue: params.remoteData.hasPreviousValue
      ? Number(params.remoteData.previousValue)
      : null,
    currentValue: remoteCurrentVal,
    consumption: params.remoteData.hasConsumption
      ? Number(params.remoteData.consumption)
      : null,
    appliedTariff: remoteAppliedTariff,
    calculatedAmountBrl: remoteCalculatedAmountBrl,
    amountUnavailableReason: remoteAmountUnavailableReason,
    referenceSource:
      (params.remoteData.referenceSource as 'configured_limits' | 'historical') ||
      'configured_limits',
    status: (params.remoteData.status as 'read' | 'alert') || 'read',
    alerts: remoteAlerts,
    exceptionType:
      (params.remoteData.exceptionType as ExceptionType) || 'none',
    observation: String(params.remoteData.observation || ''),
    photo1Id: remotePhoto1Id,
    photo2Id: remotePhoto2Id,
    auditCode1: String(params.remoteData.auditCode1 || ''),
    auditCode2: String(params.remoteData.auditCode2 || ''),
    syncStatus: 'conflict',
    revision: Number(params.remoteData.revision || 1),
    revisionToken: String(params.remoteData.revisionToken || ''),
    baseRevisionToken: String(params.remoteData.baseRevisionToken || ''),
    createdByUid: String(params.remoteData.createdByUid || ''),
    createdByName: String(params.remoteData.createdByName || ''),
    createdAt: String(params.remoteData.createdAt || remoteUpdatedAt),
    updatedByUid: String(params.remoteData.updatedByUid || ''),
    updatedByName: String(params.remoteData.updatedByName || ''),
    updatedAt: remoteUpdatedAt,
    serverUpdatedAt: serverCursor
      ? { seconds: serverCursor.seconds, nanoseconds: serverCursor.nanoseconds }
      : undefined,
    conflictCandidate: localCandidate,
  };

  readStore.put(mergedConflictRecord);
  // Remove from active queue so user must inspect and explicitly choose which version wins
  queueStore.delete(`readings__${params.readingId}`);
  await idbTxDone(tx);
}

/**
 * Flushes the persistent syncQueue WITHOUT pre-reading any document before writing.
 * Firestore security rules validate `revision` and `baseRevisionToken` atomically.
 */
async function flushSyncQueueWithoutPreRead(cycleId: string): Promise<{
  pushedSettings: number;
  pushedReferences: number;
  pushedReadings: number;
  conflictsDetected: number;
}> {
  if (!db || !auth?.currentUser) {
    throw new Error('Autentique-se com sua conta Google antes de sincronizar.');
  }

  const currentUser = auth.currentUser;
  const queueItems = await getSyncQueueForCycle('real', cycleId);
  const localDb = await openLocalDatabase('real');

  let pushedSettings = 0;
  let pushedReferences = 0;
  let pushedReadings = 0;
  let conflictsDetected = 0;

  for (const item of queueItems) {
    if (item.targetCollection === 'settings') {
      const txRead = localDb.transaction('settings', 'readonly');
      const localSettings = await idbReq<CycleSettingsRecord | undefined>(
        txRead.objectStore('settings').get(cycleId)
      );
      if (!localSettings) continue;

      const hasWaterTariff =
        localSettings.waterTariffPerM3 !== null &&
        localSettings.waterTariffPerM3 !== undefined &&
        localSettings.waterTariffPerM3 > 0;
      const hasGasTariff =
        localSettings.gasTariffPerM3 !== null &&
        localSettings.gasTariffPerM3 !== undefined &&
        localSettings.gasTariffPerM3 > 0;

      const path = `cycles/${cycleId}/settings/config`;
      const docRef = doc(db, 'cycles', cycleId, 'settings', 'config');
      const payload = {
        condominiumId: CONDOMINIUM_ID,
        cycleId,
        waterAlertLimit: localSettings.waterAlertLimit,
        waterCeilingLimit: localSettings.waterCeilingLimit,
        gasAlertLimit: localSettings.gasAlertLimit,
        gasCeilingLimit: localSettings.gasCeilingLimit,
        gasNoiseLimit: localSettings.gasNoiseLimit,
        waterTariffPerM3: hasWaterTariff ? localSettings.waterTariffPerM3! : -1,
        hasWaterTariff,
        gasTariffPerM3: hasGasTariff ? localSettings.gasTariffPerM3! : -1,
        hasGasTariff,
        physicalOrders: localSettings.physicalOrders || {},
        revision: item.revision,
        revisionToken: localSettings.revisionToken,
        baseRevisionToken: item.baseRevisionToken,
        updatedByUid: currentUser.uid,
        updatedByName:
          currentUser.displayName || currentUser.email || 'Leiturista',
        updatedAt: localSettings.updatedAt,
        serverUpdatedAt: serverTimestamp(),
      };

      try {
        if (item.expectedOperation === 'create') {
          await setDoc(docRef, payload);
        } else {
          await updateDoc(docRef, payload);
        }
        const txDone = localDb.transaction(
          ['settings', 'syncQueue'],
          'readwrite'
        );
        txDone.objectStore('settings').put({
          ...localSettings,
          syncStatus: 'synced',
        });
        txDone.objectStore('syncQueue').delete(item.id);
        await idbTxDone(txDone);
        pushedSettings++;
      } catch (err) {
        if (isPermissionDeniedError(err)) {
          // Check if remote config already exists with higher revision; if unauthorized UID, rethrow structured error
          let remoteSnap;
          try {
            remoteSnap = await getDoc(docRef);
          } catch (readErr) {
            handleFirestoreError(readErr, OperationType.GET, path);
          }
          if (remoteSnap && remoteSnap.exists()) {
            const rData = remoteSnap.data();
            const nextRev = Number(rData.revision || 1) + 1;
            const nextBase = String(rData.revisionToken || '');
            await updateDoc(docRef, {
              ...payload,
              revision: nextRev,
              baseRevisionToken: nextBase,
            });
            const txDone = localDb.transaction(
              ['settings', 'syncQueue'],
              'readwrite'
            );
            txDone.objectStore('settings').put({
              ...localSettings,
              revision: nextRev,
              baseRevisionToken: nextBase,
              syncStatus: 'synced',
            });
            txDone.objectStore('syncQueue').delete(item.id);
            await idbTxDone(txDone);
            pushedSettings++;
          } else {
            handleFirestoreError(
              err,
              item.expectedOperation === 'create'
                ? OperationType.CREATE
                : OperationType.UPDATE,
              path
            );
          }
        } else {
          throw err;
        }
      }
    } else if (item.targetCollection === 'references') {
      const txRead = localDb.transaction(
        ['towerRefMeta', 'references'],
        'readonly'
      );
      const meta = await idbReq<TowerReferenceSyncMeta | undefined>(
        txRead.objectStore('towerRefMeta').get(item.docId)
      );
      if (!meta) continue;

      const allServiceRefs = await idbReq<ReferenceRecord[]>(
        txRead
          .objectStore('references')
          .index('by_cycle_service')
          .getAll(IDBKeyRange.only([cycleId, meta.service]))
      );
      const towerRefs = allServiceRefs.filter((r) => r.tower === meta.tower);
      const apartmentsMap: Record<string, number | null> = {};
      for (const r of towerRefs) {
        apartmentsMap[r.apartment] = r.previousValue;
      }

      const path = `cycles/${cycleId}/references/${item.docId}`;
      const docRef = doc(db, 'cycles', cycleId, 'references', item.docId);
      const payload = {
        condominiumId: CONDOMINIUM_ID,
        cycleId,
        service: meta.service,
        tower: meta.tower,
        apartments: apartmentsMap,
        sourceFile: meta.sourceFile,
        revision: item.revision,
        revisionToken: meta.revisionToken,
        baseRevisionToken: item.baseRevisionToken,
        importedByUid: currentUser.uid,
        importedByName:
          currentUser.displayName || currentUser.email || 'Leiturista',
        importedAt: meta.importedAt,
        serverUpdatedAt: serverTimestamp(),
      };

      try {
        if (item.expectedOperation === 'create') {
          await setDoc(docRef, payload);
        } else {
          await updateDoc(docRef, payload);
        }
        const txDone = localDb.transaction(
          ['towerRefMeta', 'syncQueue'],
          'readwrite'
        );
        txDone.objectStore('towerRefMeta').put({
          ...meta,
          syncStatus: 'synced',
        });
        txDone.objectStore('syncQueue').delete(item.id);
        await idbTxDone(txDone);
        pushedReferences++;
      } catch (err) {
        if (isPermissionDeniedError(err)) {
          let remoteSnap;
          try {
            remoteSnap = await getDoc(docRef);
          } catch (readErr) {
            handleFirestoreError(readErr, OperationType.GET, path);
          }
          if (remoteSnap && remoteSnap.exists()) {
            const rData = remoteSnap.data();
            const nextRev = Number(rData.revision || 1) + 1;
            const nextBase = String(rData.revisionToken || '');
            await updateDoc(docRef, {
              ...payload,
              revision: nextRev,
              baseRevisionToken: nextBase,
            });
            const txDone = localDb.transaction(
              ['towerRefMeta', 'syncQueue'],
              'readwrite'
            );
            txDone.objectStore('towerRefMeta').put({
              ...meta,
              revision: nextRev,
              baseRevisionToken: nextBase,
              syncStatus: 'synced',
            });
            txDone.objectStore('syncQueue').delete(item.id);
            await idbTxDone(txDone);
            pushedReferences++;
          } else {
            handleFirestoreError(
              err,
              item.expectedOperation === 'create'
                ? OperationType.CREATE
                : OperationType.UPDATE,
              path
            );
          }
        } else {
          throw err;
        }
      }
    } else if (item.targetCollection === 'readings') {
      const txRead = localDb.transaction('readings', 'readonly');
      const localReading = await idbReq<ReadingRecord | undefined>(
        txRead.objectStore('readings').get(item.docId)
      );
      if (!localReading) continue;

      const photosMap = await getPhotosForReading('real', item.docId);
      const photo1 = photosMap.get('1');
      const photo2 = photosMap.get('2');

      const photo1DataUrl = photo1
        ? await blobToBoundedDataUrl(photo1.stampedBlob, 340000)
        : '';
      const photo2DataUrl = photo2
        ? await blobToBoundedDataUrl(photo2.stampedBlob, 340000)
        : '';

      const path = `cycles/${cycleId}/readings/${item.docId}`;
      const docRef = doc(db, 'cycles', cycleId, 'readings', item.docId);

      const authorName =
        currentUser.displayName || currentUser.email || 'Leiturista';

      const hasAppliedTariff =
        localReading.appliedTariff !== null &&
        localReading.appliedTariff !== undefined &&
        localReading.appliedTariff > 0;
      const hasCalculatedAmountBrl =
        localReading.calculatedAmountBrl !== null &&
        localReading.calculatedAmountBrl !== undefined &&
        localReading.calculatedAmountBrl >= 0;

      const payload = {
        id: localReading.id,
        condominiumId: CONDOMINIUM_ID,
        cycleId: localReading.cycleId,
        service: localReading.service,
        tower: localReading.tower,
        apartment: localReading.apartment,
        previousValue:
          localReading.previousValue !== null ? localReading.previousValue : -1,
        hasPreviousValue: localReading.previousValue !== null,
        currentValue: localReading.currentValue,
        consumption:
          localReading.consumption !== null ? localReading.consumption : 0,
        hasConsumption: localReading.consumption !== null,
        appliedTariff: hasAppliedTariff ? localReading.appliedTariff! : -1,
        hasAppliedTariff,
        calculatedAmountBrl: hasCalculatedAmountBrl
          ? localReading.calculatedAmountBrl!
          : -1,
        hasCalculatedAmountBrl,
        amountUnavailableReason: (
          localReading.amountUnavailableReason || ''
        ).slice(0, 120),
        referenceSource: localReading.referenceSource,
        status: localReading.status,
        alerts: localReading.alerts.join(','),
        exceptionType: localReading.exceptionType,
        observation: localReading.observation.slice(0, 500),
        auditCode1: localReading.auditCode1.slice(0, 64),
        auditCode2: localReading.auditCode2.slice(0, 64),
        photo1DataUrl,
        photo2DataUrl,
        revision: item.revision,
        revisionToken: localReading.revisionToken,
        baseRevisionToken: item.baseRevisionToken,
        createdByUid:
          item.expectedOperation === 'create'
            ? currentUser.uid
            : localReading.createdByUid,
        createdByName:
          item.expectedOperation === 'create'
            ? authorName
            : localReading.createdByName,
        createdAt: localReading.createdAt,
        updatedByUid: currentUser.uid,
        updatedByName: authorName,
        updatedAt: localReading.updatedAt,
        serverUpdatedAt: serverTimestamp(),
      };

      try {
        // Direct write WITHOUT pre-read! Rules validate revision atomically.
        if (item.expectedOperation === 'create') {
          await setDoc(docRef, payload);
        } else {
          await updateDoc(docRef, payload);
        }

        const txDone = localDb.transaction(
          ['readings', 'syncQueue'],
          'readwrite'
        );
        txDone.objectStore('readings').put({
          ...localReading,
          createdByUid: payload.createdByUid,
          createdByName: payload.createdByName,
          updatedByUid: payload.updatedByUid,
          updatedByName: payload.updatedByName,
          syncStatus: 'synced',
        });
        txDone.objectStore('syncQueue').delete(item.id);
        await idbTxDone(txDone);
        pushedReadings++;
      } catch (err) {
        if (isPermissionDeniedError(err)) {
          // Distinguish between a genuine revision conflict (remote doc exists with a different revisionToken)
          // and an unauthorized UID blocked by firestore.rules.
          let remoteSnap;
          try {
            remoteSnap = await getDoc(docRef);
          } catch (readErr) {
            handleFirestoreError(readErr, OperationType.GET, path);
          }

          if (remoteSnap && remoteSnap.exists()) {
            const remoteData = remoteSnap.data();
            // If the remote revisionToken already matches our local revisionToken, it was an idempotent retry
            if (remoteData.revisionToken === localReading.revisionToken) {
              const txDone = localDb.transaction(
                ['readings', 'syncQueue'],
                'readwrite'
              );
              txDone.objectStore('readings').put({
                ...localReading,
                syncStatus: 'synced',
              });
              txDone.objectStore('syncQueue').delete(item.id);
              await idbTxDone(txDone);
            } else {
              // Concurrent edit / stale revision detected by Firestore rules!
              // Preserve BOTH the remote synchronized record and the local offline attempt + both photo sets.
              await preserveReadingConflictLocally({
                cycleId,
                readingId: localReading.id,
                remoteData,
                localReading,
              });
              conflictsDetected++;
            }
          } else {
            // Document does not exist and write was denied -> user's UID is not in the authorized list yet
            handleFirestoreError(
              err,
              item.expectedOperation === 'create'
                ? OperationType.CREATE
                : OperationType.UPDATE,
              path
            );
          }
        } else {
          throw err;
        }
      }
    }
  }

  return {
    pushedSettings,
    pushedReferences,
    pushedReadings,
    conflictsDetected,
  };
}

/**
 * Pulls delta changes for settings, references (including CSV re-imports), and readings
 * using the full composite server cursor `{ seconds, nanoseconds, docId }` without reducing to milliseconds.
 */
async function pullCycleDeltasWithCompositeCursor(cycleId: string): Promise<{
  pulledSettings: number;
  pulledReferenceTowers: number;
  recalculatedLocalReadingsFromCsvDelta: number;
  pulledReadings: number;
  conflictsDetected: number;
}> {
  if (!db || !auth?.currentUser) {
    throw new Error('Autentique-se com sua conta Google antes de sincronizar.');
  }

  const localDb = await openLocalDatabase('real');
  let settings = await getOrInitCycleSettings('real', cycleId);

  let pulledSettings = 0;
  let pulledReferenceTowers = 0;
  let recalculatedLocalReadingsFromCsvDelta = 0;
  let pulledReadings = 0;
  let conflictsDetected = 0;

  // 1. Pull delta for `/cycles/{cycleId}/settings`
  {
    const colPath = `cycles/${cycleId}/settings`;
    const colRef = collection(db, 'cycles', cycleId, 'settings');
    const cursor = settings.cursors?.settings;
    const q = cursor
      ? query(
          colRef,
          orderBy('serverUpdatedAt', 'asc'),
          orderBy(documentId(), 'asc'),
          startAfter(new Timestamp(cursor.seconds, cursor.nanoseconds), cursor.docId)
        )
      : query(
          colRef,
          orderBy('serverUpdatedAt', 'asc'),
          orderBy(documentId(), 'asc')
        );

    let snap;
    try {
      snap = await getDocs(q);
    } catch (err) {
      handleFirestoreError(err, OperationType.LIST, colPath);
    }

    let lastCursor: ServerCursor | null = null;
    for (const d of snap.docs) {
      const data = d.data();
      const c = extractServerCursor(data.serverUpdatedAt, d.id);
      if (c) lastCursor = c;

      const tx = localDb.transaction('settings', 'readwrite');
      const currentSettings = await idbReq<CycleSettingsRecord | undefined>(
        tx.objectStore('settings').get(cycleId)
      );
      const base = currentSettings || settings;

      const waterTariffPerM3 =
        data.hasWaterTariff === true
          ? Number(data.waterTariffPerM3)
          : data.hasWaterTariff === false
          ? null
          : base.waterTariffPerM3;
      const gasTariffPerM3 =
        data.hasGasTariff === true
          ? Number(data.gasTariffPerM3)
          : data.hasGasTariff === false
          ? null
          : base.gasTariffPerM3;

      const updatedSettings: CycleSettingsRecord = {
        ...base,
        waterAlertLimit: Number(
          data.waterAlertLimit ?? base.waterAlertLimit
        ),
        waterCeilingLimit: Number(
          data.waterCeilingLimit ?? base.waterCeilingLimit
        ),
        gasAlertLimit: Number(data.gasAlertLimit ?? base.gasAlertLimit),
        gasCeilingLimit: Number(
          data.gasCeilingLimit ?? base.gasCeilingLimit
        ),
        gasNoiseLimit: Number(data.gasNoiseLimit ?? base.gasNoiseLimit),
        waterTariffPerM3,
        gasTariffPerM3,
        physicalOrders:
          (data.physicalOrders as Record<string, string[]>) ||
          base.physicalOrders,
        revision: Number(data.revision || 1),
        revisionToken: String(data.revisionToken || ''),
        baseRevisionToken: String(data.baseRevisionToken || ''),
        updatedByUid: String(data.updatedByUid || base.updatedByUid),
        updatedByName: String(data.updatedByName || base.updatedByName),
        updatedAt: String(data.updatedAt || base.updatedAt),
        serverUpdatedAt: c
          ? { seconds: c.seconds, nanoseconds: c.nanoseconds }
          : base.serverUpdatedAt,
        syncStatus: 'synced',
      };
      tx.objectStore('settings').put(updatedSettings);
      await idbTxDone(tx);
      settings = updatedSettings;
      pulledSettings++;
    }

    if (lastCursor) {
      settings = await saveCycleCursor('real', cycleId, 'settings', lastCursor);
    }
  }

  // 2. Pull delta for `/cycles/{cycleId}/references` (CSV imports and re-imports!)
  {
    const colPath = `cycles/${cycleId}/references`;
    const colRef = collection(db, 'cycles', cycleId, 'references');
    const cursor = settings.cursors?.references;
    const q = cursor
      ? query(
          colRef,
          orderBy('serverUpdatedAt', 'asc'),
          orderBy(documentId(), 'asc'),
          startAfter(new Timestamp(cursor.seconds, cursor.nanoseconds), cursor.docId)
        )
      : query(
          colRef,
          orderBy('serverUpdatedAt', 'asc'),
          orderBy(documentId(), 'asc')
        );

    let snap;
    try {
      snap = await getDocs(q);
    } catch (err) {
      handleFirestoreError(err, OperationType.LIST, colPath);
    }

    let lastCursor: ServerCursor | null = null;
    for (const d of snap.docs) {
      const data = d.data();
      const c = extractServerCursor(data.serverUpdatedAt, d.id);
      if (c) lastCursor = c;

      const service = data.service as ServiceType;
      const tower = Number(data.tower);
      const apartmentsMap = (data.apartments || {}) as Record<
        string,
        number | null
      >;
      const sourceFile = String(data.sourceFile || 'csv_sincronizado.csv');
      const importedAt = String(data.importedAt || new Date().toISOString());
      const importedByUid = String(data.importedByUid || '');
      const importedByName = String(data.importedByName || '');

      const tx = localDb.transaction(
        ['references', 'towerRefMeta', 'readings'],
        'readwrite'
      );
      const refStore = tx.objectStore('references');
      const metaStore = tx.objectStore('towerRefMeta');
      const readStore = tx.objectStore('readings');

      for (const apt of SEQUENTIAL_APARTMENTS) {
        if (!(apt in apartmentsMap)) continue;
        const newPrevVal =
          apartmentsMap[apt] === null || apartmentsMap[apt] === undefined
            ? null
            : Number(apartmentsMap[apt]);
        const unitId = buildUnitKey(cycleId, service, tower, apt);

        const refRecord: ReferenceRecord = {
          id: unitId,
          cycleId,
          service,
          tower,
          apartment: apt,
          previousValue: newPrevVal,
          sourceFile,
          importedAt,
          importedByUid,
          importedByName,
        };
        refStore.put(refRecord);

        // If this second device already has a collected reading for this apartment,
        // preserve its currentValue, observation, photos, appliedTariff, and authorship, and recalculate consumption/alerts!
        const existingReading = await idbReq<ReadingRecord | undefined>(
          readStore.get(unitId)
        );
        if (
          existingReading &&
          existingReading.previousValue !== newPrevVal
        ) {
          const preservedTariff =
            existingReading.appliedTariff !== undefined &&
            existingReading.appliedTariff !== null
              ? existingReading.appliedTariff
              : service === 'water'
              ? settings.waterTariffPerM3
              : settings.gasTariffPerM3;

          const reEval = evaluateReading({
            service,
            previousValue: newPrevVal,
            currentValue: existingReading.currentValue,
            limits: settings,
            exceptionType: existingReading.exceptionType,
            tariffOverridePerM3: preservedTariff,
          });
          readStore.put({
            ...existingReading,
            previousValue: newPrevVal,
            consumption: reEval.consumption,
            appliedTariff: reEval.appliedTariff,
            calculatedAmountBrl: reEval.calculatedAmountBrl,
            amountUnavailableReason: reEval.amountUnavailableReason,
            status: reEval.status,
            alerts: reEval.alerts,
          });
          recalculatedLocalReadingsFromCsvDelta++;
        }
      }

      const metaRecord: TowerReferenceSyncMeta = {
        id: d.id,
        cycleId,
        service,
        tower,
        sourceFile,
        revision: Number(data.revision || 1),
        revisionToken: String(data.revisionToken || ''),
        baseRevisionToken: String(data.baseRevisionToken || ''),
        importedByUid,
        importedByName,
        importedAt,
        serverUpdatedAt: c
          ? { seconds: c.seconds, nanoseconds: c.nanoseconds }
          : undefined,
        syncStatus: 'synced',
      };
      metaStore.put(metaRecord);
      await idbTxDone(tx);
      pulledReferenceTowers++;
    }

    if (lastCursor) {
      settings = await saveCycleCursor(
        'real',
        cycleId,
        'references',
        lastCursor
      );
    }
  }

  // 3. Pull delta for `/cycles/{cycleId}/readings`
  {
    const colPath = `cycles/${cycleId}/readings`;
    const colRef = collection(db, 'cycles', cycleId, 'readings');
    const cursor = settings.cursors?.readings;
    const q = cursor
      ? query(
          colRef,
          orderBy('serverUpdatedAt', 'asc'),
          orderBy(documentId(), 'asc'),
          startAfter(new Timestamp(cursor.seconds, cursor.nanoseconds), cursor.docId)
        )
      : query(
          colRef,
          orderBy('serverUpdatedAt', 'asc'),
          orderBy(documentId(), 'asc')
        );

    let snap;
    try {
      snap = await getDocs(q);
    } catch (err) {
      handleFirestoreError(err, OperationType.LIST, colPath);
    }

    let lastCursor: ServerCursor | null = null;
    for (const d of snap.docs) {
      const data = d.data();
      const c = extractServerCursor(data.serverUpdatedAt, d.id);
      if (c) lastCursor = c;

      const readingId = d.id;
      const txCheck = localDb.transaction('readings', 'readonly');
      const existingLocal = await idbReq<ReadingRecord | undefined>(
        txCheck.objectStore('readings').get(readingId)
      );

      // If local device has an unsent 'local_only' reading with a different revisionToken, preserve both!
      if (
        existingLocal &&
        existingLocal.syncStatus === 'local_only' &&
        existingLocal.revisionToken !== String(data.revisionToken || '')
      ) {
        await preserveReadingConflictLocally({
          cycleId,
          readingId,
          remoteData: data,
          localReading: existingLocal,
        });
        conflictsDetected++;
        continue;
      }

      const photo1DataUrl = String(data.photo1DataUrl || '');
      const photo2DataUrl = String(data.photo2DataUrl || '');
      const blob1 = photo1DataUrl ? await dataUrlToBlob(photo1DataUrl) : null;
      const blob2 = photo2DataUrl ? await dataUrlToBlob(photo2DataUrl) : null;

      const service = data.service as ServiceType;
      const tower = Number(data.tower);
      const apartment = String(data.apartment);
      const updatedAt = String(data.updatedAt || new Date().toISOString());
      const currentVal = Number(data.currentValue);
      const appliedTariff = data.hasAppliedTariff
        ? Number(data.appliedTariff)
        : null;
      const calculatedAmountBrl = data.hasCalculatedAmountBrl
        ? Number(data.calculatedAmountBrl)
        : null;
      const amountUnavailableReason = data.amountUnavailableReason
        ? String(data.amountUnavailableReason)
        : null;

      const txWrite = localDb.transaction(['readings', 'photos'], 'readwrite');
      const readStore = txWrite.objectStore('readings');
      const photoStore = txWrite.objectStore('photos');

      let photo1Id: string | null = null;
      if (blob1) {
        photo1Id = `${readingId}_slot_1`;
        photoStore.put({
          id: photo1Id,
          readingId,
          slot: '1',
          stampedBlob: blob1,
          fileName: buildPhotoFileName({
            tower,
            apartment,
            service,
            slot: 1,
            capturedAtIso: updatedAt,
          }),
          mimeType: 'image/jpeg',
          sizeBytes: blob1.size,
          width: 1024,
          height: 768,
          auditCode: String(data.auditCode1 || ''),
          stampedValue: currentVal,
          stampedTariff: appliedTariff,
          stampedAmountBrl: calculatedAmountBrl,
          capturedAt: updatedAt,
        } satisfies PhotoRecord);
      }

      let photo2Id: string | null = null;
      if (blob2) {
        photo2Id = `${readingId}_slot_2`;
        photoStore.put({
          id: photo2Id,
          readingId,
          slot: '2',
          stampedBlob: blob2,
          fileName: buildPhotoFileName({
            tower,
            apartment,
            service,
            slot: 2,
            capturedAtIso: updatedAt,
          }),
          mimeType: 'image/jpeg',
          sizeBytes: blob2.size,
          width: 1024,
          height: 768,
          auditCode: String(data.auditCode2 || ''),
          stampedValue: currentVal,
          stampedTariff: appliedTariff,
          stampedAmountBrl: calculatedAmountBrl,
          capturedAt: updatedAt,
        } satisfies PhotoRecord);
      }

      const alertsStr = String(data.alerts || '');
      const alerts = alertsStr
        ? (alertsStr.split(',').filter(Boolean) as AlertCode[])
        : [];

      const syncedReading: ReadingRecord = {
        id: readingId,
        condominiumId: CONDOMINIUM_ID,
        cycleId,
        service,
        tower,
        apartment,
        previousValue: data.hasPreviousValue
          ? Number(data.previousValue)
          : null,
        currentValue: currentVal,
        consumption: data.hasConsumption ? Number(data.consumption) : null,
        appliedTariff,
        calculatedAmountBrl,
        amountUnavailableReason,
        referenceSource:
          (data.referenceSource as 'configured_limits' | 'historical') ||
          'configured_limits',
        status: (data.status as 'read' | 'alert') || 'read',
        alerts,
        exceptionType: (data.exceptionType as ExceptionType) || 'none',
        observation: String(data.observation || ''),
        photo1Id,
        photo2Id,
        auditCode1: String(data.auditCode1 || ''),
        auditCode2: String(data.auditCode2 || ''),
        syncStatus: 'synced',
        revision: Number(data.revision || 1),
        revisionToken: String(data.revisionToken || ''),
        baseRevisionToken: String(data.baseRevisionToken || ''),
        createdByUid: String(data.createdByUid || ''),
        createdByName: String(data.createdByName || ''),
        createdAt: String(data.createdAt || updatedAt),
        updatedByUid: String(data.updatedByUid || ''),
        updatedByName: String(data.updatedByName || ''),
        updatedAt,
        serverUpdatedAt: c
          ? { seconds: c.seconds, nanoseconds: c.nanoseconds }
          : undefined,
        conflictCandidate: existingLocal?.conflictCandidate,
      };

      readStore.put(syncedReading);
      await idbTxDone(txWrite);
      pulledReadings++;
    }

    if (lastCursor) {
      settings = await saveCycleCursor('real', cycleId, 'readings', lastCursor);
    }
  }

  return {
    pulledSettings,
    pulledReferenceTowers,
    recalculatedLocalReadingsFromCsvDelta,
    pulledReadings,
    conflictsDetected,
  };
}

/**
 * Explicit Incremental Sync ("Atualizar") action:
 * 1. Pushes queued items (settings, references, readings) without pre-reads.
 * 2. Pulls delta changes for settings, references, and readings using full composite server cursors.
 */
export async function executeExplicitIncrementalSync(
  cycleId: string
): Promise<SyncExecutionSummary> {
  const pushRes = await flushSyncQueueWithoutPreRead(cycleId);
  const pullRes = await pullCycleDeltasWithCompositeCursor(cycleId);
  const updatedSettings = await getOrInitCycleSettings('real', cycleId);

  return {
    pushedSettings: pushRes.pushedSettings,
    pushedReferences: pushRes.pushedReferences,
    pushedReadings: pushRes.pushedReadings,
    conflictsDetected: pushRes.conflictsDetected + pullRes.conflictsDetected,
    pulledSettings: pullRes.pulledSettings,
    pulledReferenceTowers: pullRes.pulledReferenceTowers,
    recalculatedLocalReadingsFromCsvDelta:
      pullRes.recalculatedLocalReadingsFromCsvDelta,
    pulledReadings: pullRes.pulledReadings,
    cursors: updatedSettings.cursors,
  };
}
