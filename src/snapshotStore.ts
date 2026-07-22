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

export class SnapshotStore {
  constructor(private readonly rootDirectory: string) {}

  async save(snapshot: TableSnapshot): Promise<SnapshotDescriptor> {
    validateSnapshot(snapshot);
    const normalized = { ...snapshot, contentFingerprint: fingerprintSnapshotRows(snapshot.rows) };
    await fs.mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    await writeJsonAtomic(this.snapshotPath(snapshot.id), normalized);
    const descriptor = toSnapshotDescriptor(normalized, { storageFormat: "single-file" });
    await this.upsertDescriptor(descriptor);
    return descriptor;
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
    for await (const chunkRows of this.readChunks(id)) {
      rows.push(...chunkRows);
    }
    return {
      ...metadata,
      formatVersion: 1,
      rows,
      rowCount: rows.length,
      contentFingerprint: fingerprintSnapshotRows(rows)
    };
  }

  async *readChunks(id: string): AsyncGenerator<SnapshotCell[][]> {
    const metadata = await this.loadMetadata(id);
    if (metadata.formatVersion === 1) {
      yield (metadata as TableSnapshot).rows;
      return;
    }
    const manifest = metadata as ChunkedSnapshotManifest;
    for (const chunk of manifest.chunks) {
      const content = await fs.readFile(path.join(this.snapshotDirectory(id), chunk.fileName), "utf8");
      if (Buffer.byteLength(content, "utf8") !== chunk.byteLength) {
        throw new Error(`スナップショットチャンク ${chunk.fileName} の容量が一致しません。`);
      }
      const contentHash = createHash("sha256").update(content).digest("hex");
      if (contentHash !== chunk.contentHash) {
        throw new Error(`スナップショットチャンク ${chunk.fileName} が破損しています。`);
      }
      const rows = JSON.parse(content) as SnapshotCell[][];
      if (!Array.isArray(rows) || rows.length !== chunk.rowCount) {
        throw new Error(`スナップショットチャンク ${chunk.fileName} の行数が一致しません。`);
      }
      yield rows;
    }
  }

  async delete(id: string): Promise<boolean> {
    validateId(id);
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
  }

  async prune(retentionDays: number, now = new Date()): Promise<number> {
    if (!Number.isFinite(retentionDays) || retentionDays < 0) {
      throw new Error("保存期間は0以上の日数で指定してください。");
    }
    await this.cleanupIncomplete(24, now);
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
  }

  async cleanupIncomplete(retentionHours: number, now = new Date()): Promise<number> {
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

  private async loadSingleFile(id: string): Promise<TableSnapshot> {
    const content = await fs.readFile(this.snapshotPath(id), "utf8");
    const snapshot = JSON.parse(content) as TableSnapshot;
    validateSnapshot(snapshot);
    return { ...snapshot, contentFingerprint: fingerprintSnapshotRows(snapshot.rows) };
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
    const index = await this.readIndex();
    index.snapshots = [descriptor, ...index.snapshots.filter((current) => current.id !== descriptor.id)]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    await this.writeIndex(index);
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
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    throw new Error("スナップショットIDが不正です。");
  }
}

function validateSnapshot(snapshot: TableSnapshot): void {
  if (snapshot.formatVersion !== 1 || !Array.isArray(snapshot.rows) || !Array.isArray(snapshot.columns)) {
    throw new Error("スナップショット形式に対応していません。");
  }
  validateId(snapshot.id);
  if (snapshot.rowCount !== snapshot.rows.length) {
    throw new Error("スナップショットの行数が一致しません。");
  }
}

function validateManifest(manifest: ChunkedSnapshotManifest): void {
  if (manifest.formatVersion !== 2
    || manifest.fingerprintAlgorithm !== "sha256-multiset-v1"
    || !Array.isArray(manifest.chunks)
    || !Array.isArray(manifest.columns)) {
    throw new Error("チャンク型スナップショット形式に対応していません。");
  }
  validateId(manifest.id);
  const fileNames = new Set<string>();
  let rowCount = 0;
  let storageBytes = 0;
  for (const chunk of manifest.chunks) {
    if (!/^chunk-\d{6}\.json$/.test(chunk.fileName)
      || fileNames.has(chunk.fileName)
      || !Number.isSafeInteger(chunk.rowCount)
      || chunk.rowCount < 0
      || !Number.isSafeInteger(chunk.byteLength)
      || chunk.byteLength < 0) {
      throw new Error("チャンク型スナップショットの索引が不正です。");
    }
    fileNames.add(chunk.fileName);
    rowCount += chunk.rowCount;
    storageBytes += chunk.byteLength;
  }
  if (rowCount !== manifest.rowCount || storageBytes !== manifest.storageBytes) {
    throw new Error("チャンク型スナップショットの行数または容量が一致しません。");
  }
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
