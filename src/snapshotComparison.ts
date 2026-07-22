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
  const [beforeMetadata, afterMetadata] = await Promise.all([
    store.loadMetadata(beforeId),
    store.loadMetadata(afterId)
  ]);
  const summary = compareTableSnapshotMetadata(beforeMetadata, afterMetadata);
  if (!summary.changed || !summary.rowClassificationAvailable) {
    return summary;
  }
  if (exceedsDetailLimit(beforeMetadata, limits) || exceedsDetailLimit(afterMetadata, limits)) {
    return compareTableSnapshotMetadata(beforeMetadata, afterMetadata, "detail-limit");
  }
  const [before, after] = await Promise.all([store.load(beforeId), store.load(afterId)]);
  return compareTableSnapshots(before, after);
}

function exceedsDetailLimit(snapshot: TableSnapshotMetadata, limits: SnapshotComparisonLimits): boolean {
  if (snapshot.rowCount > limits.maxDetailRowsPerSnapshot) {
    return true;
  }
  const storageBytes = "storageBytes" in snapshot && typeof snapshot.storageBytes === "number"
    ? snapshot.storageBytes
    : 0;
  return storageBytes > limits.maxDetailBytesPerSnapshot;
}
