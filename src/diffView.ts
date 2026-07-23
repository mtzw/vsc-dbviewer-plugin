import { DiffRowStatus, TableDiff, TableDiffRow } from "./tableDiff";

export type DiffStatusFilter = "ALL" | DiffRowStatus;

export interface DiffViewQuery {
  page: number;
  status: DiffStatusFilter;
  keyQuery: string;
  columnQuery: string;
}

export interface IndexedDiffRow {
  sourceIndex: number;
  row: TableDiffRow;
}

export interface DiffViewPage {
  rows: IndexedDiffRow[];
  totalRows: number;
  filteredRows: number;
  page: number;
  pageCount: number;
  pageSize: number;
  firstRowNumber: number;
  lastRowNumber: number;
}

export const DEFAULT_DIFF_VIEW_QUERY: DiffViewQuery = {
  page: 1,
  status: "ALL",
  keyQuery: "",
  columnQuery: ""
};

export function selectDiffViewPage(diff: TableDiff, query: DiffViewQuery, pageSize: number): DiffViewPage {
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
    throw new Error("差分ページサイズは1以上の整数で指定してください。");
  }
  const allRows = indexedDiffRows(diff);
  const keyQuery = normalize(query.keyQuery);
  const columnQuery = normalize(query.columnQuery);
  const filtered = allRows.filter(({ row }) =>
    (query.status === "ALL" || row.status === query.status)
    && (!keyQuery || normalize(JSON.stringify(row.key)).includes(keyQuery))
    && (!columnQuery || row.changedColumns.some((column) => normalize(column).includes(columnQuery)))
  );
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const requestedPage = Number.isSafeInteger(query.page) ? query.page : 1;
  const page = Math.min(Math.max(requestedPage, 1), pageCount);
  const start = (page - 1) * pageSize;
  const rows = filtered.slice(start, start + pageSize);

  return {
    rows,
    totalRows: allRows.length,
    filteredRows: filtered.length,
    page,
    pageCount,
    pageSize,
    firstRowNumber: rows.length > 0 ? start + 1 : 0,
    lastRowNumber: start + rows.length
  };
}

export function getDiffRow(diff: TableDiff, sourceIndex: number): TableDiffRow | undefined {
  if (!Number.isSafeInteger(sourceIndex) || sourceIndex < 0) {
    return undefined;
  }
  return indexedDiffRows(diff).find((current) => current.sourceIndex === sourceIndex)?.row;
}

function indexedDiffRows(diff: TableDiff): IndexedDiffRow[] {
  return [...diff.addedRows, ...diff.removedRows, ...diff.updatedRows]
    .map((row, sourceIndex) => ({ sourceIndex, row }));
}

function normalize(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}
