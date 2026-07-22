import { SnapshotStore } from "./snapshotStore";
import { createTableSnapshot, SnapshotDescriptor, TableSnapshotMetadata } from "./tableDiff";
import { ConnectionProfile, DbObject, ObjectData, ObjectInfo } from "./types";

export interface SnapshotCaptureLimits {
  pageSize: number;
  maxRows: number;
  maxBytes: number;
}

export interface SnapshotCaptureProgress {
  rowCount: number;
  storageBytes: number;
  chunkCount: number;
}

export interface SnapshotCaptureOptions {
  store: SnapshotStore;
  profile: Pick<ConnectionProfile, "id" | "name">;
  object: DbObject;
  info: ObjectInfo;
  indexed: boolean;
  limits: SnapshotCaptureLimits;
  loadPage: (offset: number, limit: number) => Promise<ObjectData>;
  isCancellationRequested?: () => boolean;
  onProgress?: (progress: SnapshotCaptureProgress) => void;
}

export async function captureChunkedTableSnapshot(
  options: SnapshotCaptureOptions
): Promise<SnapshotDescriptor | undefined> {
  validateLimits(options.limits);
  let offset = 0;
  let writer: Awaited<ReturnType<SnapshotStore["beginChunkedSnapshot"]>> | undefined;
  let template: TableSnapshotMetadata | undefined;

  try {
    while (!options.isCancellationRequested?.()) {
      const page = await options.loadPage(offset, options.limits.pageSize);
      const projected = createTableSnapshot(
        options.profile,
        options.object,
        options.info,
        page,
        template ? { id: template.id, createdAt: template.createdAt } : undefined
      );
      if (!template) {
        const { rows: _rows, ...metadata } = projected;
        template = metadata;
        writer = await options.store.beginChunkedSnapshot(template, {
          indexed: options.indexed,
          maxBytes: options.limits.maxBytes,
          pageSize: options.limits.pageSize
        });
      } else if (!sameSnapshotShape(template, projected)) {
        throw new Error("スナップショット取得中にTableの列または主キー構成が変化しました。");
      }
      if (!writer) {
        throw new Error("スナップショット書き込みを開始できませんでした。");
      }
      const nextRowCount = writer.progress.rowCount + projected.rows.length;
      if (nextRowCount > options.limits.maxRows
        || (nextRowCount === options.limits.maxRows && page.hasNext)) {
        throw new Error(`スナップショット行数が安全上限 ${options.limits.maxRows.toLocaleString()} 行を超えています。`);
      }
      await writer.appendRows(projected.rows);
      options.onProgress?.(writer.progress);
      if (!page.hasNext || page.rows.length === 0) {
        break;
      }
      offset += page.rows.length;
    }

    if (options.isCancellationRequested?.()) {
      await writer?.abort();
      return undefined;
    }
    if (!writer) {
      throw new Error("スナップショットを作成できませんでした。");
    }
    return await writer.complete();
  } catch (error) {
    await writer?.abort();
    throw error;
  }
}

function validateLimits(limits: SnapshotCaptureLimits): void {
  if (!Number.isSafeInteger(limits.pageSize) || limits.pageSize <= 0) {
    throw new Error("スナップショットページサイズは1以上の整数で指定してください。");
  }
  if (!Number.isSafeInteger(limits.maxRows) || limits.maxRows < 0) {
    throw new Error("スナップショット行数上限は0以上の整数で指定してください。");
  }
  if (!Number.isFinite(limits.maxBytes) || limits.maxBytes <= 0) {
    throw new Error("スナップショット容量上限は1 byte以上で指定してください。");
  }
}

function sameSnapshotShape(left: TableSnapshotMetadata, right: TableSnapshotMetadata): boolean {
  return JSON.stringify(left.columns) === JSON.stringify(right.columns)
    && JSON.stringify(left.columnTypes) === JSON.stringify(right.columnTypes)
    && JSON.stringify(left.primaryKeys) === JSON.stringify(right.primaryKeys)
    && JSON.stringify(left.excludedColumns) === JSON.stringify(right.excludedColumns);
}
