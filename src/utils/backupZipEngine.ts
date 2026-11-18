import JSZip from 'jszip';
import {
  getOrInitCycleSettings,
  getPhotosForReading,
  getReadingsForCycleService,
  getReferencesForCycleService,
  openLocalDatabase,
} from '../db/indexedDb';
import {
  AlertCode,
  CONDOMINIUM_ID,
  CONDOMINIUM_NAME,
  ConflictReadingVersion,
  ExceptionType,
  OperatingMode,
  PhotoRecord,
  ReadingRecord,
  ReferenceRecord,
  SEQUENTIAL_APARTMENTS,
  ServiceType,
  SyncQueueItem,
  buildUnitKey,
  formatTowerCode,
  formatTowerNumber,
  generateRevisionToken,
} from '../types/domain';
import { evaluateReading, getAuditedReadingFinancials } from './consumptionEngine';
import { buildExportCsv } from './csvEngine';

export const BACKUP_MANIFEST_VERSION = '2.1.0';

export interface BackupPhotoLink {
  slot: 1 | 2;
  fileName: string;
  auditCode: string;
  stampedValue: number;
  stampedTariff?: number | null;
  stampedAmountBrl?: number | null;
  capturedAt: string;
  sizeBytes: number;
}

export interface BackupManifestEntry {
  unitId: string;
  cycleId: string;
  service: ServiceType;
  tower: number;
  apartment: string;
  previousValue: number | null;
  currentValue: number;
  consumption: number | null;
  appliedTariff?: number | null;
  calculatedAmountBrl?: number | null;
  amountUnavailableReason?: string | null;
  referenceSource: 'configured_limits' | 'historical';
  status: 'read' | 'alert';
  alerts: AlertCode[];
  exceptionType: ExceptionType;
  observation: string;
  auditCode1: string;
  auditCode2: string;
  revision: number;
  revisionToken: string;
  baseRevisionToken: string;
  createdByUid: string;
  createdByName: string;
  createdAt: string;
  updatedByUid: string;
  updatedByName: string;
  updatedAt: string;
  photos: BackupPhotoLink[];
}

export interface BackupReferenceEntry {
  tower: number;
  apartment: string;
  previousValue: number | null;
  sourceFile: string;
}

export interface TowerBackupManifest {
  manifestVersion: string;
  appName: 'SN - Leituras';
  condominiumId: 'campos-do-sul';
  condominiumName: string;
  exportedAt: string;
  cycleId: string;
  service: ServiceType;
  towers: number[];
  references: BackupReferenceEntry[];
  readings: BackupManifestEntry[];
}

/**
 * Generates a complete local ZIP backup for one or more towers containing:
 * - `manifest.json` (versioned manifest with cycle, unit, service, previous/current readings,
 *   appliedTariff, calculatedAmountBrl, observation, alerts, timestamps, audit codes, and photo file links)
 * - `photos/*.jpg` (all stamped JPEGs)
 * - `relatorio_conferencia.csv` (conference CSV report with tariff and R$ value)
 */
export async function generateTowerBackupZip(params: {
  mode: OperatingMode;
  cycleId: string;
  service: ServiceType;
  towers: number[];
}): Promise<{ zipBlob: Blob; fileName: string; readingsCount: number; photosCount: number }> {
  const { mode, cycleId, service, towers } = params;
  const zip = new JSZip();
  const photosFolder = zip.folder('photos')!;

  const settings = await getOrInitCycleSettings(mode, cycleId);
  const fallbackTariffPerM3 =
    service === 'water' ? settings.waterTariffPerM3 : settings.gasTariffPerM3;
  const referencesMap = await getReferencesForCycleService(mode, cycleId, service);
  const readingsMap = await getReadingsForCycleService(mode, cycleId, service);

  const manifestReferences: BackupReferenceEntry[] = [];
  const manifestReadings: BackupManifestEntry[] = [];
  let photosCount = 0;

  for (const tower of towers) {
    for (const apt of SEQUENTIAL_APARTMENTS) {
      const unitId = buildUnitKey(cycleId, service, tower, apt);
      const ref = referencesMap.get(unitId);
      if (ref) {
        manifestReferences.push({
          tower,
          apartment: apt,
          previousValue: ref.previousValue,
          sourceFile: ref.sourceFile,
        });
      }

      const reading = readingsMap.get(unitId);
      if (!reading) continue;

      const financials = getAuditedReadingFinancials(reading, fallbackTariffPerM3);
      const photosMap = await getPhotosForReading(mode, reading.id);
      const photoLinks: BackupPhotoLink[] = [];

      const p1 = photosMap.get('1');
      if (p1) {
        const safeName = `T${formatTowerNumber(tower)}_A${apt}_${service.toUpperCase()}_F1_${p1.auditCode}.jpg`;
        photosFolder.file(safeName, p1.stampedBlob);
        photoLinks.push({
          slot: 1,
          fileName: `photos/${safeName}`,
          auditCode: p1.auditCode,
          stampedValue: p1.stampedValue,
          stampedTariff: p1.stampedTariff ?? financials.appliedTariff,
          stampedAmountBrl: p1.stampedAmountBrl ?? financials.calculatedAmountBrl,
          capturedAt: p1.capturedAt,
          sizeBytes: p1.sizeBytes,
        });
        photosCount++;
      }

      const p2 = photosMap.get('2');
      if (p2) {
        const safeName = `T${formatTowerNumber(tower)}_A${apt}_${service.toUpperCase()}_F2_${p2.auditCode}.jpg`;
        photosFolder.file(safeName, p2.stampedBlob);
        photoLinks.push({
          slot: 2,
          fileName: `photos/${safeName}`,
          auditCode: p2.auditCode,
          stampedValue: p2.stampedValue,
          stampedTariff: p2.stampedTariff ?? financials.appliedTariff,
          stampedAmountBrl: p2.stampedAmountBrl ?? financials.calculatedAmountBrl,
          capturedAt: p2.capturedAt,
          sizeBytes: p2.sizeBytes,
        });
        photosCount++;
      }

      manifestReadings.push({
        unitId: reading.id,
        cycleId: reading.cycleId,
        service: reading.service,
        tower: reading.tower,
        apartment: reading.apartment,
        previousValue: reading.previousValue,
        currentValue: reading.currentValue,
        consumption: reading.consumption,
        appliedTariff: financials.appliedTariff,
        calculatedAmountBrl: financials.calculatedAmountBrl,
        amountUnavailableReason: financials.amountUnavailableReason,
        referenceSource: reading.referenceSource,
        status: reading.status,
        alerts: reading.alerts,
        exceptionType: reading.exceptionType,
        observation: reading.observation,
        auditCode1: reading.auditCode1,
        auditCode2: reading.auditCode2,
        revision: reading.revision,
        revisionToken: reading.revisionToken,
        baseRevisionToken: reading.baseRevisionToken,
        createdByUid: reading.createdByUid,
        createdByName: reading.createdByName,
        createdAt: reading.createdAt,
        updatedByUid: reading.updatedByUid,
        updatedByName: reading.updatedByName,
        updatedAt: reading.updatedAt,
        photos: photoLinks,
      });
    }
  }

  const manifest: TowerBackupManifest = {
    manifestVersion: BACKUP_MANIFEST_VERSION,
    appName: 'SN - Leituras',
    condominiumId: CONDOMINIUM_ID,
    condominiumName: CONDOMINIUM_NAME,
    exportedAt: new Date().toISOString(),
    cycleId,
    service,
    towers,
    references: manifestReferences,
    readings: manifestReadings,
  };

  zip.file('manifest.json', JSON.stringify(manifest, null, 2));

  // Include conference CSV inside recovery ZIP
  const csvContent = buildExportCsv({
    cycleId,
    service,
    towers,
    referencesMap,
    readingsMap,
    fallbackTariffPerM3,
  });
  zip.file('relatorio_conferencia.csv', csvContent);

  const zipBlob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  const svcLabel = service === 'water' ? 'AGUA' : 'GAS';
  const towerLabel =
    towers.length === 1
      ? formatTowerCode(towers[0])
      : `T${formatTowerNumber(towers[0])}-T${formatTowerNumber(towers[towers.length - 1])}`;
  const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const fileName = `Backup_SN_Leituras_${cycleId}_${svcLabel}_${towerLabel}_${ts}.zip`;

  return {
    zipBlob,
    fileName,
    readingsCount: manifestReadings.length,
    photosCount,
  };
}

export interface RestoreBackupPreviewItem {
  entry: BackupManifestEntry;
  state: 'missing_locally' | 'identical_duplicate' | 'conflict_with_local';
  localReading?: ReadingRecord;
  missingPhotoFiles: string[];
}

export interface RestoreBackupPreview {
  valid: boolean;
  error?: string;
  manifest?: TowerBackupManifest;
  items: RestoreBackupPreviewItem[];
  missingLocallyCount: number;
  identicalDuplicateCount: number;
  conflictCount: number;
  missingPhotoFilesCount: number;
  referencesToRestoreCount: number;
}

/**
 * Inspects and validates a backup ZIP without mutating IndexedDB yet.
 * Detects missing units, exact duplicates (same value & auditCode1), and conflicts.
 */
export async function analyzeBackupZipForRestore(params: {
  mode: OperatingMode;
  zipFile: Blob;
}): Promise<{ preview: RestoreBackupPreview; zipInstance: JSZip | null }> {
  try {
    const zip = await JSZip.loadAsync(params.zipFile);
    const manifestFile = zip.file('manifest.json');
    if (!manifestFile) {
      return {
        preview: {
          valid: false,
          error: 'O arquivo ZIP não contém um manifest.json válido do SN - Leituras.',
          items: [],
          missingLocallyCount: 0,
          identicalDuplicateCount: 0,
          conflictCount: 0,
          missingPhotoFilesCount: 0,
          referencesToRestoreCount: 0,
        },
        zipInstance: null,
      };
    }

    const manifestText = await manifestFile.async('string');
    const manifest = JSON.parse(manifestText) as TowerBackupManifest;

    if (
      manifest.condominiumId !== CONDOMINIUM_ID ||
      !manifest.cycleId ||
      !Array.isArray(manifest.readings)
    ) {
      return {
        preview: {
          valid: false,
          error: 'Manifesto incompatível ou corrompido.',
          items: [],
          missingLocallyCount: 0,
          identicalDuplicateCount: 0,
          conflictCount: 0,
          missingPhotoFilesCount: 0,
          referencesToRestoreCount: 0,
        },
        zipInstance: null,
      };
    }

    const existingReadings = await getReadingsForCycleService(
      params.mode,
      manifest.cycleId,
      manifest.service
    );
    const existingReferences = await getReferencesForCycleService(
      params.mode,
      manifest.cycleId,
      manifest.service
    );

    let referencesToRestoreCount = 0;
    for (const ref of manifest.references || []) {
      const uid = buildUnitKey(
        manifest.cycleId,
        manifest.service,
        ref.tower,
        ref.apartment
      );
      if (!existingReferences.has(uid)) {
        referencesToRestoreCount++;
      }
    }

    const items: RestoreBackupPreviewItem[] = [];
    let missingLocallyCount = 0;
    let identicalDuplicateCount = 0;
    let conflictCount = 0;
    let missingPhotoFilesCount = 0;

    for (const entry of manifest.readings) {
      const missingPhotos: string[] = [];
      for (const p of entry.photos || []) {
        if (!zip.file(p.fileName)) {
          missingPhotos.push(p.fileName);
          missingPhotoFilesCount++;
        }
      }

      const local = existingReadings.get(entry.unitId);
      if (!local) {
        missingLocallyCount++;
        items.push({
          entry,
          state: 'missing_locally',
          missingPhotoFiles: missingPhotos,
        });
      } else {
        const isIdentical =
          local.currentValue === entry.currentValue &&
          local.auditCode1 === entry.auditCode1 &&
          local.auditCode2 === entry.auditCode2 &&
          local.observation === entry.observation;

        if (isIdentical) {
          identicalDuplicateCount++;
          items.push({
            entry,
            state: 'identical_duplicate',
            localReading: local,
            missingPhotoFiles: missingPhotos,
          });
        } else {
          conflictCount++;
          items.push({
            entry,
            state: 'conflict_with_local',
            localReading: local,
            missingPhotoFiles: missingPhotos,
          });
        }
      }
    }

    return {
      preview: {
        valid: true,
        manifest,
        items,
        missingLocallyCount,
        identicalDuplicateCount,
        conflictCount,
        missingPhotoFilesCount,
        referencesToRestoreCount,
      },
      zipInstance: zip,
    };
  } catch (err) {
    return {
      preview: {
        valid: false,
        error:
          err instanceof Error
            ? `Erro ao ler ZIP: ${err.message}`
            : 'Arquivo ZIP inválido.',
        items: [],
        missingLocallyCount: 0,
        identicalDuplicateCount: 0,
        conflictCount: 0,
        missingPhotoFilesCount: 0,
        referencesToRestoreCount: 0,
      },
      zipInstance: null,
    };
  }
}

function idbTxDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () =>
      reject(tx.error || new Error('Transação IndexedDB abortada.'));
  });
}

/**
 * Executes the backup restoration locally into IndexedDB first, with explicit subsequent sync.
 * By default (`restoreMode === 'missing_only'`), restores only missing records and never overwrites
 * existing readings or photos. When `preserveConflictsSideBySide` is enabled, records that differ
 * from local ones are attached as `conflictCandidate` with their photos in `conflict_1`/`conflict_2`
 * so neither version is lost!
 */
export async function executeBackupRestoreLocally(params: {
  mode: OperatingMode;
  preview: RestoreBackupPreview;
  zip: JSZip;
  includeConflictsAsSideBySide: boolean;
}): Promise<{
  restoredReadingsCount: number;
  restoredPhotosCount: number;
  skippedDuplicatesCount: number;
  flaggedConflictsCount: number;
  restoredReferencesCount: number;
}> {
  const { mode, preview, zip, includeConflictsAsSideBySide } = params;
  if (!preview.valid || !preview.manifest) {
    throw new Error('Prévia de backup inválida.');
  }

  const manifest = preview.manifest;
  const settings = await getOrInitCycleSettings(mode, manifest.cycleId);
  const existingRefs = await getReferencesForCycleService(
    mode,
    manifest.cycleId,
    manifest.service
  );

  // Pre-extract needed photo Blobs from ZIP before opening the IndexedDB write transaction
  const extractedPhotos = new Map<string, Blob>();
  for (const item of preview.items) {
    if (item.state === 'identical_duplicate') continue;
    if (item.state === 'conflict_with_local' && !includeConflictsAsSideBySide) {
      continue;
    }
    for (const p of item.entry.photos || []) {
      const f = zip.file(p.fileName);
      if (f) {
        const blob = await f.async('blob');
        extractedPhotos.set(
          `${item.entry.unitId}_${p.slot}`,
          new Blob([blob], { type: 'image/jpeg' })
        );
      }
    }
  }

  const db = await openLocalDatabase(mode);
  const tx = db.transaction(
    ['references', 'readings', 'photos', 'syncQueue'],
    'readwrite'
  );
  const refStore = tx.objectStore('references');
  const readStore = tx.objectStore('readings');
  const photoStore = tx.objectStore('photos');
  const queueStore = tx.objectStore('syncQueue');

  const nowIso = new Date().toISOString();
  let restoredReferencesCount = 0;

  for (const refEntry of manifest.references || []) {
    const unitId = buildUnitKey(
      manifest.cycleId,
      manifest.service,
      refEntry.tower,
      refEntry.apartment
    );
    if (!existingRefs.has(unitId)) {
      const refRec: ReferenceRecord = {
        id: unitId,
        cycleId: manifest.cycleId,
        service: manifest.service,
        tower: refEntry.tower,
        apartment: refEntry.apartment,
        previousValue: refEntry.previousValue,
        sourceFile: refEntry.sourceFile || 'backup_zip',
        importedAt: nowIso,
        importedByUid: 'backup_restore',
        importedByName: 'Restaurado via ZIP',
      };
      refStore.put(refRec);
      restoredReferencesCount++;
    }
  }

  let restoredReadingsCount = 0;
  let restoredPhotosCount = 0;
  let skippedDuplicatesCount = 0;
  let flaggedConflictsCount = 0;

  for (const item of preview.items) {
    const entry = item.entry;
    if (item.state === 'identical_duplicate') {
      skippedDuplicatesCount++;
      continue;
    }

    const evalRes = evaluateReading({
      service: entry.service,
      previousValue: entry.previousValue,
      currentValue: entry.currentValue,
      limits: settings,
      exceptionType: entry.exceptionType,
      tariffOverridePerM3: entry.appliedTariff !== undefined ? entry.appliedTariff : undefined,
    });

    const resolvedAppliedTariff =
      entry.appliedTariff !== undefined ? entry.appliedTariff : evalRes.appliedTariff;
    const resolvedCalculatedAmountBrl =
      entry.calculatedAmountBrl !== undefined
        ? entry.calculatedAmountBrl
        : evalRes.calculatedAmountBrl;
    const resolvedAmountUnavailableReason =
      entry.amountUnavailableReason !== undefined
        ? entry.amountUnavailableReason
        : evalRes.amountUnavailableReason;

    if (item.state === 'missing_locally') {
      const blob1 = extractedPhotos.get(`${entry.unitId}_1`) || null;
      const blob2 = extractedPhotos.get(`${entry.unitId}_2`) || null;

      let photo1Id: string | null = null;
      if (blob1) {
        const pMeta1 = entry.photos.find((p) => p.slot === 1);
        photo1Id = `${entry.unitId}_slot_1`;
        const pRec1: PhotoRecord = {
          id: photo1Id,
          readingId: entry.unitId,
          slot: '1',
          stampedBlob: blob1,
          fileName: pMeta1?.fileName.replace('photos/', '') || `${entry.unitId}_F1.jpg`,
          mimeType: 'image/jpeg',
          sizeBytes: blob1.size,
          width: 1024,
          height: 768,
          auditCode: pMeta1?.auditCode || entry.auditCode1,
          stampedValue: entry.currentValue,
          stampedTariff: pMeta1?.stampedTariff ?? resolvedAppliedTariff,
          stampedAmountBrl: pMeta1?.stampedAmountBrl ?? resolvedCalculatedAmountBrl,
          capturedAt: pMeta1?.capturedAt || entry.updatedAt,
        };
        photoStore.put(pRec1);
        restoredPhotosCount++;
      }

      let photo2Id: string | null = null;
      if (blob2) {
        const pMeta2 = entry.photos.find((p) => p.slot === 2);
        photo2Id = `${entry.unitId}_slot_2`;
        const pRec2: PhotoRecord = {
          id: photo2Id,
          readingId: entry.unitId,
          slot: '2',
          stampedBlob: blob2,
          fileName: pMeta2?.fileName.replace('photos/', '') || `${entry.unitId}_F2.jpg`,
          mimeType: 'image/jpeg',
          sizeBytes: blob2.size,
          width: 1024,
          height: 768,
          auditCode: pMeta2?.auditCode || entry.auditCode2,
          stampedValue: entry.currentValue,
          stampedTariff: pMeta2?.stampedTariff ?? resolvedAppliedTariff,
          stampedAmountBrl: pMeta2?.stampedAmountBrl ?? resolvedCalculatedAmountBrl,
          capturedAt: pMeta2?.capturedAt || entry.updatedAt,
        };
        photoStore.put(pRec2);
        restoredPhotosCount++;
      }

      const revToken = entry.revisionToken || generateRevisionToken(entry.updatedByUid);

      const newReading: ReadingRecord = {
        id: entry.unitId,
        condominiumId: CONDOMINIUM_ID,
        cycleId: entry.cycleId,
        service: entry.service,
        tower: entry.tower,
        apartment: entry.apartment,
        previousValue: entry.previousValue,
        currentValue: entry.currentValue,
        consumption: evalRes.consumption,
        appliedTariff: resolvedAppliedTariff,
        calculatedAmountBrl: resolvedCalculatedAmountBrl,
        amountUnavailableReason: resolvedAmountUnavailableReason,
        referenceSource: evalRes.referenceSource,
        status: evalRes.status,
        alerts: evalRes.alerts,
        exceptionType: entry.exceptionType,
        observation: entry.observation,
        photo1Id,
        photo2Id,
        auditCode1: entry.auditCode1,
        auditCode2: entry.auditCode2,
        syncStatus: 'local_only',
        revision: 1,
        revisionToken: revToken,
        baseRevisionToken: '',
        createdByUid: entry.createdByUid || 'restaurado',
        createdByName: entry.createdByName || 'Backup ZIP',
        createdAt: entry.createdAt || nowIso,
        updatedByUid: entry.updatedByUid || 'restaurado',
        updatedByName: entry.updatedByName || 'Backup ZIP',
        updatedAt: entry.updatedAt || nowIso,
      };

      readStore.put(newReading);
      restoredReadingsCount++;

      // Queue for subsequent explicit synchronization
      if (mode === 'real') {
        const qItem: SyncQueueItem = {
          id: `readings__${entry.unitId}`,
          targetCollection: 'readings',
          docId: entry.unitId,
          cycleId: entry.cycleId,
          expectedOperation: 'create',
          revision: 1,
          baseRevisionToken: '',
          attempts: 0,
          queuedAt: nowIso,
        };
        queueStore.put(qItem);
      }
    } else if (
      item.state === 'conflict_with_local' &&
      includeConflictsAsSideBySide &&
      item.localReading
    ) {
      // Preserve existing local record AND attach the ZIP version + photos as conflictCandidate
      const blob1 = extractedPhotos.get(`${entry.unitId}_1`) || null;
      const blob2 = extractedPhotos.get(`${entry.unitId}_2`) || null;

      let conflictPhoto1Id: string | null = null;
      if (blob1) {
        const pMeta1 = entry.photos.find((p) => p.slot === 1);
        conflictPhoto1Id = `${entry.unitId}_slot_conflict_1`;
        photoStore.put({
          id: conflictPhoto1Id,
          readingId: entry.unitId,
          slot: 'conflict_1',
          stampedBlob: blob1,
          fileName: pMeta1?.fileName.replace('photos/', '') || `${entry.unitId}_CF1.jpg`,
          mimeType: 'image/jpeg',
          sizeBytes: blob1.size,
          width: 1024,
          height: 768,
          auditCode: pMeta1?.auditCode || entry.auditCode1,
          stampedValue: entry.currentValue,
          stampedTariff: pMeta1?.stampedTariff ?? resolvedAppliedTariff,
          stampedAmountBrl: pMeta1?.stampedAmountBrl ?? resolvedCalculatedAmountBrl,
          capturedAt: pMeta1?.capturedAt || entry.updatedAt,
        } satisfies PhotoRecord);
        restoredPhotosCount++;
      }

      let conflictPhoto2Id: string | null = null;
      if (blob2) {
        const pMeta2 = entry.photos.find((p) => p.slot === 2);
        conflictPhoto2Id = `${entry.unitId}_slot_conflict_2`;
        photoStore.put({
          id: conflictPhoto2Id,
          readingId: entry.unitId,
          slot: 'conflict_2',
          stampedBlob: blob2,
          fileName: pMeta2?.fileName.replace('photos/', '') || `${entry.unitId}_CF2.jpg`,
          mimeType: 'image/jpeg',
          sizeBytes: blob2.size,
          width: 1024,
          height: 768,
          auditCode: pMeta2?.auditCode || entry.auditCode2,
          stampedValue: entry.currentValue,
          stampedTariff: pMeta2?.stampedTariff ?? resolvedAppliedTariff,
          stampedAmountBrl: pMeta2?.stampedAmountBrl ?? resolvedCalculatedAmountBrl,
          capturedAt: pMeta2?.capturedAt || entry.updatedAt,
        } satisfies PhotoRecord);
        restoredPhotosCount++;
      }

      const zipCandidate: ConflictReadingVersion = {
        source: 'local',
        previousValue: entry.previousValue,
        currentValue: entry.currentValue,
        consumption: entry.consumption,
        appliedTariff: resolvedAppliedTariff,
        calculatedAmountBrl: resolvedCalculatedAmountBrl,
        amountUnavailableReason: resolvedAmountUnavailableReason,
        status: entry.status,
        alerts: entry.alerts,
        exceptionType: entry.exceptionType,
        observation: entry.observation,
        auditCode1: entry.auditCode1,
        auditCode2: entry.auditCode2,
        photo1Id: conflictPhoto1Id,
        photo2Id: conflictPhoto2Id,
        revision: entry.revision || 1,
        revisionToken:
          entry.revisionToken || generateRevisionToken(entry.updatedByUid),
        baseRevisionToken: entry.baseRevisionToken || '',
        createdByUid: entry.createdByUid,
        createdByName: entry.createdByName,
        createdAt: entry.createdAt,
        updatedByUid: entry.updatedByUid,
        updatedByName: entry.updatedByName,
        updatedAt: entry.updatedAt,
      };

      readStore.put({
        ...item.localReading,
        syncStatus: 'conflict',
        conflictCandidate: zipCandidate,
      });
      flaggedConflictsCount++;
    }
  }

  await idbTxDone(tx);

  return {
    restoredReadingsCount,
    restoredPhotosCount,
    skippedDuplicatesCount,
    flaggedConflictsCount,
    restoredReferencesCount,
  };
}

export function triggerBlobDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
