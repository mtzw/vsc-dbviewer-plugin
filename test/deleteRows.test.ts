import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDeleteRowsPreview } from "../src/deleteRows";
import { DbObject, ObjectData, ObjectInfo } from "../src/types";

const table: DbObject = {
  schema: "APP",
  name: "PERSON",
  type: "TABLE"
};

const info: ObjectInfo = {
  schema: "APP",
  name: "PERSON",
  type: "TABLE",
  columns: [
    { name: "ID", typeName: "INTEGER", jdbcType: 4, size: 10, nullable: false, autoIncrement: false, generated: false, ordinal: 1, defaultValue: null, remarks: null },
    { name: "NAME", typeName: "VARCHAR", jdbcType: 12, size: 40, nullable: false, autoIncrement: false, generated: false, ordinal: 2, defaultValue: null, remarks: null }
  ],
  primaryKeys: ["ID"],
  constraints: [],
  indexes: [],
  identifierQuoteString: "\""
};

const data: ObjectData = {
  columns: ["ID", "NAME"],
  columnTypes: [
    { name: "ID", typeName: "INTEGER", jdbcType: 4 },
    { name: "NAME", typeName: "VARCHAR", jdbcType: 12 }
  ],
  rows: [
    [1, "Alice"],
    [2, "Bob"]
  ],
  limit: 100,
  offset: 0,
  hasPrevious: false,
  hasNext: false
};

test("builds delete preview using selected row primary keys", () => {
  const preview = buildDeleteRowsPreview(table, info, data, [1]);

  assert.deepEqual(preview.primaryKeyColumns, ["ID"]);
  assert.deepEqual(preview.rows, [[2]]);
  assert.equal(preview.rowCount, 1);
  assert.deepEqual(preview.errors, []);
});

test("rejects delete preview when no primary key is available", () => {
  const preview = buildDeleteRowsPreview(table, { ...info, primaryKeys: [] }, data, [0]);

  assert.deepEqual(preview.errors, ["主キーが取得できないTableでは選択行削除を実行できません。"]);
});

test("rejects delete preview for views", () => {
  const preview = buildDeleteRowsPreview({ ...table, type: "VIEW" }, { ...info, type: "VIEW" }, data, [0]);

  assert.deepEqual(preview.errors, ["選択行削除はTableのみ実行できます。"]);
});

test("rejects delete preview when selected rows are empty", () => {
  const preview = buildDeleteRowsPreview(table, info, data, []);

  assert.deepEqual(preview.errors, ["削除する行を選択してください。"]);
});
