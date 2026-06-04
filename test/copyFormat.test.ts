import assert from "node:assert/strict";
import { test } from "node:test";
import { toInsertSql, toTsv } from "../src/copyFormat";
import { DbObject, ObjectData } from "../src/types";

const object: DbObject = {
  schema: "APP",
  name: "PERSON",
  type: "TABLE"
};

const data: ObjectData = {
  columns: ["ID", "NAME", "ACTIVE", "CREATED_AT", "NOTE"],
  rows: [
    [1, "Alice", true, "2026-06-03 10:20:30", null],
    [2, "Bob's row", false, "2026-06-04", "line1\nline2"]
  ],
  limit: 100,
  offset: 0,
  hasPrevious: false,
  hasNext: false
};

test("formats selected rows as TSV", () => {
  assert.equal(
    toTsv(data, [0, 1]),
    "1\tAlice\ttrue\t2026-06-03 10:20:30\t\n2\tBob's row\tfalse\t2026-06-04\tline1 line2"
  );
});

test("formats selected rows as INSERT SQL", () => {
  assert.equal(
    toInsertSql(data, object, "\"", [1]),
    "INSERT INTO \"APP\".\"PERSON\" (\"ID\", \"NAME\", \"ACTIVE\", \"CREATED_AT\", \"NOTE\") VALUES (2, 'Bob''s row', FALSE, '2026-06-04', 'line1\nline2');"
  );
});

test("formats INSERT SQL without identifier quotes when metadata does not provide one", () => {
  assert.equal(
    toInsertSql(data, { schema: null, name: "PERSON", type: "TABLE" }, "", [0]),
    "INSERT INTO PERSON (ID, NAME, ACTIVE, CREATED_AT, NOTE) VALUES (1, 'Alice', TRUE, '2026-06-03 10:20:30', NULL);"
  );
});
