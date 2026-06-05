import { DbObject, ObjectData, ObjectInfo } from "./types";

export interface DeleteRowsPreview {
  object: DbObject;
  primaryKeyColumns: string[];
  rows: Array<Array<string | number | boolean | null>>;
  rowCount: number;
  previewRows: Array<Array<string | number | boolean | null>>;
  errors: string[];
}

const PREVIEW_ROW_LIMIT = 20;

export function buildDeleteRowsPreview(
  object: DbObject,
  info: ObjectInfo,
  data: ObjectData,
  rowIndexes: number[]
): DeleteRowsPreview {
  const primaryKeyColumns = info.primaryKeys;
  const errors: string[] = [];
  const columnIndexes = primaryKeyColumns.map((column) => findColumnIndex(data.columns, column));
  const validRowIndexes = rowIndexes.filter((rowIndex) => rowIndex >= 0 && rowIndex < data.rows.length);

  if (object.type !== "TABLE") {
    errors.push("選択行削除はTableのみ実行できます。");
  }
  if (primaryKeyColumns.length === 0) {
    errors.push("主キーが取得できないTableでは選択行削除を実行できません。");
  }
  const missingPrimaryKey = primaryKeyColumns.find((_, index) => columnIndexes[index] < 0);
  if (missingPrimaryKey) {
    errors.push(`表示データに主キー列 ${missingPrimaryKey} が含まれていません。`);
  }
  if (validRowIndexes.length === 0) {
    errors.push("削除する行を選択してください。");
  }

  const rows = validRowIndexes.map((rowIndex) => columnIndexes.map((columnIndex) => data.rows[rowIndex][columnIndex]));
  return {
    object,
    primaryKeyColumns,
    rows,
    rowCount: rows.length,
    previewRows: rows.slice(0, PREVIEW_ROW_LIMIT),
    errors
  };
}

function findColumnIndex(columns: string[], target: string): number {
  const exact = columns.indexOf(target);
  if (exact >= 0) {
    return exact;
  }
  const normalizedTarget = target.toLowerCase();
  return columns.findIndex((column) => column.toLowerCase() === normalizedTarget);
}
