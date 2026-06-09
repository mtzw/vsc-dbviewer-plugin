import assert from "node:assert/strict";
import { test } from "node:test";
import { buildUpdateRowsPreview } from "../src/updateRows";
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
    { name: "ID", typeName: "INTEGER", jdbcType: 4, size: 10, nullable: false, ordinal: 1, defaultValue: null, remarks: null },
    { name: "NAME", typeName: "VARCHAR", jdbcType: 12, size: 40, nullable: false, ordinal: 2, defaultValue: null, remarks: null },
    { name: "NOTE", typeName: "VARCHAR", jdbcType: 12, size: 80, nullable: true, ordinal: 3, defaultValue: null, remarks: null }
  ],
  primaryKeys: ["ID"],
  constraints: [],
  indexes: [],
  identifierQuoteString: "\""
};

const data: ObjectData = {
  columns: ["ID", "NAME", "NOTE"],
  columnTypes: [
    { name: "ID", typeName: "INTEGER", jdbcType: 4 },
    { name: "NAME", typeName: "VARCHAR", jdbcType: 12 },
    { name: "NOTE", typeName: "VARCHAR", jdbcType: 12 }
  ],
  rows: [
    [1, "Alice", null],
    [2, "Bob", "memo"]
  ],
  limit: 100,
  offset: 0,
  hasPrevious: false,
  hasNext: false
};

test("builds update preview with changed non-primary-key columns", () => {
  const preview = buildUpdateRowsPreview(table, info, data, [
    { rowIndex: 1, values: ["Bobby", "memo"] }
  ]);

  assert.deepEqual(preview.primaryKeyColumns, ["ID"]);
  assert.deepEqual(preview.inputColumns, ["NAME", "NOTE"]);
  assert.deepEqual(preview.updateColumns, ["NAME"]);
  assert.deepEqual(preview.rows, [{
    rowIndex: 1,
    primaryKeyValues: [2],
    previousValues: ["Bob"],
    values: ["Bobby"]
  }]);
  assert.equal(preview.rowCount, 1);
  assert.deepEqual(preview.errors, []);
});

test("builds update preview with null values", () => {
  const preview = buildUpdateRowsPreview(table, info, data, [
    { rowIndex: 1, values: ["Bob", null] }
  ]);

  assert.deepEqual(preview.updateColumns, ["NOTE"]);
  assert.deepEqual(preview.rows[0].previousValues, ["memo"]);
  assert.deepEqual(preview.rows[0].values, [null]);
});

test("rejects update preview when no primary key is available", () => {
  const preview = buildUpdateRowsPreview(table, { ...info, primaryKeys: [] }, data, [
    { rowIndex: 0, values: ["Alicia", null] }
  ]);

  assert.deepEqual(preview.errors, ["主キーが取得できないTableでは行Updateを実行できません。"]);
});

test("rejects update preview for views", () => {
  const preview = buildUpdateRowsPreview({ ...table, type: "VIEW" }, { ...info, type: "VIEW" }, data, [
    { rowIndex: 0, values: ["Alicia", null] }
  ]);

  assert.deepEqual(preview.errors, ["行UpdateはTableのみ実行できます。"]);
});

test("rejects update preview when selected rows are empty", () => {
  const preview = buildUpdateRowsPreview(table, info, data, []);

  assert.deepEqual(preview.errors, ["更新する行を選択してください。"]);
});

test("rejects update preview when values are unchanged", () => {
  const preview = buildUpdateRowsPreview(table, info, data, [
    { rowIndex: 0, values: ["Alice", null] }
  ]);

  assert.deepEqual(preview.errors, ["変更された列がありません。"]);
});

test("validates update values by JDBC type and nullability", () => {
  const typedInfo: ObjectInfo = {
    ...info,
    columns: [
      { name: "ID", typeName: "INTEGER", jdbcType: 4, size: 10, nullable: false, ordinal: 1, defaultValue: null, remarks: null },
      { name: "AMOUNT", typeName: "DECIMAL", jdbcType: 3, size: 10, nullable: false, ordinal: 2, defaultValue: null, remarks: null },
      { name: "CREATED_AT", typeName: "TIMESTAMP", jdbcType: 93, size: null, nullable: false, ordinal: 3, defaultValue: null, remarks: null }
    ]
  };
  const typedData: ObjectData = {
    ...data,
    columns: ["ID", "AMOUNT", "CREATED_AT"],
    columnTypes: [
      { name: "ID", typeName: "INTEGER", jdbcType: 4 },
      { name: "AMOUNT", typeName: "DECIMAL", jdbcType: 3 },
      { name: "CREATED_AT", typeName: "TIMESTAMP", jdbcType: 93 }
    ],
    rows: [[1, "10.00", "2026-06-09 09:30:00"]]
  };

  const preview = buildUpdateRowsPreview(table, typedInfo, typedData, [
    { rowIndex: 0, values: ["abc", "2026-06-09"] }
  ]);

  assert.deepEqual(preview.errors, [
    "Row 1 AMOUNT: 数値を入力してください。",
    "Row 1 CREATED_AT: 日時はyyyy-mm-dd HH:mm:ssまたはyyyy-mm-ddTHH:mm:ss形式で入力してください。"
  ]);
});
