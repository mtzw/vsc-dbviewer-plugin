import assert from "node:assert/strict";
import { test } from "node:test";
import { DATABASE_TYPES } from "../src/databaseTypes";
import { booleanSqlLiteral, quoteSqlIdentifier } from "../src/sqlDialect";

test("provides Microsoft SQL Server connection defaults", () => {
  const sqlServer = DATABASE_TYPES.find((databaseType) => databaseType.value === "sqlserver");

  assert.deepEqual(sqlServer, {
    label: "Microsoft SQL Server",
    value: "sqlserver",
    defaultDriverClass: "com.microsoft.sqlserver.jdbc.SQLServerDriver",
    jdbcUrlExample: "jdbc:sqlserver://localhost:1433;databaseName=database;encrypt=true"
  });
});

test("applies SQL Server identifier and boolean literal rules", () => {
  assert.equal(quoteSqlIdentifier("Order]Detail", "\"", "sqlserver"), "[Order]]Detail]");
  assert.equal(booleanSqlLiteral(true, "sqlserver"), "1");
  assert.equal(booleanSqlLiteral(false, "sqlserver"), "0");
});
