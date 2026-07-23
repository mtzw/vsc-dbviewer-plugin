import { createHash, randomUUID } from "node:crypto";
import { ConnectionProfile, DataColumnInfo, DbObject, ObjectData, ObjectInfo } from "./types";

export type SnapshotCell = string | number | boolean | null;

export interface TableSnapshotMetadata {
  formatVersion: 1 | 2;
  id: string;
  createdAt: string;
  profileId: string;
  profileName: string;
  object: DbObject;
  columns: string[];
  columnTypes: DataColumnInfo[];
  primaryKeys: string[];
  excludedColumns: string[];
  rowCount: number;
  contentFingerprint: string;
}

export interface TableSnapshot extends TableSnapshotMetadata {
  formatVersion: 1;
  rows: SnapshotCell[][];
}

export interface SnapshotDescriptor {
  id: string;
  createdAt: string;
  profileId: string;
  profileName: string;
  object: DbObject;
  columns: string[];
  primaryKeys: string[];
  excludedColumns: string[];
  rowCount: number;
  contentFingerprint: string;
  storageFormat?: "single-file" | "chunked";
  storageBytes?: number;
  chunkCount?: number;
}

export type DiffRowStatus = "ADDED" | "REMOVED" | "UPDATED";

export interface TableDiffRow {
  status: DiffRowStatus;
  key: SnapshotCell[];
  changedColumns: string[];
  before?: SnapshotCell[];
  after?: SnapshotCell[];
}

export interface TableDiff {
  baselineSnapshotId: string;
  comparedAt: string;
  object: DbObject;
  beforeCreatedAt: string;
  beforeRowCount: number;
  afterRowCount: number;
  beforeFingerprint: string;
  afterFingerprint: string;
  changed: boolean;
  schemaChanged: boolean;
  rowClassificationAvailable: boolean;
  rowClassificationReason?: "missing-primary-key" | "schema-changed" | "detail-limit";
  primaryKeys: string[];
  columns: string[];
  excludedColumns: string[];
  addedRows: TableDiffRow[];
  removedRows: TableDiffRow[];
  updatedRows: TableDiffRow[];
  unchangedRowCount: number | null;
}

export class SnapshotFingerprintBuilder {
  private count = 0;
  private sum = 0n;
  private xor = 0n;
  private static readonly modulus = 1n << 256n;

  addRows(rows: SnapshotCell[][]): void {
    for (const row of rows) {
      const value = BigInt(`0x${createHash("sha256").update(canonicalRow(row)).digest("hex")}`);
      this.sum = (this.sum + value) % SnapshotFingerprintBuilder.modulus;
      this.xor ^= value;
      this.count += 1;
    }
  }

  digest(): string {
    const sum = this.sum.toString(16).padStart(64, "0");
    const xor = this.xor.toString(16).padStart(64, "0");
    return createHash("sha256").update(`sha256-multiset-v1:${this.count}:${sum}:${xor}`).digest("hex");
  }
}

const EXCLUDED_JDBC_TYPES = new Set([-16, -4, -3, -2, -1, 2004, 2005, 2009, 2011]);
const EXCLUDED_TYPE_PATTERN = /(?:^|\W)(?:blob|clob|nclob|binary|varbinary|bytea|image|text|ntext|long\s+raw|xml)(?:\W|$)|(?:n?varchar|varbinary)\s*\(\s*max\s*\)/i;

export function createTableSnapshot(
  profile: Pick<ConnectionProfile, "id" | "name">,
  object: DbObject,
  info: ObjectInfo,
  data: Pick<ObjectData, "columns" | "columnTypes" | "rows">,
  options: { id?: string; createdAt?: string } = {}
): TableSnapshot {
  const includedIndexes: number[] = [];
  const excludedColumns: string[] = [];

  for (let index = 0; index < data.columns.length; index += 1) {
    const column = data.columns[index];
    const type = data.columnTypes[index];
    if (shouldExcludeColumn(type)) {
      excludedColumns.push(column);
    } else {
      includedIndexes.push(index);
    }
  }

  const columns = includedIndexes.map((index) => data.columns[index]);
  const columnTypes = includedIndexes.map((index) => data.columnTypes[index] ?? {
    name: data.columns[index],
    typeName: null,
    jdbcType: null
  });
  const columnNames = new Set(columns.map(normalizeIdentifier));
  const primaryKeys = info.primaryKeys.every((column) => columnNames.has(normalizeIdentifier(column)))
    ? [...info.primaryKeys]
    : [];
  const rows = data.rows.map((row) => includedIndexes.map((index) => row[index] ?? null));

  return {
    formatVersion: 1,
    id: options.id ?? randomUUID(),
    createdAt: options.createdAt ?? new Date().toISOString(),
    profileId: profile.id,
    profileName: profile.name,
    object: { ...object },
    columns,
    columnTypes,
    primaryKeys,
    excludedColumns,
    rows,
    rowCount: rows.length,
    contentFingerprint: fingerprintSnapshotRows(rows)
  };
}

export function toSnapshotDescriptor(
  snapshot: TableSnapshotMetadata,
  storage?: Pick<SnapshotDescriptor, "storageFormat" | "storageBytes" | "chunkCount">
): SnapshotDescriptor {
  return {
    id: snapshot.id,
    createdAt: snapshot.createdAt,
    profileId: snapshot.profileId,
    profileName: snapshot.profileName,
    object: { ...snapshot.object },
    columns: [...snapshot.columns],
    primaryKeys: [...snapshot.primaryKeys],
    excludedColumns: [...snapshot.excludedColumns],
    rowCount: snapshot.rowCount,
    contentFingerprint: snapshot.contentFingerprint,
    ...storage
  };
}

export function compareTableSnapshots(before: TableSnapshot, after: TableSnapshot): TableDiff {
  const result = compareTableSnapshotMetadata(before, after);
  const { primaryKeys, rowClassificationAvailable } = result;

  if (rowClassificationAvailable) {
    const keyIndexes = primaryKeys.map((column) => findColumnIndex(before.columns, column));
    const beforeRows = indexRowsByKey(before.rows, keyIndexes, "保存済みスナップショット");
    const afterRows = indexRowsByKey(after.rows, keyIndexes, "再取得データ");
    let unchanged = 0;

    for (const [key, beforeRow] of beforeRows) {
      const afterRow = afterRows.get(key);
      const keyValues = keyIndexes.map((index) => beforeRow[index]);
      if (!afterRow) {
        result.removedRows.push({ status: "REMOVED", key: keyValues, changedColumns: [], before: beforeRow });
        continue;
      }
      const changedColumns = before.columns.filter((_, index) => !sameCell(beforeRow[index], afterRow[index]));
      if (changedColumns.length > 0) {
        result.updatedRows.push({
          status: "UPDATED",
          key: keyValues,
          changedColumns,
          before: beforeRow,
          after: afterRow
        });
      } else {
        unchanged += 1;
      }
    }

    for (const [key, afterRow] of afterRows) {
      if (!beforeRows.has(key)) {
        result.addedRows.push({
          status: "ADDED",
          key: keyIndexes.map((index) => afterRow[index]),
          changedColumns: [],
          after: afterRow
        });
      }
    }
    result.unchangedRowCount = unchanged;
  }

  return result;
}

export function compareTableSnapshotMetadata(
  before: TableSnapshotMetadata,
  after: TableSnapshotMetadata,
  rowClassificationReason?: "detail-limit"
): TableDiff {
  assertSameTarget(before, after);
  const schemaChanged = !sameIdentifiers(before.columns, after.columns)
    || !sameIdentifiers(before.primaryKeys, after.primaryKeys)
    || !sameIdentifiers(before.excludedColumns, after.excludedColumns)
    || !sameColumnTypes(before.columnTypes, after.columnTypes);
  const changed = schemaChanged
    || before.rowCount !== after.rowCount
    || before.contentFingerprint !== after.contentFingerprint;
  const primaryKeys = [...before.primaryKeys];
  const unavailableReason = rowClassificationReason
    ?? (schemaChanged ? "schema-changed" : primaryKeys.length === 0 ? "missing-primary-key" : undefined);

  const result: TableDiff = {
    baselineSnapshotId: before.id,
    comparedAt: after.createdAt,
    object: { ...before.object },
    beforeCreatedAt: before.createdAt,
    beforeRowCount: before.rowCount,
    afterRowCount: after.rowCount,
    beforeFingerprint: before.contentFingerprint,
    afterFingerprint: after.contentFingerprint,
    changed,
    schemaChanged,
    rowClassificationAvailable: unavailableReason === undefined,
    rowClassificationReason: unavailableReason,
    primaryKeys,
    columns: [...before.columns],
    excludedColumns: Array.from(new Set([...before.excludedColumns, ...after.excludedColumns])),
    addedRows: [],
    removedRows: [],
    updatedRows: [],
    unchangedRowCount: null
  };
  if (!changed && unavailableReason === undefined) {
    result.unchangedRowCount = before.rowCount;
  }
  return result;
}

export function tableDiffToJson(diff: TableDiff): string {
  return `${JSON.stringify(diff, null, 2)}\n`;
}

export function tableDiffToCsv(diff: TableDiff): string {
  const rows: string[][] = [[
    "recordType", "status", "key", "changedColumns", "before", "after",
    "beforeRowCount", "afterRowCount", "changed", "schemaChanged",
    "rowClassificationAvailable", "rowClassificationReason", "excludedColumns"
  ]];
  rows.push([
    "SUMMARY", "", "", "", "", "",
    String(diff.beforeRowCount), String(diff.afterRowCount), String(diff.changed), String(diff.schemaChanged),
    String(diff.rowClassificationAvailable), diff.rowClassificationReason ?? "", diff.excludedColumns.join("|")
  ]);
  for (const row of [...diff.addedRows, ...diff.removedRows, ...diff.updatedRows]) {
    rows.push([
      "ROW",
      row.status,
      JSON.stringify(row.key),
      row.changedColumns.join("|"),
      row.before ? JSON.stringify(row.before) : "",
      row.after ? JSON.stringify(row.after) : "",
      "", "", "", "", "", "", ""
    ]);
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function shouldExcludeColumn(type: DataColumnInfo | undefined): boolean {
  if (!type) {
    return false;
  }
  return (type.jdbcType !== null && EXCLUDED_JDBC_TYPES.has(type.jdbcType))
    || (type.typeName !== null && EXCLUDED_TYPE_PATTERN.test(type.typeName));
}

export function fingerprintSnapshotRows(rows: SnapshotCell[][]): string {
  const builder = new SnapshotFingerprintBuilder();
  builder.addRows(rows);
  return builder.digest();
}

function canonicalRow(row: SnapshotCell[]): string {
  return row.map(canonicalCell).join("\u001f");
}

function canonicalCell(value: SnapshotCell): string {
  if (value === null) {
    return "null:";
  }
  return `${typeof value}:${JSON.stringify(value)}`;
}

function sameCell(left: SnapshotCell, right: SnapshotCell): boolean {
  return canonicalCell(left) === canonicalCell(right);
}

function normalizeIdentifier(value: string): string {
  return value.toLocaleLowerCase("en-US");
}

function sameIdentifiers(left: string[], right: string[]): boolean {
  return left.length === right.length
    && left.every((value, index) => normalizeIdentifier(value) === normalizeIdentifier(right[index]));
}

function sameColumnTypes(left: DataColumnInfo[], right: DataColumnInfo[]): boolean {
  return left.length === right.length && left.every((value, index) => {
    const other = right[index];
    return normalizeIdentifier(value.name) === normalizeIdentifier(other.name)
      && normalizeIdentifier(value.typeName ?? "") === normalizeIdentifier(other.typeName ?? "")
      && value.jdbcType === other.jdbcType;
  });
}

function findColumnIndex(columns: string[], target: string): number {
  const normalizedTarget = normalizeIdentifier(target);
  const index = columns.findIndex((column) => normalizeIdentifier(column) === normalizedTarget);
  if (index < 0) {
    throw new Error(`主キー列 ${target} がスナップショットに存在しません。`);
  }
  return index;
}

function indexRowsByKey(rows: SnapshotCell[][], keyIndexes: number[], label: string): Map<string, SnapshotCell[]> {
  const indexed = new Map<string, SnapshotCell[]>();
  for (const row of rows) {
    const key = canonicalRow(keyIndexes.map((index) => row[index]));
    if (indexed.has(key)) {
      throw new Error(`${label}に重複する主キーがあります。行単位差分を作成できません。`);
    }
    indexed.set(key, row);
  }
  return indexed;
}

function assertSameTarget(before: TableSnapshotMetadata, after: TableSnapshotMetadata): void {
  if (before.profileId !== after.profileId
    || normalizeIdentifier(before.object.schema ?? "") !== normalizeIdentifier(after.object.schema ?? "")
    || normalizeIdentifier(before.object.name) !== normalizeIdentifier(after.object.name)
    || before.object.type !== after.object.type) {
    throw new Error("異なる接続またはTableのスナップショットは比較できません。");
  }
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}
