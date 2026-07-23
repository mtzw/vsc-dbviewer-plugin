import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { DbObject } from "./types";
import {
  fingerprintSnapshotRows,
  SnapshotCell,
  SnapshotDescriptor,
  SnapshotFingerprintBuilder,
  TableSnapshot,
  TableSnapshotMetadata,
  toSnapshotDescriptor
} from "./tableDiff";

interface SnapshotIndex {
  formatVersion: 1;
  snapshots: SnapshotDescriptor[];
}

export interface SnapshotChunkDescriptor {
  fileName: string;
  rowCount: number;
  byteLength: number;
  contentHash: string;
}

export interface ChunkedSnapshotManifest extends TableSnapshotMetadata {
  formatVersion: 2;
  fingerprintAlgorithm: "sha256-multiset-v1";
  chunks: SnapshotChunkDescriptor[];
  storageBytes: number;
  pageSize: number;
  consistency: "best-effort";
  indexed: boolean;
  completedAt: string;
}

export interface ChunkedSnapshotOptions {
  indexed: boolean;
  maxBytes: number;
  pageSize: number;
}

const EMPTY_INDEX: SnapshotIndex = { formatVersion: 1, snapshots: [] };
const indexMutationTails = new Map<string, Promise<void>>();

export class SnapshotStore {
  constructor(private readonly rootDirectory: string) {}

  async save(snapshot: TableSnapshot): Promise<SnapshotDescriptor> {
    validateSnapshot(snapshot);
    const normalized = { ...snapshot, contentFingerprint: fingerprintSnapshotRows(snapshot.rows) };
    await fs.mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(this.snapshotPath(snapshot.id), normalized);
    const descriptor = toSnapshotDescriptor(normalized, { storageFormat: "single-file" });
    try {
      await this.upsertDescriptor(descriptor);
      return descriptor;
    } catch (error) {
      await removeIfExists(this.snapshotPath(snapshot.id));
      throw error;
    }
  }

  async beginChunkedSnapshot(
    template: TableSnapshotMetadata,
    options: ChunkedSnapshotOptions
  ): Promise<ChunkedSnapshotWriter> {
    validateId(template.id);
    if (!Number.isFinite(options.maxBytes) || options.maxBytes <= 0) {
      throw new Error("スナップショット容量上限は1 byte以上で指定してください。");
    }
    const temporaryDirectory = this.temporarySnapshotDirectory(template.id);
    await fs.mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
    await fs.mkdir(temporaryDirectory, { recursive: true, mode: 0o700 });
    return new ChunkedSnapshotWriter(
      template,
      temporaryDirectory,
      options,
      async (manifest) => this.finalizeChunkedSnapshot(manifest, temporaryDirectory, options.indexed),
      async () => fs.rm(temporaryDirectory, { recursive: true, force: true })
    );
  }

  async list(profileId?: string, object?: DbObject): Promise<SnapshotDescriptor[]> {
    const index = await this.readIndex();
    return index.snapshots.filter((snapshot) =>
      (!profileId || snapshot.profileId === profileId)
      && (!object || sameObject(snapshot.object, object))
    );
  }

  async loadMetadata(id: string): Promise<TableSnapshotMetadata> {
    validateId(id);
    try {
      const content = await fs.readFile(path.join(this.snapshotDirectory(id), "manifest.json"), "utf8");
      const manifest = JSON.parse(content) as ChunkedSnapshotManifest;
      validateManifest(manifest);
      if (manifest.id !== id) {
        throw new Error("チャンク型スナップショットのIDが保存先と一致しません。");
      }
      return manifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const snapshot = await this.loadSingleFile(id);
    return snapshot;
  }

  async load(id: string): Promise<TableSnapshot> {
    const metadata = await this.loadMetadata(id);
    if (metadata.formatVersion === 1) {
      return metadata as TableSnapshot;
    }
    const rows: SnapshotCell[][] = [];
    for await (const chunkRows of this.readChunkRows(id, metadata as ChunkedSnapshotManifest)) {
      rows.push(...chunkRows);
    }
    const contentFingerprint = fingerprintSnapshotRows(rows);
    if (contentFingerprint !== metadata.contentFingerprint) {
      throw new Error("スナップショットの内容フィンガープリントが一致しません。マニフェストが破損しています。");
    }
    return {
      ...metadata,
      formatVersion: 1,
      rows,
      rowCount: rows.length,
      contentFingerprint
    };
  }

  async *readChunks(id: string): AsyncGenerator<SnapshotCell[][]> {
    const metadata = await this.loadMetadata(id);
    if (metadata.formatVersion === 1) {
      yield (metadata as TableSnapshot).rows;
      return;
    }
    yield* this.readChunkRows(id, metadata as ChunkedSnapshotManifest);
  }

  async verifyIntegrity(id: string, metadata?: TableSnapshotMetadata): Promise<void> {
    const current = metadata ?? await this.loadMetadata(id);
    if (current.formatVersion === 1) {
      return;
    }
    const manifest = current as ChunkedSnapshotManifest;
    const fingerprint = new SnapshotFingerprintBuilder();
    for await (const rows of this.readChunkRows(id, manifest)) {
      fingerprint.addRows(rows);
    }
    if (fingerprint.digest() !== manifest.contentFingerprint) {
      throw new Error("スナップショットの内容フィンガープリントが一致しません。マニフェストが破損しています。");
    }
  }

  async storageBytes(id: string, metadata?: TableSnapshotMetadata): Promise<number> {
    const current = metadata ?? await this.loadMetadata(id);
    if (current.formatVersion === 2) {
      return (current as ChunkedSnapshotManifest).storageBytes;
    }
    return (await fs.stat(this.snapshotPath(id))).size;
  }

  async delete(id: string): Promise<boolean> {
    validateId(id);
    return withIndexMutation(this.rootDirectory, async () => {
      const index = await this.readIndex();
      const existed = index.snapshots.some((snapshot) => snapshot.id === id);
      await Promise.all([
        removeIfExists(this.snapshotPath(id)),
        fs.rm(this.snapshotDirectory(id), { recursive: true, force: true }),
        fs.rm(this.temporarySnapshotDirectory(id), { recursive: true, force: true })
      ]);
      if (existed) {
        index.snapshots = index.snapshots.filter((snapshot) => snapshot.id !== id);
        await this.writeIndex(index);
      }
      return existed;
    });
  }

  async prune(retentionDays: number, now = new Date()): Promise<number> {
    if (!Number.isFinite(retentionDays) || retentionDays < 0) {
      throw new Error("保存期間は0以上の日数で指定してください。");
    }
    await this.cleanupIncomplete(24, now);
    return withIndexMutation(this.rootDirectory, async () => {
      const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;
      const index = await this.readIndex();
      const expired = index.snapshots.filter((snapshot) => {
        const createdAt = Date.parse(snapshot.createdAt);
        return !Number.isFinite(createdAt) || createdAt < cutoff;
      });
      for (const snapshot of expired) {
        await Promise.all([
          removeIfExists(this.snapshotPath(snapshot.id)),
          fs.rm(this.snapshotDirectory(snapshot.id), { recursive: true, force: true })
        ]);
      }
      if (expired.length > 0) {
        const expiredIds = new Set(expired.map((snapshot) => snapshot.id));
        index.snapshots = index.snapshots.filter((snapshot) => !expiredIds.has(snapshot.id));
        await this.writeIndex(index);
      }
      return expired.length;
    });
  }

  async cleanupIncomplete(retentionHours: number, now = new Date()): Promise<number> {
    if (!Number.isFinite(retentionHours) || retentionHours < 0) {
      throw new Error("不完全データの保存期間は0以上の時間で指定してください。");
    }
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(this.rootDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return 0;
      }
      throw error;
    }
    const cutoff = now.getTime() - retentionHours * 60 * 60 * 1000;
    let removed = 0;
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const directory = path.join(this.rootDirectory, entry.name);
      const stat = await fs.stat(directory);
      const isIncomplete = entry.name.startsWith(".capture-");
      const isTemporary = !isIncomplete && await isTemporarySnapshotDirectory(directory);
      if ((isIncomplete || isTemporary) && stat.mtimeMs < cutoff) {
        await fs.rm(directory, { recursive: true, force: true });
        removed += 1;
      }
    }
    return removed;
  }

  private snapshotPath(id: string): string {
    return path.join(this.rootDirectory, `${id}.json`);
  }

  private snapshotDirectory(id: string): string {
    return path.join(this.rootDirectory, id);
  }

  private temporarySnapshotDirectory(id: string): string {
    return path.join(this.rootDirectory, `.capture-${id}`);
  }

  private async *readChunkRows(
    id: string,
    manifest: ChunkedSnapshotManifest
  ): AsyncGenerator<SnapshotCell[][]> {
    for (const chunk of manifest.chunks) {
      const content = await this.readChunkContent(id, chunk);
      let rows: unknown;
      try {
        rows = JSON.parse(content);
      } catch (error) {
        throw new Error(`スナップショットチャンク ${chunk.fileName} のJSONが不正です: ${(error as Error).message}`);
      }
      validateChunkRows(rows, chunk, manifest.columns.length);
      yield rows;
    }
  }

  private async readChunkContent(id: string, chunk: SnapshotChunkDescriptor): Promise<string> {
    let content: string;
    try {
      content = await fs.readFile(path.join(this.snapshotDirectory(id), chunk.fileName), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`スナップショットチャンク ${chunk.fileName} が見つかりません。`);
      }
      throw error;
    }
    if (Buffer.byteLength(content, "utf8") !== chunk.byteLength) {
      throw new Error(`スナップショットチャンク ${chunk.fileName} の容量が一致しません。`);
    }
    const contentHash = createHash("sha256").update(content).digest("hex");
    if (contentHash !== chunk.contentHash) {
      throw new Error(`スナップショットチャンク ${chunk.fileName} が破損しています。`);
    }
    return content;
  }

  private async loadSingleFile(id: string): Promise<TableSnapshot> {
    const content = await fs.readFile(this.snapshotPath(id), "utf8");
    const snapshot = JSON.parse(content) as TableSnapshot;
    validateSnapshot(snapshot);
    if (snapshot.id !== id) {
      throw new Error("単一ファイル型スナップショットのIDがファイル名と一致しません。");
    }
    const contentFingerprint = fingerprintSnapshotRows(snapshot.rows);
    if (contentFingerprint !== snapshot.contentFingerprint) {
      throw new Error("スナップショットの内容フィンガープリントが一致しません。単一ファイルが破損しています。");
    }
    return snapshot;
  }

  private async finalizeChunkedSnapshot(
    manifest: ChunkedSnapshotManifest,
    temporaryDirectory: string,
    indexed: boolean
  ): Promise<SnapshotDescriptor> {
    const targetDirectory = this.snapshotDirectory(manifest.id);
    await writeJsonAtomic(path.join(temporaryDirectory, "manifest.json"), manifest);
    await fs.rm(targetDirectory, { recursive: true, force: true });
    await fs.rename(temporaryDirectory, targetDirectory);
    const descriptor = toSnapshotDescriptor(manifest, {
      storageFormat: "chunked",
      storageBytes: manifest.storageBytes,
      chunkCount: manifest.chunks.length
    });
    try {
      if (indexed) {
        await this.upsertDescriptor(descriptor);
      }
      return descriptor;
    } catch (error) {
      await fs.rm(targetDirectory, { recursive: true, force: true });
      throw error;
    }
  }

  private async upsertDescriptor(descriptor: SnapshotDescriptor): Promise<void> {
    await withIndexMutation(this.rootDirectory, async () => {
      const index = await this.readIndex();
      index.snapshots = [descriptor, ...index.snapshots.filter((current) => current.id !== descriptor.id)]
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      await this.writeIndex(index);
    });
  }

  private async readIndex(): Promise<SnapshotIndex> {
    try {
      const content = await fs.readFile(path.join(this.rootDirectory, "index.json"), "utf8");
      const parsed = JSON.parse(content) as SnapshotIndex;
      if (parsed.formatVersion !== 1 || !Array.isArray(parsed.snapshots)) {
        throw new Error("スナップショット索引の形式に対応していません。");
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { ...EMPTY_INDEX, snapshots: [] };
      }
      throw error;
    }
  }

  private async writeIndex(index: SnapshotIndex): Promise<void> {
    await fs.mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(path.join(this.rootDirectory, "index.json"), index);
  }
}

export class ChunkedSnapshotWriter {
  private readonly chunks: SnapshotChunkDescriptor[] = [];
  private readonly fingerprint = new SnapshotFingerprintBuilder();
  private rowCount = 0;
  private storageBytes = 0;
  private closed = false;

  constructor(
    private readonly template: TableSnapshotMetadata,
    private readonly directory: string,
    private readonly options: ChunkedSnapshotOptions,
    private readonly finalize: (manifest: ChunkedSnapshotManifest) => Promise<SnapshotDescriptor>,
    private readonly cleanup: () => Promise<void>
  ) {}

  async appendRows(rows: SnapshotCell[][]): Promise<void> {
    this.assertOpen();
    if (rows.length === 0) {
      return;
    }
    const content = `${JSON.stringify(rows)}\n`;
    const byteLength = Buffer.byteLength(content, "utf8");
    if (this.storageBytes + byteLength > this.options.maxBytes) {
      throw new Error(`スナップショット容量が上限 ${formatBytes(this.options.maxBytes)} を超えました。`);
    }
    const fileName = `chunk-${String(this.chunks.length).padStart(6, "0")}.json`;
    await fs.writeFile(path.join(this.directory, fileName), content, { encoding: "utf8", mode: 0o600 });
    this.chunks.push({
      fileName,
      rowCount: rows.length,
      byteLength,
      contentHash: createHash("sha256").update(content).digest("hex")
    });
    this.fingerprint.addRows(rows);
    this.rowCount += rows.length;
    this.storageBytes += byteLength;
  }

  async complete(): Promise<SnapshotDescriptor> {
    this.assertOpen();
    const manifest: ChunkedSnapshotManifest = {
      ...this.template,
      formatVersion: 2,
      rowCount: this.rowCount,
      contentFingerprint: this.fingerprint.digest(),
      fingerprintAlgorithm: "sha256-multiset-v1",
      chunks: this.chunks,
      storageBytes: this.storageBytes,
      pageSize: this.options.pageSize,
      consistency: "best-effort",
      indexed: this.options.indexed,
      completedAt: new Date().toISOString()
    };
    try {
      const descriptor = await this.finalize(manifest);
      this.closed = true;
      return descriptor;
    } catch (error) {
      this.closed = true;
      await this.cleanup();
      throw error;
    }
  }

  async abort(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.cleanup();
  }

  get progress(): { rowCount: number; storageBytes: number; chunkCount: number } {
    return { rowCount: this.rowCount, storageBytes: this.storageBytes, chunkCount: this.chunks.length };
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("スナップショット書き込みは既に終了しています。");
    }
  }
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(temporary, target);
  } finally {
    await removeIfExists(temporary);
  }
}

async function removeIfExists(target: string): Promise<void> {
  try {
    await fs.unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

function validateId(id: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error("スナップショットIDが不正です。");
  }
}

function validateSnapshot(snapshot: TableSnapshot): void {
  if (!snapshot || typeof snapshot !== "object"
    || snapshot.formatVersion !== 1
    || !Array.isArray(snapshot.rows)) {
    throw new Error("スナップショット形式に対応していません。");
  }
  validateId(snapshot.id);
  validateMetadata(snapshot);
  if (snapshot.rowCount !== snapshot.rows.length) {
    throw new Error("スナップショットの行数が一致しません。");
  }
  validateRows(snapshot.rows, snapshot.columns.length, "単一ファイル型スナップショット");
}

function validateManifest(manifest: ChunkedSnapshotManifest): void {
  if (!manifest || typeof manifest !== "object"
    || manifest.formatVersion !== 2
    || manifest.fingerprintAlgorithm !== "sha256-multiset-v1"
    || !Array.isArray(manifest.chunks)) {
    throw new Error("チャンク型スナップショット形式に対応していません。");
  }
  validateId(manifest.id);
  validateMetadata(manifest);
  if (!Number.isSafeInteger(manifest.pageSize) || manifest.pageSize <= 0
    || manifest.consistency !== "best-effort"
    || typeof manifest.indexed !== "boolean"
    || !isIsoDate(manifest.completedAt)) {
    throw new Error("チャンク型スナップショットのマニフェストが不正です。");
  }
  const fileNames = new Set<string>();
  let rowCount = 0;
  let storageBytes = 0;
  for (const [index, chunk] of manifest.chunks.entries()) {
    if (!chunk || typeof chunk !== "object"
      || chunk.fileName !== `chunk-${String(index).padStart(6, "0")}.json`
      || fileNames.has(chunk.fileName)
      || !Number.isSafeInteger(chunk.rowCount)
      || chunk.rowCount <= 0
      || !Number.isSafeInteger(chunk.byteLength)
      || chunk.byteLength <= 0
      || !isSha256(chunk.contentHash)) {
      throw new Error("チャンク型スナップショットの索引が不正です。");
    }
    fileNames.add(chunk.fileName);
    rowCount += chunk.rowCount;
    storageBytes += chunk.byteLength;
    if (!Number.isSafeInteger(rowCount) || !Number.isSafeInteger(storageBytes)) {
      throw new Error("チャンク型スナップショットの行数または容量が不正です。");
    }
  }
  if (rowCount !== manifest.rowCount || storageBytes !== manifest.storageBytes) {
    throw new Error("チャンク型スナップショットの行数または容量が一致しません。");
  }
}

function validateMetadata(metadata: TableSnapshotMetadata): void {
  if (typeof metadata.profileId !== "string"
    || typeof metadata.profileName !== "string"
    || !isIsoDate(metadata.createdAt)
    || !isDbObject(metadata.object)
    || !isStringArray(metadata.columns)
    || !Array.isArray(metadata.columnTypes)
    || metadata.columnTypes.length !== metadata.columns.length
    || !metadata.columnTypes.every(isColumnType)
    || !isStringArray(metadata.primaryKeys)
    || !isStringArray(metadata.excludedColumns)
    || !Number.isSafeInteger(metadata.rowCount)
    || metadata.rowCount < 0
    || !isSha256(metadata.contentFingerprint)) {
    throw new Error("スナップショットのマニフェストが不正です。");
  }
  const columns = new Set(metadata.columns.map(normalize));
  if (columns.size !== metadata.columns.length
    || metadata.columnTypes.some((column, index) => normalize(column.name) !== normalize(metadata.columns[index]))) {
    throw new Error("スナップショットの列構成が不正です。");
  }
  const primaryKeys = new Set(metadata.primaryKeys.map(normalize));
  const excludedColumns = new Set(metadata.excludedColumns.map(normalize));
  if (primaryKeys.size !== metadata.primaryKeys.length
    || metadata.primaryKeys.some((column) => !columns.has(normalize(column)))) {
    throw new Error("スナップショットの主キー構成が不正です。");
  }
  if (excludedColumns.size !== metadata.excludedColumns.length
    || metadata.excludedColumns.some((column) => columns.has(normalize(column)))) {
    throw new Error("スナップショットの除外列構成が不正です。");
  }
}

function validateChunkRows(
  value: unknown,
  chunk: SnapshotChunkDescriptor,
  columnCount: number
): asserts value is SnapshotCell[][] {
  if (!Array.isArray(value) || value.length !== chunk.rowCount) {
    throw new Error(`スナップショットチャンク ${chunk.fileName} の行数が一致しません。`);
  }
  validateRows(value, columnCount, `スナップショットチャンク ${chunk.fileName}`);
}

function validateRows(rows: unknown[], columnCount: number, label: string): asserts rows is SnapshotCell[][] {
  for (const row of rows) {
    if (!Array.isArray(row)
      || row.length !== columnCount
      || row.some((cell) => !isSnapshotCell(cell))) {
      throw new Error(`${label} の行データ形式が不正です。`);
    }
  }
}

function isSnapshotCell(value: unknown): value is SnapshotCell {
  return value === null
    || typeof value === "string"
    || typeof value === "boolean"
    || (typeof value === "number" && Number.isFinite(value));
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isColumnType(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const column = value as Record<string, unknown>;
  return typeof column.name === "string"
    && (column.typeName === null || typeof column.typeName === "string")
    && (column.jdbcType === null || Number.isSafeInteger(column.jdbcType));
}

function isDbObject(value: unknown): value is DbObject {
  if (!value || typeof value !== "object") {
    return false;
  }
  const object = value as Record<string, unknown>;
  return (object.schema === null || typeof object.schema === "string")
    && typeof object.name === "string"
    && (object.type === "TABLE" || object.type === "VIEW");
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

async function isTemporarySnapshotDirectory(directory: string): Promise<boolean> {
  try {
    const content = await fs.readFile(path.join(directory, "manifest.json"), "utf8");
    const manifest = JSON.parse(content) as Partial<ChunkedSnapshotManifest>;
    return manifest.formatVersion === 2 && manifest.indexed === false;
  } catch {
    return false;
  }
}

function sameObject(left: DbObject, right: DbObject): boolean {
  return left.type === right.type
    && normalize(left.schema ?? "") === normalize(right.schema ?? "")
    && normalize(left.name) === normalize(right.name);
}

function normalize(value: string): string {
  return value.toLocaleLowerCase("en-US");
}

function formatBytes(value: number): string {
  return `${Math.ceil(value / (1024 * 1024))} MiB`;
}

async function withIndexMutation<T>(rootDirectory: string, action: () => Promise<T>): Promise<T> {
  const key = path.resolve(rootDirectory);
  const previous = indexMutationTails.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(action);
  const tail = result.then(() => undefined, () => undefined);
  indexMutationTails.set(key, tail);
  try {
    return await result;
  } finally {
    if (indexMutationTails.get(key) === tail) {
      indexMutationTails.delete(key);
    }
  }
}
