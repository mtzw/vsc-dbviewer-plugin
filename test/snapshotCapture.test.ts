import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { captureChunkedTableSnapshot, SnapshotCaptureProgress } from "../src/snapshotCapture";
import { SnapshotStore } from "../src/snapshotStore";
import { DbObject, ObjectData, ObjectInfo } from "../src/types";

const temporaryDirectories: string[] = [];
const profile = { id: "profile-1", name: "local" };
const object: DbObject = { schema: "APP", name: "PERSON", type: "TABLE" };
const columnTypes = [
  { name: "ID", typeName: "INTEGER", jdbcType: 4 },
  { name: "NAME", typeName: "VARCHAR", jdbcType: 12 }
];
const info: ObjectInfo = {
  schema: "APP",
  name: "PERSON",
  type: "TABLE",
  columns: [
    { ...columnTypes[0], size: 10, nullable: false, autoIncrement: false, generated: false, ordinal: 1, defaultValue: null, remarks: null },
    { ...columnTypes[1], size: 100, nullable: true, autoIncrement: false, generated: false, ordinal: 2, defaultValue: null, remarks: null }
  ],
  primaryKeys: ["ID"],
  constraints: [],
  indexes: [],
  identifierQuoteString: "\""
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

test("captures multiple result pages as separate chunks", async () => {
  const { directory, store } = await createStore();
  const rows = [[1, "A"], [2, "B"], [3, "C"], [4, "D"], [5, "E"]];
  const offsets: number[] = [];
  const progress: SnapshotCaptureProgress[] = [];

  const snapshot = await captureChunkedTableSnapshot({
    store,
    profile,
    object,
    info,
    indexed: true,
    limits: { pageSize: 2, maxRows: 10, maxBytes: 1024 * 1024 },
    loadPage: async (offset, limit) => {
      offsets.push(offset);
      return page(rows, offset, limit);
    },
    onProgress: (current) => progress.push({ ...current })
  });

  assert.ok(snapshot);
  assert.equal(snapshot.rowCount, 5);
  assert.equal(snapshot.chunkCount, 3);
  assert.deepEqual(offsets, [0, 2, 4]);
  assert.deepEqual(progress.map((current) => [current.rowCount, current.chunkCount]), [[2, 1], [4, 2], [5, 3]]);
  assert.deepEqual((await store.load(snapshot.id)).rows, rows);
  assert.ok((await fs.stat(path.join(directory, snapshot.id))).isDirectory());
});

test("cancels capture and removes incomplete chunks", async () => {
  const { directory, store } = await createStore();
  let cancelled = false;

  const snapshot = await captureChunkedTableSnapshot({
    store,
    profile,
    object,
    info,
    indexed: true,
    limits: { pageSize: 1, maxRows: 10, maxBytes: 1024 * 1024 },
    loadPage: async (offset, limit) => page([[1, "A"], [2, "B"]], offset, limit),
    isCancellationRequested: () => cancelled,
    onProgress: () => { cancelled = true; }
  });

  assert.equal(snapshot, undefined);
  assert.deepEqual(await store.list(), []);
  assert.equal((await fs.readdir(directory)).some((entry) => entry.startsWith(".capture-")), false);
});

test("aborts capture before retaining data when the row limit is exceeded", async () => {
  const { directory, store } = await createStore();

  await assert.rejects(captureChunkedTableSnapshot({
    store,
    profile,
    object,
    info,
    indexed: true,
    limits: { pageSize: 1, maxRows: 2, maxBytes: 1024 * 1024 },
    loadPage: async (offset, limit) => page([[1, "A"], [2, "B"], [3, "C"]], offset, limit)
  }), /行数が安全上限 2 行を超えています/);

  assert.deepEqual(await store.list(), []);
  assert.equal((await fs.readdir(directory)).some((entry) => entry.startsWith(".capture-")), false);
});

test("allows a snapshot whose row count exactly matches the limit", async () => {
  const { store } = await createStore();

  const snapshot = await captureChunkedTableSnapshot({
    store,
    profile,
    object,
    info,
    indexed: true,
    limits: { pageSize: 1, maxRows: 2, maxBytes: 1024 * 1024 },
    loadPage: async (offset, limit) => page([[1, "A"], [2, "B"]], offset, limit)
  });

  assert.equal(snapshot?.rowCount, 2);
  assert.equal(snapshot?.chunkCount, 2);
});

test("aborts capture and removes chunks when the byte limit is exceeded", async () => {
  const { directory, store } = await createStore();

  await assert.rejects(captureChunkedTableSnapshot({
    store,
    profile,
    object,
    info,
    indexed: true,
    limits: { pageSize: 1, maxRows: 10, maxBytes: 20 },
    loadPage: async (offset, limit) => page([[1, "A"], [2, "a value larger than the limit"]], offset, limit)
  }), /容量が上限/);

  assert.deepEqual(await store.list(), []);
  assert.equal((await fs.readdir(directory)).some((entry) => entry.startsWith(".capture-")), false);
});

test("aborts capture when the table shape changes between pages", async () => {
  const { directory, store } = await createStore();

  await assert.rejects(captureChunkedTableSnapshot({
    store,
    profile,
    object,
    info,
    indexed: true,
    limits: { pageSize: 1, maxRows: 10, maxBytes: 1024 * 1024 },
    loadPage: async (offset) => offset === 0
      ? page([[1, "A"], [2, "B"]], 0, 1)
      : {
        ...page([[1, "A"], [2, "B"]], 1, 1),
        columns: ["ID", "DISPLAY_NAME"],
        columnTypes: [columnTypes[0], { name: "DISPLAY_NAME", typeName: "VARCHAR", jdbcType: 12 }]
      }
  }), /列または主キー構成が変化しました/);

  assert.deepEqual(await store.list(), []);
  assert.equal((await fs.readdir(directory)).some((entry) => entry.startsWith(".capture-")), false);
});

test("aborts capture when pagination stops making progress", async () => {
  const { directory, store } = await createStore();

  await assert.rejects(captureChunkedTableSnapshot({
    store,
    profile,
    object,
    info,
    indexed: true,
    limits: { pageSize: 1, maxRows: 10, maxBytes: 1024 * 1024 },
    loadPage: async (offset, limit) => offset === 0
      ? page([[1, "A"], [2, "B"]], offset, limit)
      : { ...page([], offset, limit), hasNext: true }
  }), /ページ取得が進行しませんでした/);

  assert.deepEqual(await store.list(), []);
  assert.equal((await fs.readdir(directory)).some((entry) => entry.startsWith(".capture-")), false);
});

test("rejects snapshot capture for views", async () => {
  const { store } = await createStore();

  await assert.rejects(captureChunkedTableSnapshot({
    store,
    profile,
    object: { ...object, type: "VIEW" },
    info: { ...info, type: "VIEW" },
    indexed: true,
    limits: { pageSize: 1, maxRows: 10, maxBytes: 1024 * 1024 },
    loadPage: async (offset, limit) => page([], offset, limit)
  }), /Tableのみ/);
});

function page(rows: ObjectData["rows"], offset: number, limit: number): ObjectData {
  const currentRows = rows.slice(offset, offset + limit);
  return {
    columns: ["ID", "NAME"],
    columnTypes,
    rows: currentRows,
    limit,
    offset,
    hasPrevious: offset > 0,
    hasNext: offset + currentRows.length < rows.length
  };
}

async function createStore(): Promise<{ directory: string; store: SnapshotStore }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "db-viewer-capture-test-"));
  temporaryDirectories.push(directory);
  return { directory, store: new SnapshotStore(directory) };
}
