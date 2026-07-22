import { DatabaseType, DataColumnInfo, DbObject, ObjectData } from "./types";
import { booleanSqlLiteral, quoteSqlIdentifier, quoteSqlString, sqlServerStringLiteral } from "./sqlDialect";

export function toTsv(data: ObjectData, rowIndexes: number[]): string {
  return rowIndexes
    .map((rowIndex) => data.rows[rowIndex].map(formatTsvCell).join("\t"))
    .join("\n");
}

export function toExportTsv(data: ObjectData, rowIndexes: number[], includeHeader: boolean): string {
  const rows = rowIndexes.map((rowIndex) => data.rows[rowIndex].map(formatTsvCell).join("\t"));
  return includeHeader ? [data.columns.map(formatTsvCell).join("\t"), ...rows].join("\n") : rows.join("\n");
}

export function toExportCsv(data: ObjectData, rowIndexes: number[], includeHeader: boolean): string {
  const rows = rowIndexes.map((rowIndex) => data.rows[rowIndex].map(formatCsvCell).join(","));
  return includeHeader ? [data.columns.map(formatCsvCell).join(","), ...rows].join("\n") : rows.join("\n");
}

export function toInsertSql(
  data: ObjectData,
  object: DbObject,
  identifierQuoteString: string,
  rowIndexes: number[],
  dbType: DatabaseType = "other"
): string {
  const objectName = displayObjectName(object, identifierQuoteString, dbType);
  const columns = data.columns.map((column) => quoteSqlIdentifier(column, identifierQuoteString, dbType)).join(", ");
  return rowIndexes
    .map((rowIndex) => {
      const values = data.rows[rowIndex]
        .map((value, columnIndex) => toSqlLiteral(value, data.columnTypes?.[columnIndex], dbType))
        .join(", ");
      return `INSERT INTO ${objectName} (${columns}) VALUES (${values});`;
    })
    .join("\n");
}

export function displayObjectName(object: DbObject, identifierQuoteString: string, dbType: DatabaseType = "other"): string {
  return object.schema
    ? `${quoteSqlIdentifier(object.schema, identifierQuoteString, dbType)}.${quoteSqlIdentifier(object.name, identifierQuoteString, dbType)}`
    : quoteSqlIdentifier(object.name, identifierQuoteString, dbType);
}

function formatTsvCell(value: string | number | boolean | null): string {
  if (value === null) {
    return "";
  }
  return String(value).replace(/\r?\n/g, " ");
}

function formatCsvCell(value: string | number | boolean | null): string {
  if (value === null) {
    return "";
  }
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
}

function toSqlLiteral(value: string | number | boolean | null, column: DataColumnInfo | undefined, dbType: DatabaseType): string {
  if (value === null) {
    return "NULL";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : quoteSqlString(String(value));
  }
  if (typeof value === "boolean") {
    return booleanSqlLiteral(value, dbType);
  }
  if (dbType === "oracle") {
    const oracleLiteral = toOracleDateTimeLiteral(value, column);
    if (oracleLiteral) {
      return oracleLiteral;
    }
  }
  if (dbType === "sqlserver") {
    const sqlServerLiteral = sqlServerStringLiteral(value, column);
    if (sqlServerLiteral) {
      return sqlServerLiteral;
    }
  }
  return quoteSqlString(value);
}

function toOracleDateTimeLiteral(value: string, column: DataColumnInfo | undefined): string | undefined {
  if (!column || !isOracleDateTimeColumn(column)) {
    return undefined;
  }
  const normalized = value.trim().replace("T", " ");
  const dateMatch = /^(\d{4}-\d{2}-\d{2})$/.exec(normalized);
  if (dateMatch && isOracleDateColumn(column)) {
    return `DATE ${quoteSqlString(dateMatch[1])}`;
  }

  const dateTimeMatch = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)?$/.exec(normalized);
  if (dateTimeMatch) {
    const literal = `${dateTimeMatch[1]} ${dateTimeMatch[2]}${dateTimeMatch[3] ?? ""}`;
    if (isOracleDateColumn(column)) {
      return `TO_DATE(${quoteSqlString(`${dateTimeMatch[1]} ${dateTimeMatch[2]}`)}, ${quoteSqlString("YYYY-MM-DD HH24:MI:SS")})`;
    }
    return `TIMESTAMP ${quoteSqlString(literal)}`;
  }

  const timeZoneMatch = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(\.\d+)? ?(Z|[+-]\d{2}:?\d{2}|[A-Za-z_\/]+)$/.exec(normalized);
  if (timeZoneMatch && isOracleTimestampWithTimeZoneColumn(column)) {
    const zone = timeZoneMatch[4] === "Z" ? "+00:00" : timeZoneMatch[4];
    const literal = `${timeZoneMatch[1]} ${timeZoneMatch[2]}${timeZoneMatch[3] ?? ""} ${zone}`;
    const zoneFormat = /^[+-]\d{2}:?\d{2}$/.test(zone) ? "TZH:TZM" : "TZR";
    const format = `${timeZoneMatch[3] ? "YYYY-MM-DD HH24:MI:SS.FF" : "YYYY-MM-DD HH24:MI:SS"} ${zoneFormat}`;
    return `TO_TIMESTAMP_TZ(${quoteSqlString(literal)}, ${quoteSqlString(format)})`;
  }

  if (isOracleTimestampColumn(column)) {
    return `TO_TIMESTAMP(${quoteSqlString(value)}, ${quoteSqlString("YYYY-MM-DD HH24:MI:SS.FF")})`;
  }
  return undefined;
}

function isOracleDateTimeColumn(column: DataColumnInfo): boolean {
  return isOracleDateColumn(column) || isOracleTimestampColumn(column) || isOracleTimestampWithTimeZoneColumn(column);
}

function isOracleDateColumn(column: DataColumnInfo): boolean {
  return column.jdbcType === 91 || (column.typeName ?? "").toUpperCase() === "DATE";
}

function isOracleTimestampColumn(column: DataColumnInfo): boolean {
  const typeName = (column.typeName ?? "").toUpperCase();
  return column.jdbcType === 93 || typeName.startsWith("TIMESTAMP");
}

function isOracleTimestampWithTimeZoneColumn(column: DataColumnInfo): boolean {
  const typeName = (column.typeName ?? "").toUpperCase();
  return column.jdbcType === 2014 || typeName.includes("WITH TIME ZONE") || typeName.includes("WITH LOCAL TIME ZONE");
}
