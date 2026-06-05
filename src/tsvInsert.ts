import { DbObject, ObjectInfo } from "./types";

export interface TsvInsertPreview {
  object: DbObject;
  columns: string[];
  sourceText: string;
  rows: Array<Array<string | null>>;
  rowCount: number;
  nullCount: number;
  previewRows: Array<Array<string | null>>;
  errors: string[];
}

const PREVIEW_ROW_LIMIT = 20;

export function buildTsvInsertPreview(object: DbObject, info: ObjectInfo, text: string): TsvInsertPreview {
  const columns = info.columns.map((column) => column.name);
  const rawRows = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((line) => line.length > 0);
  const rows: Array<Array<string | null>> = [];
  const errors: string[] = [];
  let nullCount = 0;

  rawRows.forEach((line, index) => {
    const values = line.split("\t").map((value) => {
      if (value === "\\N") {
        nullCount += 1;
        return null;
      }
      return value;
    });
    if (values.length !== columns.length) {
      errors.push(`Row ${index + 1}: expected ${columns.length} column(s), got ${values.length}.`);
    }
    rows.push(values);
  });

  if (rawRows.length === 0) {
    errors.push("InsertするTSVを入力してください。");
  }

  if (object.type !== "TABLE") {
    errors.push("TSV InsertはTableのみ実行できます。");
  }

  return {
    object,
    columns,
    sourceText: text,
    rows,
    rowCount: rows.length,
    nullCount,
    previewRows: rows.slice(0, PREVIEW_ROW_LIMIT),
    errors
  };
}
