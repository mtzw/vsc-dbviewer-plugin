import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { SnapshotStore } from "../src/snapshotStore";
import { createTableSnapshot } from "../src/tableDiff";
import { DbObject, ObjectData, ObjectInfo } from "../src/types";

const temporaryDirectories: string[] = [];
const object: DbObject = { schema: "APP", name: "PERSON", type: "TABLE" };
const info: ObjectInfo = {
  schema: "APP", name: "PERSON", type: "TABLE",
  columns: [{ name: "ID", typeName: "INTEGER", jdbcType: 4, size: 10, nullable: false, autoIncrement: false, generated: false, ordinal: 1, defaultValue: null, remarks: null }],
  primaryKeys: ["ID"], constraints: [], indexes: [], identifierQuoteString: "\""
};
const data: ObjectData = {
  columns: ["ID"], columnTypes: [{ name: "ID", typeName: "INTEGER", jdbcType: 4 }], rows: [[1]],
  limit: 100, offset: 0, hasPrevious: false, hasNext: false
};

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

test("saves, lists, loads and deletes snapshots", async () => {
  const directory = await createTemporaryDirectory();
  const store = new SnapshotStore(directory);
  const snapshot = createTableSnapshot({ id: "profile-1", name: "local" }, object, info, data, {
    id: "11111111-1111-4111-8111-111111111111",
    createdAt: "2026-07-20T00:00:00.000Z"
  });

  await store.save(snapshot);

  assert.equal((await store.list("profile-1", object)).length, 1);
  assert.deepEqual(await store.load(snapshot.id), snapshot);
  assert.equal(await store.delete(snapshot.id), true);
  assert.deepEqual(await store.list("profile-1", object), []);
  await assert.rejects(store.load(snapshot.id), /ENOENT/);
});

test("prunes snapshots older than the retention period", async () => {
  const directory = await createTemporaryDirectory();
  const store = new SnapshotStore(directory);
  const oldSnapshot = createTableSnapshot({ id: "profile-1", name: "local" }, object, info, data, {
    id: "11111111-1111-4111-8111-111111111111",
    createdAt: "2026-06-01T00:00:00.000Z"
  });
  const recentSnapshot = createTableSnapshot({ id: "profile-1", name: "local" }, object, info, data, {
    id: "22222222-2222-4222-8222-222222222222",
    createdAt: "2026-07-15T00:00:00.000Z"
  });
  await store.save(oldSnapshot);
  await store.save(recentSnapshot);

  const pruned = await store.prune(30, new Date("2026-07-22T00:00:00.000Z"));

  assert.equal(pruned, 1);
  assert.deepEqual((await store.list()).map((snapshot) => snapshot.id), [recentSnapshot.id]);
  await assert.rejects(store.load(oldSnapshot.id), /ENOENT/);
});

test("writes and loads chunked snapshots without indexing row data", async () => {
  const directory = await createTemporaryDirectory();
  const store = new SnapshotStore(directory);
  const snapshot = createTableSnapshot({ id: "profile-1", name: "local" }, object, info, data, {
    id: "33333333-3333-4333-8333-333333333333",
    createdAt: "2026-07-22T00:00:00.000Z"
  });
  const { rows: _rows, ...metadata } = snapshot;
  const writer = await store.beginChunkedSnapshot(metadata, {
    indexed: true,
    maxBytes: 1024 * 1024,
    pageSize: 1
  });
  await writer.appendRows([[1]]);
  await writer.appendRows([[2]]);

  const descriptor = await writer.complete();

  assert.equal(descriptor.storageFormat, "chunked");
  assert.equal(descriptor.chunkCount, 2);
  assert.equal((await store.list()).length, 1);
  const loaded = await store.load(snapshot.id);
  assert.deepEqual(loaded.rows, [[1], [2]]);
  assert.equal(loaded.rowCount, 2);
});

test("keeps fingerprints stable across different chunk boundaries", async () => {
  const directory = await createTemporaryDirectory();
  const store = new SnapshotStore(directory);
  const first = createTableSnapshot({ id: "profile-1", name: "local" }, object, info, data, {
    id: "44444444-4444-4444-8444-444444444444"
  });
  const second = createTableSnapshot({ id: "profile-1", name: "local" }, object, info, data, {
    id: "55555555-5555-4555-8555-555555555555"
  });
  const { rows: _firstRows, ...firstMetadata } = first;
  const { rows: _secondRows, ...secondMetadata } = second;
  const firstWriter = await store.beginChunkedSnapshot(firstMetadata, { indexed: false, maxBytes: 1024 * 1024, pageSize: 2 });
  await firstWriter.appendRows([[1], [2]]);
  const firstDescriptor = await firstWriter.complete();
  const secondWriter = await store.beginChunkedSnapshot(secondMetadata, { indexed: false, maxBytes: 1024 * 1024, pageSize: 1 });
  await secondWriter.appendRows([[2]]);
  await secondWriter.appendRows([[1]]);
  const secondDescriptor = await secondWriter.complete();

  assert.equal(firstDescriptor.contentFingerprint, secondDescriptor.contentFingerprint);
  assert.deepEqual(await store.list(), []);
});

test("aborts chunked snapshots that exceed the capacity limit", async () => {
  const directory = await createTemporaryDirectory();
  const store = new SnapshotStore(directory);
  const snapshot = createTableSnapshot({ id: "profile-1", name: "local" }, object, info, data, {
    id: "66666666-6666-4666-8666-666666666666"
  });
  const { rows: _rows, ...metadata } = snapshot;
  const writer = await store.beginChunkedSnapshot(metadata, { indexed: true, maxBytes: 8, pageSize: 1 });

  await assert.rejects(writer.appendRows([["value that is too large"]]), /容量が上限/);
  await writer.abort();

  assert.deepEqual(await store.list(), []);
  await assert.rejects(store.load(snapshot.id), /ENOENT/);
});

test("cleans completed temporary comparison snapshots after 24 hours", async () => {
  const directory = await createTemporaryDirectory();
  const store = new SnapshotStore(directory);
  const snapshot = createTableSnapshot({ id: "profile-1", name: "local" }, object, info, data, {
    id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
  });
  const { rows: _rows, ...metadata } = snapshot;
  const writer = await store.beginChunkedSnapshot(metadata, { indexed: false, maxBytes: 1024, pageSize: 1 });
  await writer.appendRows([[1]]);
  await writer.complete();
  const oldDate = new Date("2026-07-20T00:00:00.000Z");
  await fs.utimes(path.join(directory, snapshot.id), oldDate, oldDate);

  const removed = await store.cleanupIncomplete(24, new Date("2026-07-22T00:00:00.000Z"));

  assert.equal(removed, 1);
  await assert.rejects(store.load(snapshot.id), /ENOENT/);
});

test("detects corrupted chunk content before loading rows", async () => {
  const directory = await createTemporaryDirectory();
  const store = new SnapshotStore(directory);
  const snapshot = createTableSnapshot({ id: "profile-1", name: "local" }, object, info, data, {
    id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
  });
  const { rows: _rows, ...metadata } = snapshot;
  const writer = await store.beginChunkedSnapshot(metadata, { indexed: true, maxBytes: 1024, pageSize: 1 });
  await writer.appendRows([[1]]);
  await writer.complete();
  await fs.writeFile(path.join(directory, snapshot.id, "chunk-000000.json"), "[[2]]\n", "utf8");

  await assert.rejects(store.load(snapshot.id), /破損しています/);
});

test("reports a missing chunk with its file name", async () => {
  const directory = await createTemporaryDirectory();
  const store = new SnapshotStore(directory);
  const snapshot = createTableSnapshot({ id: "profile-1", name: "local" }, object, info, data, {
    id: "abababab-abab-4bab-8bab-abababababab"
  });
  const { rows: _rows, ...metadata } = snapshot;
  const writer = await store.beginChunkedSnapshot(metadata, { indexed: true, maxBytes: 1024, pageSize: 1 });
  await writer.appendRows([[1]]);
  await writer.complete();
  await fs.unlink(path.join(directory, snapshot.id, "chunk-000000.json"));

  await assert.rejects(store.load(snapshot.id), /chunk-000000\.json が見つかりません/);
});

test("rejects an invalid chunk manifest before comparison", async () => {
  const directory = await createTemporaryDirectory();
  const store = new SnapshotStore(directory);
  const snapshot = createTableSnapshot({ id: "profile-1", name: "local" }, object, info, data, {
    id: "acacacac-acac-4cac-8cac-acacacacacac"
  });
  const { rows: _rows, ...metadata } = snapshot;
  const writer = await store.beginChunkedSnapshot(metadata, { indexed: true, maxBytes: 1024, pageSize: 1 });
  await writer.appendRows([[1]]);
  await writer.complete();
  const manifestPath = path.join(directory, snapshot.id, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { contentFingerprint: string };
  manifest.contentFingerprint = "not-a-sha256";
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, "utf8");

  await assert.rejects(store.loadMetadata(snapshot.id), /マニフェストが不正/);
});

test("serializes index updates from concurrently opened panels", async () => {
  const directory = await createTemporaryDirectory();
  const firstStore = new SnapshotStore(directory);
  const secondStore = new SnapshotStore(directory);
  const snapshots = Array.from({ length: 12 }, (_, index) => createTableSnapshot(
    { id: "profile-1", name: "local" },
    object,
    info,
    data,
    { id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` }
  ));

  await Promise.all(snapshots.map((snapshot, index) => (index % 2 === 0 ? firstStore : secondStore).save(snapshot)));

  assert.equal((await firstStore.list()).length, snapshots.length);
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "db-viewer-snapshot-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
