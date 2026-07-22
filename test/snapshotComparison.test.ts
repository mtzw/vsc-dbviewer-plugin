import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import { compareStoredSnapshots } from "../src/snapshotComparison";
import { SnapshotStore } from "../src/snapshotStore";
import { createTableSnapshot, SnapshotCell, TableSnapshot } from "../src/tableDiff";
import { DbObject, ObjectData, ObjectInfo } from "../src/types";

const temporaryDirectories: string[] = [];
const object: DbObject = { schema: "APP", name: "PERSON", type: "TABLE" };
const info: ObjectInfo = {
  schema: "APP", name: "PERSON", type: "TABLE",
  columns: [
    { name: "ID", typeName: "INTEGER", jdbcType: 4, size: 10, nullable: false, autoIncrement: false, generated: false, ordinal: 1, defaultValue: null, remarks: null },
    { name: "NAME", typeName: "VARCHAR", jdbcType: 12, size: 40, nullable: false, autoIncrement: false, generated: false, ordinal: 2, defaultValue: null, remarks: null }
  ],
  primaryKeys: ["ID"], constraints: [], indexes: [], identifierQuoteString: "\""
};
const data: ObjectData = {
  columns: ["ID", "NAME"],
  columnTypes: [
    { name: "ID", typeName: "INTEGER", jdbcType: 4 },
    { name: "NAME", typeName: "VARCHAR", jdbcType: 12 }
  ],
  rows: [], limit: 100, offset: 0, hasPrevious: false, hasNext: false
};

class CountingSnapshotStore extends SnapshotStore {
  loadCount = 0;

  override async load(id: string): Promise<TableSnapshot> {
    this.loadCount += 1;
    return super.load(id);
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

test("skips row materialization when chunk fingerprints are unchanged", async () => {
  const store = await createStore();
  const beforeId = "77777777-7777-4777-8777-777777777777";
  const afterId = "88888888-8888-4888-8888-888888888888";
  await writeSnapshot(store, beforeId, [[1, "Alice"], [2, "Bob"]]);
  await writeSnapshot(store, afterId, [[2, "Bob"], [1, "Alice"]]);

  const diff = await compareStoredSnapshots(store, beforeId, afterId, {
    maxDetailRowsPerSnapshot: 0,
    maxDetailBytesPerSnapshot: 0
  });

  assert.equal(diff.changed, false);
  assert.equal(diff.unchangedRowCount, 2);
  assert.equal(store.loadCount, 0);
});

test("materializes bounded changed snapshots for primary-key row details", async () => {
  const store = await createStore();
  const beforeId = "99999999-9999-4999-8999-999999999999";
  const afterId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await writeSnapshot(store, beforeId, [[1, "Alice"]]);
  await writeSnapshot(store, afterId, [[1, "Alicia"]]);

  const diff = await compareStoredSnapshots(store, beforeId, afterId, {
    maxDetailRowsPerSnapshot: 10,
    maxDetailBytesPerSnapshot: 1024 * 1024
  });

  assert.equal(diff.updatedRows.length, 1);
  assert.equal(store.loadCount, 2);
});

test("returns a summary when changed snapshots exceed the detail limit", async () => {
  const store = await createStore();
  const beforeId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const afterId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  await writeSnapshot(store, beforeId, [[1, "Alice"], [2, "Bob"]]);
  await writeSnapshot(store, afterId, [[1, "Alicia"], [2, "Bob"]]);

  const diff = await compareStoredSnapshots(store, beforeId, afterId, {
    maxDetailRowsPerSnapshot: 1,
    maxDetailBytesPerSnapshot: 1024 * 1024
  });

  assert.equal(diff.changed, true);
  assert.equal(diff.rowClassificationReason, "detail-limit");
  assert.equal(store.loadCount, 0);
});

async function createStore(): Promise<CountingSnapshotStore> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "db-viewer-comparison-test-"));
  temporaryDirectories.push(directory);
  return new CountingSnapshotStore(directory);
}

async function writeSnapshot(store: SnapshotStore, id: string, rows: SnapshotCell[][]): Promise<void> {
  const snapshot = createTableSnapshot({ id: "profile-1", name: "local" }, object, info, { ...data, rows }, { id });
  const { rows: _rows, ...metadata } = snapshot;
  const writer = await store.beginChunkedSnapshot(metadata, { indexed: false, maxBytes: 1024 * 1024, pageSize: 1 });
  for (const row of rows) {
    await writer.appendRows([row]);
  }
  await writer.complete();
}
