import assert from "node:assert/strict";
import { test } from "node:test";
import { compareTableSnapshotMetadata, compareTableSnapshots, createTableSnapshot, tableDiffToCsv, tableDiffToJson } from "../src/tableDiff";
import { DbObject, ObjectData, ObjectInfo } from "../src/types";

const object: DbObject = { schema: "APP", name: "PERSON", type: "TABLE" };
const profile = { id: "profile-1", name: "local" };
const info: ObjectInfo = {
  schema: "APP",
  name: "PERSON",
  type: "TABLE",
  columns: [
    { name: "ID", typeName: "INTEGER", jdbcType: 4, size: 10, nullable: false, autoIncrement: false, generated: false, ordinal: 1, defaultValue: null, remarks: null },
    { name: "NAME", typeName: "VARCHAR", jdbcType: 12, size: 40, nullable: false, autoIncrement: false, generated: false, ordinal: 2, defaultValue: null, remarks: null },
    { name: "PAYLOAD", typeName: "BLOB", jdbcType: 2004, size: null, nullable: true, autoIncrement: false, generated: false, ordinal: 3, defaultValue: null, remarks: null }
  ],
  primaryKeys: ["ID"],
  constraints: [],
  indexes: [],
  identifierQuoteString: "\""
};

function data(rows: ObjectData["rows"]): ObjectData {
  return {
    columns: ["ID", "NAME", "PAYLOAD"],
    columnTypes: [
      { name: "ID", typeName: "INTEGER", jdbcType: 4 },
      { name: "NAME", typeName: "VARCHAR", jdbcType: 12 },
      { name: "PAYLOAD", typeName: "BLOB", jdbcType: 2004 }
    ],
    rows,
    limit: rows.length,
    offset: 0,
    hasPrevious: false,
    hasNext: false
  };
}

test("classifies added, removed and updated rows by primary key", () => {
  const before = createTableSnapshot(profile, object, info, data([
    [1, "Alice", "old-binary"],
    [2, "Bob", null],
    [3, "Carol", null]
  ]), { id: "11111111-1111-4111-8111-111111111111", createdAt: "2026-07-01T00:00:00.000Z" });
  const after = createTableSnapshot(profile, object, info, data([
    [1, "Alicia", "new-binary"],
    [3, "Carol", null],
    [4, "Dave", null]
  ]), { id: "22222222-2222-4222-8222-222222222222", createdAt: "2026-07-02T00:00:00.000Z" });

  const diff = compareTableSnapshots(before, after);

  assert.equal(diff.changed, true);
  assert.deepEqual(diff.addedRows.map((row) => row.key), [[4]]);
  assert.deepEqual(diff.removedRows.map((row) => row.key), [[2]]);
  assert.deepEqual(diff.updatedRows.map((row) => [row.key, row.changedColumns]), [[[1], ["NAME"]]]);
  assert.equal(diff.unchangedRowCount, 1);
  assert.deepEqual(diff.excludedColumns, ["PAYLOAD"]);
});

test("fingerprint is stable when result row order changes", () => {
  const before = createTableSnapshot(profile, object, info, data([[1, "Alice", null], [2, "Bob", null]]));
  const after = createTableSnapshot(profile, object, info, data([[2, "Bob", null], [1, "Alice", null]]));

  const diff = compareTableSnapshots(before, after);

  assert.equal(diff.changed, false);
  assert.equal(diff.unchangedRowCount, 2);
});

test("ignores changes in excluded large-object columns", () => {
  const before = createTableSnapshot(profile, object, info, data([[1, "Alice", "old-binary"]]));
  const after = createTableSnapshot(profile, object, info, data([[1, "Alice", "new-binary"]]));

  const diff = compareTableSnapshots(before, after);

  assert.equal(diff.changed, false);
  assert.deepEqual(before.columns, ["ID", "NAME"]);
  assert.deepEqual(before.excludedColumns, ["PAYLOAD"]);
});

test("detects content changes without row classification when no primary key exists", () => {
  const noKeyInfo = { ...info, primaryKeys: [] };
  const before = createTableSnapshot(profile, object, noKeyInfo, data([[1, "Alice", null]]));
  const after = createTableSnapshot(profile, object, noKeyInfo, data([[1, "Alicia", null]]));

  const diff = compareTableSnapshots(before, after);

  assert.equal(diff.changed, true);
  assert.equal(diff.rowClassificationAvailable, false);
  assert.equal(diff.unchangedRowCount, null);
  assert.deepEqual(diff.updatedRows, []);
});

test("marks schema changes and disables row classification", () => {
  const before = createTableSnapshot(profile, object, info, data([[1, "Alice", null]]));
  const afterData = data([[1, "Alice", null]]);
  afterData.columns = ["ID", "DISPLAY_NAME", "PAYLOAD"];
  afterData.columnTypes[1] = { name: "DISPLAY_NAME", typeName: "VARCHAR", jdbcType: 12 };
  const after = createTableSnapshot(profile, object, { ...info, primaryKeys: ["ID"] }, afterData);

  const diff = compareTableSnapshots(before, after);

  assert.equal(diff.changed, true);
  assert.equal(diff.schemaChanged, true);
  assert.equal(diff.rowClassificationAvailable, false);
});

test("exports summary and row details as escaped CSV", () => {
  const before = createTableSnapshot(profile, object, info, data([[1, "Alice", null]]));
  const after = createTableSnapshot(profile, object, info, data([[1, "Alice, Inc.", null]]));

  const csv = tableDiffToCsv(compareTableSnapshots(before, after));

  assert.match(csv, /SUMMARY/);
  assert.match(csv, /UPDATED/);
  assert.match(csv, /Alice, Inc\./);
});

test("compares unchanged metadata without loading row details", () => {
  const before = createTableSnapshot(profile, object, info, data([[1, "Alice", null]]));
  const after = createTableSnapshot(profile, object, info, data([[1, "Alice", null]]));

  const diff = compareTableSnapshotMetadata(before, after);

  assert.equal(diff.changed, false);
  assert.equal(diff.rowClassificationAvailable, true);
  assert.equal(diff.unchangedRowCount, 1);
});

test("reports detail limit when large changed snapshots are summary-only", () => {
  const before = createTableSnapshot(profile, object, info, data([[1, "Alice", null]]));
  const after = createTableSnapshot(profile, object, info, data([[1, "Alicia", null]]));

  const diff = compareTableSnapshotMetadata(before, after, "detail-limit");

  assert.equal(diff.changed, true);
  assert.equal(diff.rowClassificationAvailable, false);
  assert.equal(diff.rowClassificationReason, "detail-limit");
});

test("exports the detail-limit reason in JSON and CSV summaries", () => {
  const before = createTableSnapshot(profile, object, info, data([[1, "Alice", null]]));
  const after = createTableSnapshot(profile, object, info, data([[1, "Alicia", null]]));
  const diff = compareTableSnapshotMetadata(before, after, "detail-limit");

  const json = JSON.parse(tableDiffToJson(diff)) as { rowClassificationReason: string };
  const csv = tableDiffToCsv(diff);

  assert.equal(json.rowClassificationReason, "detail-limit");
  assert.match(csv, /SUMMARY.*detail-limit/);
});
