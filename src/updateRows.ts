import { DbObject, ObjectData, ObjectInfo } from "./types";
import { validateRowValues, validationColumns } from "./valueValidation";

export type CellValue = string | number | boolean | null;

export interface UpdateRowsInput {
  rowIndex: number;
  values: Array<string | null>;
}

export interface UpdateRowsPreviewRow {
  rowIndex: number;
  primaryKeyValues: CellValue[];
  previousValues: CellValue[];
  values: Array<string | null>;
}

export interface UpdateRowsPreview {
  object: DbObject;
  primaryKeyColumns: string[];
  updateColumns: string[];
  inputColumns: string[];
  rows: UpdateRowsPreviewRow[];
  rowCount: number;
  previewRows: UpdateRowsPreviewRow[];
  errors: string[];
}

const PREVIEW_ROW_LIMIT = 20;

export function buildUpdateRowsPreview(
  object: DbObject,
  info: ObjectInfo,
  data: ObjectData,
  inputRows: UpdateRowsInput[]
): UpdateRowsPreview {
  const primaryKeyColumns = info.primaryKeys;
  const primaryKeyIndexes = primaryKeyColumns.map((column) => findColumnIndex(data.columns, column));
  const primaryKeySet = new Set(primaryKeyColumns.map((column) => column.toLowerCase()));
  const inputColumns = data.columns.filter((column) => !primaryKeySet.has(column.toLowerCase()));
  const inputColumnIndexes = inputColumns.map((column) => findColumnIndex(data.columns, column));
  const errors: string[] = [];

  if (object.type !== "TABLE") {
    errors.push("行UpdateはTableのみ実行できます。");
  }
  if (primaryKeyColumns.length === 0) {
    errors.push("主キーが取得できないTableでは行Updateを実行できません。");
  }
  const missingPrimaryKey = primaryKeyColumns.find((_, index) => primaryKeyIndexes[index] < 0);
  if (missingPrimaryKey) {
    errors.push(`表示データに主キー列 ${missingPrimaryKey} が含まれていません。`);
  }
  if (inputColumns.length === 0) {
    errors.push("更新可能な列がありません。");
  }

  const validInputRows = inputRows.filter((row) => row.rowIndex >= 0 && row.rowIndex < data.rows.length);
  if (validInputRows.length === 0) {
    errors.push("更新する行を選択してください。");
  }

  const changedColumnNames = new Set<string>();
  const normalizedRows = validInputRows.map((inputRow) => {
    const currentRow = data.rows[inputRow.rowIndex];
    inputColumns.forEach((column, index) => {
      const columnIndex = inputColumnIndexes[index];
      const nextValue = inputRow.values[index] ?? null;
      if (!sameCellValue(currentRow[columnIndex], nextValue)) {
        changedColumnNames.add(column);
      }
    });
    return inputRow;
  });
  const updateColumns = inputColumns.filter((column) => changedColumnNames.has(column));

  if (errors.length === 0) {
    if (updateColumns.length === 0 && validInputRows.length > 0) {
      errors.push("変更された列がありません。");
    }

    for (const row of normalizedRows) {
      if (row.values.length !== inputColumns.length) {
        errors.push(`Row ${row.rowIndex + 1}: expected ${inputColumns.length} update value(s), got ${row.values.length}.`);
      }
    }

    const validationColumnMap = new Map(validationColumns(info.columns).map((column) => [column.name.toLowerCase(), column]));
    const updateValidationColumns = updateColumns.map((column) => validationColumnMap.get(column.toLowerCase())).filter((column) => column !== undefined);
    errors.push(...validateRowValues(updateValidationColumns, normalizedRows.map((row) => updateColumns.map((column) => row.values[inputColumns.indexOf(column)] ?? null)), (rowIndex) => `Row ${normalizedRows[rowIndex].rowIndex + 1}`));
  }

  const rows = normalizedRows.map((inputRow) => {
    const currentRow = data.rows[inputRow.rowIndex];
    return {
      rowIndex: inputRow.rowIndex,
      primaryKeyValues: primaryKeyIndexes.map((columnIndex) => currentRow[columnIndex]),
      previousValues: updateColumns.map((column) => currentRow[findColumnIndex(data.columns, column)]),
      values: updateColumns.map((column) => inputRow.values[inputColumns.indexOf(column)] ?? null)
    };
  });

  return {
    object,
    primaryKeyColumns,
    updateColumns,
    inputColumns,
    rows,
    rowCount: rows.length,
    previewRows: rows.slice(0, PREVIEW_ROW_LIMIT),
    errors
  };
}

function sameCellValue(previous: CellValue, next: string | null): boolean {
  if (previous === null) {
    return next === null;
  }
  return String(previous) === (next ?? "");
}

function findColumnIndex(columns: string[], target: string): number {
  const exact = columns.indexOf(target);
  if (exact >= 0) {
    return exact;
  }
  const normalizedTarget = target.toLowerCase();
  return columns.findIndex((column) => column.toLowerCase() === normalizedTarget);
}
