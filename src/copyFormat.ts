import { DbObject, ObjectData } from "./types";

export function toTsv(data: ObjectData, rowIndexes: number[]): string {
  return rowIndexes
    .map((rowIndex) => data.rows[rowIndex].map(formatTsvCell).join("\t"))
    .join("\n");
}

export function toInsertSql(data: ObjectData, object: DbObject, identifierQuoteString: string, rowIndexes: number[]): string {
  const objectName = displayObjectName(object, identifierQuoteString);
  const columns = data.columns.map((column) => quoteIdentifier(column, identifierQuoteString)).join(", ");
  return rowIndexes
    .map((rowIndex) => {
      const values = data.rows[rowIndex].map(toSqlLiteral).join(", ");
      return `INSERT INTO ${objectName} (${columns}) VALUES (${values});`;
    })
    .join("\n");
}

export function displayObjectName(object: DbObject, identifierQuoteString: string): string {
  return object.schema
    ? `${quoteIdentifier(object.schema, identifierQuoteString)}.${quoteIdentifier(object.name, identifierQuoteString)}`
    : quoteIdentifier(object.name, identifierQuoteString);
}

function formatTsvCell(value: string | number | boolean | null): string {
  if (value === null) {
    return "";
  }
  return String(value).replace(/\r?\n/g, " ");
}

function toSqlLiteral(value: string | number | boolean | null): string {
  if (value === null) {
    return "NULL";
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : quoteString(String(value));
  }
  if (typeof value === "boolean") {
    return value ? "TRUE" : "FALSE";
  }
  return quoteString(value);
}

function quoteString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function quoteIdentifier(identifier: string, quote: string): string {
  if (!quote) {
    return identifier;
  }
  return `${quote}${identifier.replaceAll(quote, quote + quote)}${quote}`;
}
