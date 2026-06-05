import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTsvInsertPreview } from "../src/tsvInsert";
import { DbObject, ObjectInfo } from "../src/types";

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

test("parses TSV insert values with empty strings and explicit nulls", () => {
  const preview = buildTsvInsertPreview(table, info, "1\tAlice\t\\N\n2\t\tmemo");

  assert.deepEqual(preview.columns, ["ID", "NAME", "NOTE"]);
  assert.deepEqual(preview.rows, [
    ["1", "Alice", null],
    ["2", "", "memo"]
  ]);
  assert.equal(preview.rowCount, 2);
  assert.equal(preview.nullCount, 1);
  assert.deepEqual(preview.errors, []);
});

test("reports too few TSV columns before insert", () => {
  const preview = buildTsvInsertPreview(table, info, "1\tAlice");

  assert.deepEqual(preview.errors, ["Row 1: expected 3 column(s), got 2."]);
});

test("reports too many TSV columns before insert", () => {
  const preview = buildTsvInsertPreview(table, info, "1\tAlice\tmemo\textra");

  assert.deepEqual(preview.errors, ["Row 1: expected 3 column(s), got 4."]);
});

test("rejects TSV insert previews for views", () => {
  const preview = buildTsvInsertPreview({ ...table, type: "VIEW" }, { ...info, type: "VIEW" }, "1\tAlice\tmemo");

  assert.deepEqual(preview.errors, ["TSV InsertはTableのみ実行できます。"]);
});
