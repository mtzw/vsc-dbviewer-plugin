import { ColumnInfo } from "./types";

export interface ValidationColumn {
  name: string;
  jdbcType: number | null;
  typeName: string | null;
  nullable: boolean;
}

export function validationColumns(columns: ColumnInfo[]): ValidationColumn[] {
  return columns.map((column) => ({
    name: column.name,
    jdbcType: column.jdbcType,
    typeName: column.typeName,
    nullable: column.nullable
  }));
}

export function validateRowValues(
  columns: ValidationColumn[],
  rows: Array<Array<string | null>>,
  rowLabel: (rowIndex: number) => string
): string[] {
  const errors: string[] = [];
  rows.forEach((row, rowIndex) => {
    columns.forEach((column, columnIndex) => {
      const value = row[columnIndex] ?? null;
      const error = validateValue(column, value);
      if (error) {
        errors.push(`${rowLabel(rowIndex)} ${column.name}: ${error}`);
      }
    });
  });
  return errors;
}

export function validateValue(column: ValidationColumn, value: string | null): string | null {
  const kind = validationKind(column);
  if (value === null) {
    return column.nullable ? null : "NULLは指定できません。";
  }
  if (value === "") {
    return kind === "string" ? null : "空文字は指定できません。NULLにする場合は \\N を入力してください。";
  }
  if (kind === "integer" && !/^[+-]?\d+$/.test(value)) {
    return "整数を入力してください。";
  }
  if (kind === "decimal" && !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
    return "数値を入力してください。";
  }
  if (kind === "boolean" && !/^(true|false|t|f|1|0|yes|no|y|n)$/i.test(value.trim())) {
    return "true/false、1/0、yes/noのいずれかを入力してください。";
  }
  if (kind === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return "日付はyyyy-mm-dd形式で入力してください。";
  }
  if (kind === "time" && !/^\d{2}:\d{2}:\d{2}$/.test(value)) {
    return "時刻はHH:mm:ss形式で入力してください。";
  }
  if (kind === "timestamp" && !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/.test(value)) {
    return "日時はyyyy-mm-dd HH:mm:ssまたはyyyy-mm-ddTHH:mm:ss形式で入力してください。";
  }
  return null;
}

export function updateInputType(column: ValidationColumn): "text" | "date" | "time" | "datetime-local" {
  const kind = validationKind(column);
  if (kind === "date") {
    return "date";
  }
  if (kind === "time") {
    return "time";
  }
  if (kind === "timestamp") {
    return "datetime-local";
  }
  return "text";
}

export function normalizeTemporalInputValue(column: ValidationColumn, value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  const text = String(value);
  const kind = validationKind(column);
  if (kind === "timestamp") {
    return text.replace(" ", "T").replace(/(\.\d+)?(?:[+-]\d{2}:?\d{2}|Z)?$/, "").slice(0, 19);
  }
  if (kind === "date") {
    return text.slice(0, 10);
  }
  if (kind === "time") {
    return text.slice(0, 8);
  }
  return text;
}

type ValidationKind = "integer" | "decimal" | "boolean" | "date" | "time" | "timestamp" | "string";

function validationKind(column: ValidationColumn): ValidationKind {
  if (isDate(column)) {
    return "date";
  }
  if (isTime(column)) {
    return "time";
  }
  if (isTimestamp(column)) {
    return "timestamp";
  }
  if (isBoolean(column)) {
    return "boolean";
  }
  if (isInteger(column)) {
    return "integer";
  }
  if (isDecimal(column)) {
    return "decimal";
  }
  return "string";
}

function isInteger(column: ValidationColumn): boolean {
  return matchesJdbcType(column, [-6, -5, 4, 5]) || matchesTypeName(column, ["tinyint", "smallint", "integer", "int", "bigint"]);
}

function isDecimal(column: ValidationColumn): boolean {
  return matchesJdbcType(column, [2, 3, 6, 7, 8]) || matchesTypeName(column, ["numeric", "decimal", "number", "float", "real", "double"]);
}

function isBoolean(column: ValidationColumn): boolean {
  return matchesJdbcType(column, [-7, 16]) || matchesTypeName(column, ["boolean", "bool", "bit"]);
}

function isDate(column: ValidationColumn): boolean {
  return matchesJdbcType(column, [91]) || normalizedTypeName(column) === "date";
}

function isTime(column: ValidationColumn): boolean {
  const typeName = normalizedTypeName(column);
  return matchesJdbcType(column, [92, 2013]) || typeName === "time" || typeName.startsWith("time(") || typeName.startsWith("time ");
}

function isTimestamp(column: ValidationColumn): boolean {
  return matchesJdbcType(column, [93]) || normalizedTypeName(column).startsWith("timestamp") && !normalizedTypeName(column).includes("time zone");
}

function matchesJdbcType(column: ValidationColumn, jdbcTypes: number[]): boolean {
  return column.jdbcType !== null && jdbcTypes.includes(column.jdbcType);
}

function matchesTypeName(column: ValidationColumn, names: string[]): boolean {
  const typeName = normalizedTypeName(column);
  return names.some((name) => typeName === name || typeName.startsWith(`${name}(`));
}

function normalizedTypeName(column: ValidationColumn): string {
  return (column.typeName ?? "").trim().toLowerCase();
}
