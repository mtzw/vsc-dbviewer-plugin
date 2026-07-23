import { SnapshotStore } from "./snapshotStore";
import { compareTableSnapshotMetadata, compareTableSnapshots, TableDiff, TableSnapshotMetadata } from "./tableDiff";

export interface SnapshotComparisonLimits {
  maxDetailRowsPerSnapshot: number;
  maxDetailBytesPerSnapshot: number;
}

export async function compareStoredSnapshots(
  store: SnapshotStore,
  beforeId: string,
  afterId: string,
  limits: SnapshotComparisonLimits
): Promise<TableDiff> {
  validateLimits(limits);
  const [beforeMetadata, afterMetadata] = await Promise.all([
    store.loadMetadata(beforeId),
    store.loadMetadata(afterId)
  ]);
  const summary = compareTableSnapshotMetadata(beforeMetadata, afterMetadata);
  if (!summary.changed || !summary.rowClassificationAvailable) {
    await Promise.all([
      store.verifyIntegrity(beforeId, beforeMetadata),
      store.verifyIntegrity(afterId, afterMetadata)
    ]);
    return summary;
  }
  const [beforeStorageBytes, afterStorageBytes] = await Promise.all([
    store.storageBytes(beforeId, beforeMetadata),
    store.storageBytes(afterId, afterMetadata)
  ]);
  if (exceedsDetailLimit(beforeMetadata, beforeStorageBytes, limits)
    || exceedsDetailLimit(afterMetadata, afterStorageBytes, limits)) {
    await Promise.all([
      store.verifyIntegrity(beforeId, beforeMetadata),
      store.verifyIntegrity(afterId, afterMetadata)
    ]);
    return compareTableSnapshotMetadata(beforeMetadata, afterMetadata, "detail-limit");
  }
  const [before, after] = await Promise.all([store.load(beforeId), store.load(afterId)]);
  return compareTableSnapshots(before, after);
}

function exceedsDetailLimit(
  snapshot: TableSnapshotMetadata,
  storageBytes: number,
  limits: SnapshotComparisonLimits
): boolean {
  if (snapshot.rowCount > limits.maxDetailRowsPerSnapshot) {
    return true;
  }
  return storageBytes > limits.maxDetailBytesPerSnapshot;
}

function validateLimits(limits: SnapshotComparisonLimits): void {
  if (!Number.isSafeInteger(limits.maxDetailRowsPerSnapshot) || limits.maxDetailRowsPerSnapshot < 0) {
    throw new Error("差分詳細の行数上限は0以上の整数で指定してください。");
  }
  if (!Number.isSafeInteger(limits.maxDetailBytesPerSnapshot) || limits.maxDetailBytesPerSnapshot < 0) {
    throw new Error("差分詳細の容量上限は0 byte以上の整数で指定してください。");
  }
}
