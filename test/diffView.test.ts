import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_DIFF_VIEW_QUERY, getDiffRow, selectDiffViewPage } from "../src/diffView";
import { TableDiff, TableDiffRow } from "../src/tableDiff";

test("paginates all diff rows without dropping rows after the first 50", () => {
  const diff = createDiff({
    updatedRows: Array.from({ length: 121 }, (_, index) => updated(index + 1, index % 2 === 0 ? "NAME" : "STATUS"))
  });

  const page = selectDiffViewPage(diff, { ...DEFAULT_DIFF_VIEW_QUERY, page: 3 }, 50);

  assert.equal(page.totalRows, 121);
  assert.equal(page.filteredRows, 121);
  assert.equal(page.pageCount, 3);
  assert.equal(page.firstRowNumber, 101);
  assert.equal(page.lastRowNumber, 121);
  assert.equal(page.rows.length, 21);
  assert.deepEqual(page.rows[0].row.key, [101]);
});

test("filters by status, primary key and changed column case-insensitively", () => {
  const diff = createDiff({
    addedRows: [{ status: "ADDED", key: [10], changedColumns: [], after: [10, "Added"] }],
    updatedRows: [
      { status: "UPDATED", key: [20, "AbC"], changedColumns: ["Display_Name"], before: [20, "Old"], after: [20, "New"] },
      { status: "UPDATED", key: [21, "xyz"], changedColumns: ["STATUS"], before: [21, "A"], after: [21, "B"] }
    ]
  });

  const page = selectDiffViewPage(diff, {
    page: 1,
    status: "UPDATED",
    keyQuery: "abc",
    columnQuery: "name"
  }, 50);

  assert.equal(page.filteredRows, 1);
  assert.deepEqual(page.rows[0].row.key, [20, "AbC"]);
});

test("clamps page numbers and resolves detail rows by source index", () => {
  const diff = createDiff({
    addedRows: [{ status: "ADDED", key: [1], changedColumns: [], after: [1, "A"] }],
    removedRows: [{ status: "REMOVED", key: [2], changedColumns: [], before: [2, "B"] }]
  });

  const page = selectDiffViewPage(diff, { ...DEFAULT_DIFF_VIEW_QUERY, page: 99 }, 1);

  assert.equal(page.page, 2);
  assert.equal(page.rows[0].sourceIndex, 1);
  assert.equal(getDiffRow(diff, 1)?.status, "REMOVED");
  assert.equal(getDiffRow(diff, 99), undefined);
});

function updated(id: number, column: string): TableDiffRow {
  return { status: "UPDATED", key: [id], changedColumns: [column], before: [id, "old"], after: [id, "new"] };
}

function createDiff(overrides: Partial<TableDiff>): TableDiff {
  return {
    baselineSnapshotId: "snapshot",
    comparedAt: "2026-07-22T00:00:00.000Z",
    object: { schema: "APP", name: "PERSON", type: "TABLE" },
    beforeCreatedAt: "2026-07-21T00:00:00.000Z",
    beforeRowCount: 0,
    afterRowCount: 0,
    beforeFingerprint: "before",
    afterFingerprint: "after",
    changed: true,
    schemaChanged: false,
    rowClassificationAvailable: true,
    primaryKeys: ["ID"],
    columns: ["ID", "NAME"],
    excludedColumns: [],
    addedRows: [],
    removedRows: [],
    updatedRows: [],
    unchangedRowCount: 0,
    ...overrides
  };
}
