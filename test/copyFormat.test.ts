import assert from "node:assert/strict";
import { test } from "node:test";
import { toExportCsv, toExportTsv, toInsertSql, toTsv } from "../src/copyFormat";
import { DbObject, ObjectData } from "../src/types";

const object: DbObject = {
  schema: "APP",
  name: "PERSON",
  type: "TABLE"
};

const data: ObjectData = {
  columns: ["ID", "NAME", "ACTIVE", "CREATED_AT", "NOTE"],
  columnTypes: [
    { name: "ID", typeName: "INTEGER", jdbcType: 4 },
    { name: "NAME", typeName: "VARCHAR", jdbcType: 12 },
    { name: "ACTIVE", typeName: "BOOLEAN", jdbcType: 16 },
    { name: "CREATED_AT", typeName: "TIMESTAMP", jdbcType: 93 },
    { name: "NOTE", typeName: "VARCHAR", jdbcType: 12 }
  ],
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

test("formats export TSV with header", () => {
  assert.equal(
    toExportTsv(data, [0, 1], true),
    "ID\tNAME\tACTIVE\tCREATED_AT\tNOTE\n1\tAlice\ttrue\t2026-06-03 10:20:30\t\n2\tBob's row\tfalse\t2026-06-04\tline1 line2"
  );
});

test("formats export CSV with header and escaped cells", () => {
  const csvData: ObjectData = {
    ...data,
    columns: ["ID", "NAME", "NOTE"],
    columnTypes: [
      { name: "ID", typeName: "INTEGER", jdbcType: 4 },
      { name: "NAME", typeName: "VARCHAR", jdbcType: 12 },
      { name: "NOTE", typeName: "VARCHAR", jdbcType: 12 }
    ],
    rows: [
      [1, "Alice", "plain"],
      [2, "Bob, Jr.", "line1\nline2"],
      [3, "Carol \"CJ\"", null]
    ]
  };

  assert.equal(
    toExportCsv(csvData, [0, 1, 2], true),
    "ID,NAME,NOTE\n1,Alice,plain\n2,\"Bob, Jr.\",\"line1\nline2\"\n3,\"Carol \"\"CJ\"\"\","
  );
});

test("formats Oracle DATE values as Oracle date expressions", () => {
  const oracleData: ObjectData = {
    columns: ["ID", "CREATED_ON", "UPDATED_ON"],
    columnTypes: [
      { name: "ID", typeName: "NUMBER", jdbcType: 2 },
      { name: "CREATED_ON", typeName: "DATE", jdbcType: 91 },
      { name: "UPDATED_ON", typeName: "DATE", jdbcType: 91 }
    ],
    rows: [[1, "2026-06-04", "2026-06-04 10:20:30"]],
    limit: 100,
    offset: 0,
    hasPrevious: false,
    hasNext: false
  };

  assert.equal(
    toInsertSql(oracleData, object, "\"", [0], "oracle"),
    "INSERT INTO \"APP\".\"PERSON\" (\"ID\", \"CREATED_ON\", \"UPDATED_ON\") VALUES (1, DATE '2026-06-04', TO_DATE('2026-06-04 10:20:30', 'YYYY-MM-DD HH24:MI:SS'));"
  );
});

test("formats Oracle TIMESTAMP values as Oracle timestamp expressions", () => {
  const oracleData: ObjectData = {
    columns: ["ID", "UPDATED_AT", "AUDITED_AT"],
    columnTypes: [
      { name: "ID", typeName: "NUMBER", jdbcType: 2 },
      { name: "UPDATED_AT", typeName: "TIMESTAMP", jdbcType: 93 },
      { name: "AUDITED_AT", typeName: "TIMESTAMP WITH TIME ZONE", jdbcType: 2014 }
    ],
    rows: [[1, "2026-06-04 10:20:30.123456", "2026-06-04 10:20:30 +09:00"]],
    limit: 100,
    offset: 0,
    hasPrevious: false,
    hasNext: false
  };

  assert.equal(
    toInsertSql(oracleData, object, "\"", [0], "oracle"),
    "INSERT INTO \"APP\".\"PERSON\" (\"ID\", \"UPDATED_AT\", \"AUDITED_AT\") VALUES (1, TIMESTAMP '2026-06-04 10:20:30.123456', TO_TIMESTAMP_TZ('2026-06-04 10:20:30 +09:00', 'YYYY-MM-DD HH24:MI:SS TZH:TZM'));"
  );
});

test("keeps non-Oracle date and timestamp values as standard string literals", () => {
  assert.equal(
    toInsertSql(data, object, "\"", [0], "postgresql"),
    "INSERT INTO \"APP\".\"PERSON\" (\"ID\", \"NAME\", \"ACTIVE\", \"CREATED_AT\", \"NOTE\") VALUES (1, 'Alice', TRUE, '2026-06-03 10:20:30', NULL);"
  );
});

test("formats SQL Server identifiers, Unicode strings, bits, and binary values", () => {
  const sqlServerData: ObjectData = {
    columns: ["ID", "DISPLAY_NAME", "ACTIVE", "ITEM_ID", "PAYLOAD", "CREATED_AT"],
    columnTypes: [
      { name: "ID", typeName: "int", jdbcType: 4 },
      { name: "DISPLAY_NAME", typeName: "nvarchar", jdbcType: -9 },
      { name: "ACTIVE", typeName: "bit", jdbcType: -7 },
      { name: "ITEM_ID", typeName: "uniqueidentifier", jdbcType: 1 },
      { name: "PAYLOAD", typeName: "varbinary", jdbcType: -3 },
      { name: "CREATED_AT", typeName: "datetimeoffset", jdbcType: -155 }
    ],
    rows: [[1, "O'Reilly", true, "12345678-1234-1234-1234-1234567890ab", "base64:AQKg/w==", "2026-07-22T10:20:30+09:00"]],
    limit: 100,
    offset: 0,
    hasPrevious: false,
    hasNext: false
  };

  assert.equal(
    toInsertSql(sqlServerData, { schema: "dbo", name: "Order]Detail", type: "TABLE" }, "\"", [0], "sqlserver"),
    "INSERT INTO [dbo].[Order]]Detail] ([ID], [DISPLAY_NAME], [ACTIVE], [ITEM_ID], [PAYLOAD], [CREATED_AT]) VALUES (1, N'O''Reilly', 1, '12345678-1234-1234-1234-1234567890ab', 0x0102A0FF, '2026-07-22T10:20:30+09:00');"
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
