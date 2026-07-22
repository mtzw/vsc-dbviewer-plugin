import { DatabaseType, DataColumnInfo } from "./types";

export function quoteSqlIdentifier(identifier: string, metadataQuote: string, dbType: DatabaseType): string {
  if (dbType === "sqlserver") {
    return "[" + identifier.replaceAll("]", "]]") + "]";
  }
  if (!metadataQuote) {
    return identifier;
  }
  return `${metadataQuote}${identifier.replaceAll(metadataQuote, metadataQuote + metadataQuote)}${metadataQuote}`;
}

export function booleanSqlLiteral(value: boolean, dbType: DatabaseType): string {
  if (dbType === "sqlserver") {
    return value ? "1" : "0";
  }
  return value ? "TRUE" : "FALSE";
}

export function sqlServerStringLiteral(value: string, column: DataColumnInfo | undefined): string | undefined {
  if (column && isBinaryColumn(column) && value.startsWith("base64:")) {
    return `0x${Buffer.from(value.slice("base64:".length), "base64").toString("hex").toUpperCase()}`;
  }
  if (column && isUnicodeColumn(column)) {
    return `N${quoteSqlString(value)}`;
  }
  return undefined;
}

export function quoteSqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function isUnicodeColumn(column: DataColumnInfo): boolean {
  const typeName = normalizedTypeName(column);
  return typeName === "nchar" || typeName === "nvarchar" || typeName === "ntext" || typeName === "xml";
}

function isBinaryColumn(column: DataColumnInfo): boolean {
  const typeName = normalizedTypeName(column);
  return [-2, -3, -4, 2004].includes(column.jdbcType ?? 0)
    || typeName === "binary"
    || typeName === "varbinary"
    || typeName === "image"
    || typeName === "timestamp"
    || typeName === "rowversion";
}

function normalizedTypeName(column: DataColumnInfo): string {
  return (column.typeName ?? "").trim().toLowerCase().replace(/\s*\(max\)$/, "");
}
