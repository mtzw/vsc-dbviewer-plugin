import { DbObject, ObjectInfo } from "./types";
import { isWritableColumn, validateRowValues, validationColumns } from "./valueValidation";

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
  const writableColumns = info.columns.filter(isWritableColumn);
  const columns = writableColumns.map((column) => column.name);
  const parsed = parseTsv(text);
  const rows: Array<Array<string | null>> = parsed.rows.map((row) => row.map((value) => value === "\\N" ? null : value));
  const errors: string[] = [...parsed.errors];
  let nullCount = 0;

  rows.forEach((row, index) => {
    nullCount += row.filter((value) => value === null).length;
    if (row.length !== columns.length) {
      errors.push(`Row ${index + 1}: expected ${columns.length} column(s), got ${row.length}.`);
    }
  });

  if (rows.length === 0) {
    errors.push("InsertするTSVを入力してください。");
  }

  if (object.type !== "TABLE") {
    errors.push("TSV InsertはTableのみ実行できます。");
  }
  if (columns.length === 0) {
    errors.push("Insert可能な列がありません。");
  }
  if (errors.length === 0) {
    errors.push(...validateRowValues(validationColumns(writableColumns), rows, (rowIndex) => `Row ${rowIndex + 1}`));
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

interface ParsedTsv {
  rows: string[][];
  errors: string[];
}

function parseTsv(text: string): ParsedTsv {
  const source = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const rows: string[][] = [];
  const errors: string[] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let afterClosingQuote = false;
  let recordHasContent = false;

  const finishField = () => {
    row.push(field);
    field = "";
    afterClosingQuote = false;
  };
  const finishRow = () => {
    finishField();
    if (recordHasContent) {
      rows.push(row);
    }
    row = [];
    recordHasContent = false;
  };

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          afterClosingQuote = true;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (afterClosingQuote) {
      if (char === "\t") {
        finishField();
        recordHasContent = true;
        continue;
      }
      if (char === "\n") {
        finishRow();
        continue;
      }
      errors.push(`Row ${rows.length + 1}: unexpected character after closing quote.`);
      afterClosingQuote = false;
    }

    if (char === "\t") {
      finishField();
      recordHasContent = true;
    } else if (char === "\n") {
      finishRow();
    } else if (char === '"' && field.length === 0) {
      inQuotes = true;
      recordHasContent = true;
    } else {
      field += char;
      recordHasContent = true;
    }
  }

  if (inQuotes) {
    errors.push(`Row ${rows.length + 1}: quoted field is not closed.`);
  }
  if (recordHasContent || row.length > 0 || field.length > 0) {
    finishRow();
  }
  return { rows, errors };
}
