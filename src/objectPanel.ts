import * as vscode from "vscode";
import * as fs from "node:fs";
import { toExportCsv, toExportTsv, toInsertSql, toTsv } from "./copyFormat";
import { JdbcClient } from "./jdbcClient";
import { ProfileStore } from "./profileStore";
import { buildTsvInsertPreview, TsvInsertPreview } from "./tsvInsert";
import { DbObject, ObjectData, ObjectDdl, ObjectInfo, ConnectionProfile, InsertRowsResult } from "./types";

type ExportFormat = "csv" | "tsv" | "insert";
type SortDirection = "ASC" | "DESC";
interface DataQuery {
  where: string;
  sortColumn: string | null;
  sortDirection: SortDirection;
}

const EXPORT_PAGE_SIZE = 1000;
const DATA_PAGE_SIZE = 100;

export class ObjectPanel {
  static async open(
    context: vscode.ExtensionContext,
    store: ProfileStore,
    client: JdbcClient,
    profile: ConnectionProfile,
    object: DbObject
  ): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
      "dbViewer.object",
      `${profile.name}: ${object.name}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true
      }
    );
    panel.webview.html = renderLoading(profile, object);

    try {
      const password = await store.getPassword(profile);
      const [info, ddl] = await Promise.all([
        client.request<ObjectInfo>(profile, password, "getObjectInfo", { object }),
        client.request<ObjectDdl>(profile, password, "getObjectDdl", { object })
      ]);
      let query: DataQuery = { where: "", sortColumn: null, sortDirection: "ASC" };
      const firstPage = await loadObjectData(client, profile, password, object, query, 0, DATA_PAGE_SIZE);
      let currentData = firstPage;
      let tsvInsertPreview: TsvInsertPreview | undefined;
      panel.webview.html = renderObject(context, panel.webview, profile, object, info, currentData, ddl, "info", query, tsvInsertPreview);

      panel.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
        try {
          if (message.type === "loadMore") {
            if (!currentData.hasNext) {
              return;
            }
            const nextPage = await loadObjectData(client, profile, password, object, query, currentData.offset + currentData.rows.length, currentData.limit);
            currentData = {
              ...nextPage,
              rows: [...currentData.rows, ...nextPage.rows],
              offset: 0,
              hasPrevious: false
            };
            panel.webview.html = renderObject(context, panel.webview, profile, object, info, currentData, ddl, "data", query, tsvInsertPreview);
            return;
          }

          if (message.type === "reload") {
            tsvInsertPreview = undefined;
            currentData = await loadObjectData(client, profile, password, object, query, 0, currentData.limit);
            panel.webview.html = renderObject(context, panel.webview, profile, object, info, currentData, ddl, "data", query, tsvInsertPreview);
            return;
          }

          if (message.type === "search") {
            tsvInsertPreview = undefined;
            query = { ...query, where: message.where.trim() };
            currentData = await loadObjectData(client, profile, password, object, query, 0, currentData.limit);
            panel.webview.html = renderObject(context, panel.webview, profile, object, info, currentData, ddl, "data", query, tsvInsertPreview);
            return;
          }

          if (message.type === "sort") {
            tsvInsertPreview = undefined;
            query = {
              ...query,
              sortColumn: message.column,
              sortDirection: query.sortColumn === message.column && query.sortDirection === "ASC" ? "DESC" : "ASC"
            };
            currentData = await loadObjectData(client, profile, password, object, query, 0, currentData.limit);
            panel.webview.html = renderObject(context, panel.webview, profile, object, info, currentData, ddl, "data", query, tsvInsertPreview);
            return;
          }

          if (message.type === "copy") {
            const rowIndexes = message.rowIndexes.filter((rowIndex) => rowIndex >= 0 && rowIndex < currentData.rows.length);
            if (rowIndexes.length === 0) {
              vscode.window.showInformationMessage("コピーする行を選択してください。");
              return;
            }
            const text = message.format === "tsv"
              ? toTsv(currentData, rowIndexes)
              : toInsertSql(currentData, object, info.identifierQuoteString, rowIndexes, profile.dbType);
            await vscode.env.clipboard.writeText(text);
            vscode.window.showInformationMessage(`${rowIndexes.length} row(s) copied as ${message.format === "tsv" ? "TSV" : "INSERT SQL"}.`);
            return;
          }

          if (message.type === "export") {
            await exportObject(client, profile, password, object, info, message.format, query);
            return;
          }

          if (message.type === "previewTsvInsert") {
            tsvInsertPreview = buildTsvInsertPreview(object, info, message.tsv);
            panel.webview.html = renderObject(context, panel.webview, profile, object, info, currentData, ddl, "data", query, tsvInsertPreview);
            return;
          }

          if (message.type === "cancelTsvInsert") {
            tsvInsertPreview = undefined;
            panel.webview.html = renderObject(context, panel.webview, profile, object, info, currentData, ddl, "data", query, tsvInsertPreview);
            return;
          }

          if (message.type === "confirmTsvInsert") {
            if (!tsvInsertPreview || tsvInsertPreview.errors.length > 0) {
              vscode.window.showErrorMessage("TSV Insertのプレビューを確認してください。");
              return;
            }
            const result = await client.request<InsertRowsResult>(profile, password, "insertRows", {
              object,
              columns: tsvInsertPreview.columns,
              rows: tsvInsertPreview.rows
            });
            vscode.window.showInformationMessage(`${result.insertedRows} row(s) inserted into ${object.name}.`);
            tsvInsertPreview = undefined;
            currentData = await loadObjectData(client, profile, password, object, query, 0, currentData.limit);
            panel.webview.html = renderObject(context, panel.webview, profile, object, info, currentData, ddl, "data", query, tsvInsertPreview);
          }
        } catch (error) {
          vscode.window.showErrorMessage((error as Error).message);
        }
      });
    } catch (error) {
      panel.webview.html = renderError(profile, object, (error as Error).message);
    }
  }
}

type WebviewMessage =
  | { type: "loadMore" }
  | { type: "reload" }
  | { type: "search"; where: string }
  | { type: "sort"; column: string }
  | { type: "copy"; format: "tsv" | "insert"; rowIndexes: number[] }
  | { type: "export"; format: ExportFormat }
  | { type: "previewTsvInsert"; tsv: string }
  | { type: "cancelTsvInsert" }
  | { type: "confirmTsvInsert" };

async function loadObjectData(
  client: JdbcClient,
  profile: ConnectionProfile,
  password: string,
  object: DbObject,
  query: DataQuery,
  offset: number,
  limit: number
): Promise<ObjectData> {
  return client.request<ObjectData>(profile, password, "getObjectData", {
    object,
    limit,
    offset,
    where: query.where || undefined,
    sortColumn: query.sortColumn ?? undefined,
    sortDirection: query.sortColumn ? query.sortDirection : undefined
  });
}

async function exportObject(
  client: JdbcClient,
  profile: ConnectionProfile,
  password: string,
  object: DbObject,
  info: ObjectInfo,
  format: ExportFormat,
  query: DataQuery
): Promise<void> {
  const target = await vscode.window.showSaveDialog({
    defaultUri: defaultExportUri(object, format),
    filters: exportFilters(format),
    saveLabel: "Export"
  });
  if (!target) {
    return;
  }
  if (target.scheme !== "file") {
    throw new Error("ローカルファイルとして保存できる場所を選択してください。");
  }

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Exporting ${object.name}`,
      cancellable: true
    },
    async (progress, token) => {
      const writer = fs.createWriteStream(target.fsPath, { encoding: "utf8" });
      let offset = 0;
      let total = 0;
      let firstChunk = true;
      try {
        while (!token.isCancellationRequested) {
          const page = await loadObjectData(client, profile, password, object, query, offset, EXPORT_PAGE_SIZE);
          const rowIndexes = page.rows.map((_, rowIndex) => rowIndex);
          const chunk = formatExportChunk(page, object, info, format, rowIndexes, firstChunk, profile);
          if (chunk) {
            if (!firstChunk) {
              writer.write("\n");
            }
            writer.write(chunk);
          }
          total += page.rows.length;
          progress.report({ message: `${total} rows exported` });
          firstChunk = false;
          if (!page.hasNext || page.rows.length === 0) {
            break;
          }
          offset += page.rows.length;
        }
      } finally {
        await closeWriter(writer);
      }

      if (token.isCancellationRequested) {
        vscode.window.showWarningMessage(`Export cancelled. Partial file remains: ${target.fsPath}`);
        return;
      }
      vscode.window.showInformationMessage(`${total} row(s) exported to ${target.fsPath}.`);
    }
  );
}

function formatExportChunk(
  data: ObjectData,
  object: DbObject,
  info: ObjectInfo,
  format: ExportFormat,
  rowIndexes: number[],
  includeHeader: boolean,
  profile: ConnectionProfile
): string {
  if (format === "csv") {
    return toExportCsv(data, rowIndexes, includeHeader);
  }
  if (format === "tsv") {
    return toExportTsv(data, rowIndexes, includeHeader);
  }
  return toInsertSql(data, object, info.identifierQuoteString, rowIndexes, profile.dbType);
}

function defaultExportFileName(object: DbObject, format: ExportFormat): string {
  const extension = format === "insert" ? "sql" : format;
  const schema = object.schema ? `${sanitizeFileName(object.schema)}.` : "";
  return `${schema}${sanitizeFileName(object.name)}.${extension}`;
}

function defaultExportUri(object: DbObject, format: ExportFormat): vscode.Uri | undefined {
  const fileName = defaultExportFileName(object, format);
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  return workspaceFolder ? vscode.Uri.joinPath(workspaceFolder.uri, fileName) : undefined;
}

function sanitizeFileName(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "_");
}

function exportFilters(format: ExportFormat): Record<string, string[]> {
  if (format === "csv") {
    return { CSV: ["csv"] };
  }
  if (format === "tsv") {
    return { TSV: ["tsv", "txt"] };
  }
  return { SQL: ["sql"] };
}

function closeWriter(writer: fs.WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    writer.once("error", reject);
    writer.end(resolve);
  });
}

function renderLoading(profile: ConnectionProfile, object: DbObject): string {
  return shell(profile, object, "<p class=\"muted\">Loading...</p>");
}

function renderError(profile: ConnectionProfile, object: DbObject, message: string): string {
  return shell(profile, object, `<p class="error">${escapeHtml(message)}</p>`);
}

function renderObject(
  _context: vscode.ExtensionContext,
  _webview: vscode.Webview,
  profile: ConnectionProfile,
  object: DbObject,
  info: ObjectInfo,
  data: ObjectData,
  ddl: ObjectDdl,
  activeTab: "info" | "constraints" | "indexes" | "data" | "ddl",
  query: DataQuery,
  tsvInsertPreview?: TsvInsertPreview
): string {
  const nonce = createNonce();
  const content = `
    <div class="tabs" role="tablist">
      <button class="tab ${activeTab === "info" ? "active" : ""}" data-tab="info" type="button">情報</button>
      <button class="tab ${activeTab === "constraints" ? "active" : ""}" data-tab="constraints" type="button">制約</button>
      <button class="tab ${activeTab === "indexes" ? "active" : ""}" data-tab="indexes" type="button">インデックス</button>
      <button class="tab ${activeTab === "data" ? "active" : ""}" data-tab="data" type="button">データ</button>
      <button class="tab ${activeTab === "ddl" ? "active" : ""}" data-tab="ddl" type="button">定義SQL</button>
    </div>
    <section id="info" class="panel ${activeTab === "info" ? "active" : ""}">
      <h2>Columns</h2>
      ${renderInfo(info)}
    </section>
    <section id="constraints" class="panel ${activeTab === "constraints" ? "active" : ""}">
      <h2>Constraints</h2>
      ${renderConstraints(info)}
    </section>
    <section id="indexes" class="panel ${activeTab === "indexes" ? "active" : ""}">
      <h2>Indexes</h2>
      ${renderIndexes(info)}
    </section>
    <section id="data" class="panel ${activeTab === "data" ? "active" : ""}">
      <h2>Data <span class="muted">${data.rows.length} loaded</span></h2>
      ${renderData(data, query, object, tsvInsertPreview)}
    </section>
    <section id="ddl" class="panel ${activeTab === "ddl" ? "active" : ""}">
      <h2>Definition SQL</h2>
      ${ddl.ddl ? `<pre>${escapeHtml(ddl.ddl)}</pre>` : `<p class="muted">${escapeHtml(ddl.message ?? "DDL is not available for this database.")}</p>`}
    </section>
    <script nonce="${nonce}">
      (() => {
        const tabs = Array.from(document.querySelectorAll(".tab"));
        const panels = Array.from(document.querySelectorAll(".panel"));
        const vscode = acquireVsCodeApi();
        const selectedCount = document.querySelector("#selected-count");
        const whereInput = document.querySelector("#where-input");
        const reloadData = document.querySelector("#reload-data");
        const applySearch = document.querySelector("#apply-search");
        const clearSearch = document.querySelector("#clear-search");
        const copyTsv = document.querySelector("#copy-tsv");
        const copyInsert = document.querySelector("#copy-insert");
        const exportCsv = document.querySelector("#export-csv");
        const exportTsv = document.querySelector("#export-tsv");
        const exportInsert = document.querySelector("#export-insert");
        const openTsvInsert = document.querySelector("#open-tsv-insert");
        const tsvInsertModal = document.querySelector("#tsv-insert-modal");
        const tsvInsertInput = document.querySelector("#tsv-insert-input");
        const previewTsvInsert = document.querySelector("#preview-tsv-insert");
        const cancelTsvInsert = document.querySelector("#cancel-tsv-insert");
        const confirmTsvInsert = document.querySelector("#confirm-tsv-insert");
        const selectAll = document.querySelector("#select-all");
        const clearSelection = document.querySelector("#clear-selection");
        const loadStatus = document.querySelector("#load-status");
        const dataPanel = document.querySelector("#data");
        const rowChecks = Array.from(document.querySelectorAll(".row-check"));
        const rows = Array.from(document.querySelectorAll("tbody tr[data-row-index]"));
        let loadingMore = false;
        const hasNext = ${data.hasNext ? "true" : "false"};

        const selectedRows = () => rowChecks
          .filter((check) => check.checked)
          .map((check) => Number(check.dataset.rowIndex));

        const updateSelectionState = () => {
          const count = selectedRows().length;
          selectedCount.textContent = String(count);
          copyTsv.disabled = count === 0;
          copyInsert.disabled = count === 0;
          for (const row of rows) {
            const check = row.querySelector(".row-check");
            row.classList.toggle("selected-row", Boolean(check && check.checked));
          }
        };

        for (const tab of tabs) {
          tab.addEventListener("click", () => {
            const target = tab.dataset.tab;
            for (const current of tabs) {
              current.classList.toggle("active", current === tab);
            }
            for (const panel of panels) {
              panel.classList.toggle("active", panel.id === target);
            }
          });
        }

        for (const check of rowChecks) {
          check.addEventListener("change", updateSelectionState);
        }
        selectAll.addEventListener("click", () => {
          for (const check of rowChecks) {
            check.checked = true;
          }
          updateSelectionState();
        });
        clearSelection.addEventListener("click", () => {
          for (const check of rowChecks) {
            check.checked = false;
          }
          updateSelectionState();
        });
        copyTsv.addEventListener("click", () => vscode.postMessage({ type: "copy", format: "tsv", rowIndexes: selectedRows() }));
        copyInsert.addEventListener("click", () => vscode.postMessage({ type: "copy", format: "insert", rowIndexes: selectedRows() }));
        exportCsv.addEventListener("click", () => vscode.postMessage({ type: "export", format: "csv" }));
        exportTsv.addEventListener("click", () => vscode.postMessage({ type: "export", format: "tsv" }));
        exportInsert.addEventListener("click", () => vscode.postMessage({ type: "export", format: "insert" }));
        if (openTsvInsert && tsvInsertModal && tsvInsertInput) {
          openTsvInsert.addEventListener("click", () => {
            tsvInsertModal.classList.add("active");
            tsvInsertInput.focus();
          });
        }
        if (previewTsvInsert && tsvInsertInput) {
          previewTsvInsert.addEventListener("click", () => vscode.postMessage({ type: "previewTsvInsert", tsv: tsvInsertInput.value }));
        }
        if (cancelTsvInsert) {
          cancelTsvInsert.addEventListener("click", () => vscode.postMessage({ type: "cancelTsvInsert" }));
        }
        if (confirmTsvInsert) {
          confirmTsvInsert.addEventListener("click", () => vscode.postMessage({ type: "confirmTsvInsert" }));
        }
        reloadData.addEventListener("click", () => vscode.postMessage({ type: "reload" }));
        applySearch.addEventListener("click", () => vscode.postMessage({ type: "search", where: whereInput.value }));
        clearSearch.addEventListener("click", () => {
          whereInput.value = "";
          vscode.postMessage({ type: "search", where: "" });
        });
        whereInput.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            vscode.postMessage({ type: "search", where: whereInput.value });
          }
        });
        for (const sortButton of Array.from(document.querySelectorAll(".sort-column"))) {
          sortButton.addEventListener("click", () => vscode.postMessage({ type: "sort", column: sortButton.dataset.column }));
        }
        window.addEventListener("scroll", () => {
          if (!dataPanel.classList.contains("active") || loadingMore || !hasNext) {
            return;
          }
          const remaining = document.documentElement.scrollHeight - window.scrollY - window.innerHeight;
          if (remaining < 240) {
            loadingMore = true;
            loadStatus.textContent = "Loading more rows...";
            vscode.postMessage({ type: "loadMore" });
          }
        });
        updateSelectionState();
      })();
    </script>
  `;
  return shell(profile, object, content, nonce);
}

function renderInfo(info: ObjectInfo): string {
  const primaryKeys = new Set(info.primaryKeys);
  const rows = info.columns.map((column) => `
    <tr>
      <td>${escapeHtml(column.name)}</td>
      <td>${escapeHtml(column.typeName)}${column.size ? `(${column.size})` : ""}</td>
      <td>${column.nullable ? "YES" : "NO"}</td>
      <td>${primaryKeys.has(column.name) ? "YES" : ""}</td>
      <td>${escapeHtml(column.defaultValue ?? "")}</td>
      <td>${escapeHtml(column.remarks ?? "")}</td>
    </tr>
  `).join("");
  return `
    <table>
      <thead><tr><th>Name</th><th>Type</th><th>Nullable</th><th>PK</th><th>Default</th><th>Remarks</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderConstraints(info: ObjectInfo): string {
  const rows = info.constraints.map((constraint) => {
    const referenced = constraint.referencedTable
      ? `${constraint.referencedSchema ? `${constraint.referencedSchema}.` : ""}${constraint.referencedTable}${constraint.referencedColumn ? `.${constraint.referencedColumn}` : ""}`
      : "";
    return `
      <tr>
        <td>${escapeHtml(constraint.name ?? "")}</td>
        <td>${escapeHtml(constraint.type)}</td>
        <td>${escapeHtml(constraint.columnName)}</td>
        <td>${constraint.ordinal ?? ""}</td>
        <td>${escapeHtml(referenced)}</td>
      </tr>
    `;
  }).join("");
  const body = rows || `<tr><td colspan="5" class="muted">No constraints found.</td></tr>`;
  return `
    <table>
      <thead><tr><th>Name</th><th>Type</th><th>Column</th><th>Seq</th><th>References</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  `;
}

function renderIndexes(info: ObjectInfo): string {
  const rows = info.indexes.map((index) => `
    <tr>
      <td>${escapeHtml(index.name ?? "")}</td>
      <td>${index.unique ? "YES" : "NO"}</td>
      <td>${escapeHtml(index.columnName ?? "")}</td>
      <td>${index.ordinal ?? ""}</td>
      <td>${escapeHtml(index.sortOrder ?? "")}</td>
      <td>${escapeHtml(index.type ?? "")}</td>
    </tr>
  `).join("");
  const body = rows || `<tr><td colspan="6" class="muted">No indexes found.</td></tr>`;
  return `
    <table>
      <thead><tr><th>Name</th><th>Unique</th><th>Column</th><th>Seq</th><th>Sort</th><th>Type</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  `;
}

function renderData(data: ObjectData, query: DataQuery, object: DbObject, tsvInsertPreview?: TsvInsertPreview): string {
  const headers = data.columns.map((column) => {
    const active = query.sortColumn === column;
    const marker = active ? (query.sortDirection === "ASC" ? " ▲" : " ▼") : "";
    return `<th><button class="sort-column ${active ? "active-sort" : ""}" type="button" data-column="${escapeHtml(column)}">${escapeHtml(column)}${marker}</button></th>`;
  }).join("");
  const rows = data.rows.map((row, rowIndex) => `
    <tr data-row-index="${rowIndex}">
      <td class="selector"><input class="row-check" type="checkbox" data-row-index="${rowIndex}" aria-label="Select row ${data.offset + rowIndex + 1}"></td>
      ${row.map((value) => `<td>${escapeHtml(value === null ? "NULL" : String(value))}</td>`).join("")}
    </tr>
  `).join("");
  const body = rows || `<tr><td colspan="${data.columns.length + 1}" class="muted">No rows found.</td></tr>`;
  return `
    <div class="data-toolbar">
      <div class="toolbar-group">
        <button id="reload-data" type="button" title="Reload data">↻ Reload</button>
      </div>
      <div class="toolbar-group">
        <input id="where-input" type="text" value="${escapeHtml(query.where)}" placeholder="where条件 例: ID &gt; 10">
        <button id="apply-search" type="button" title="Apply search">Search</button>
        <button id="clear-search" type="button" title="Clear search">Clear</button>
      </div>
      <div class="toolbar-group">
        <button id="select-all" type="button">全選択</button>
        <button id="clear-selection" type="button">選択解除</button>
        <span class="selection-count">選択: <span id="selected-count">0</span></span>
      </div>
      <div class="toolbar-group">
        <button id="copy-tsv" type="button" disabled>Copy TSV</button>
        <button id="copy-insert" type="button" disabled>Copy INSERT</button>
      </div>
      <div class="toolbar-group">
        <button id="export-csv" type="button">Save CSV</button>
        <button id="export-tsv" type="button">Save TSV</button>
        <button id="export-insert" type="button">Save INSERT</button>
      </div>
      ${object.type === "TABLE" ? `
        <div class="toolbar-group">
          <button id="open-tsv-insert" type="button">Paste TSV Insert</button>
        </div>
      ` : ""}
      <span class="toolbar-spacer"></span>
      <span class="muted">${data.rows.length} rows loaded</span>
    </div>
    ${object.type === "TABLE" ? renderTsvInsertModal(object, data, tsvInsertPreview) : ""}
    <table>
      <thead><tr><th class="selector"></th>${headers}</tr></thead>
      <tbody>${body}</tbody>
    </table>
    <div id="load-status" class="load-status muted">${data.hasNext ? "末尾までスクロールすると追加ロードします。" : "すべての表示可能な行を読み込みました。"}</div>
  `;
}

function renderTsvInsertModal(object: DbObject, data: ObjectData, preview?: TsvInsertPreview): string {
  const activeClass = preview ? " active" : "";
  const errors = preview?.errors ?? [];
  const hasErrors = errors.length > 0;
  const previewRows = preview?.previewRows ?? [];
  const previewHeaders = data.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("");
  const previewBody = previewRows.length > 0
    ? previewRows.map((row) => `
      <tr>${data.columns.map((_, index) => `<td>${escapeHtml(renderPreviewValue(row[index]))}</td>`).join("")}</tr>
    `).join("")
    : `<tr><td colspan="${Math.max(data.columns.length, 1)}" class="muted">PreviewするTSVを入力してください。</td></tr>`;
  const errorList = hasErrors
    ? `<ul class="insert-errors">${errors.map((error) => `<li>${escapeHtml(error)}</li>`).join("")}</ul>`
    : "";
  return `
    <div id="tsv-insert-modal" class="modal${activeClass}">
      <div class="modal-dialog" role="dialog" aria-modal="true" aria-label="TSV Insert Preview">
        <h3>Paste TSV Insert</h3>
        <div class="insert-summary">
          <span>Target: ${escapeHtml(object.schema ? `${object.schema}.${object.name}` : object.name)}</span>
          <span>Rows: ${preview?.rowCount ?? 0}</span>
          <span>Columns: ${data.columns.length}</span>
          <span>NULL: ${preview?.nullCount ?? 0}</span>
        </div>
        <textarea id="tsv-insert-input" spellcheck="false" placeholder="テーブル列順のTSVを貼り付けます。空欄は空文字、\\NはNULLとして扱います。">${escapeHtml(preview?.sourceText ?? "")}</textarea>
        ${errorList}
        <div class="preview-table">
          <table>
            <thead><tr>${previewHeaders}</tr></thead>
            <tbody>${previewBody}</tbody>
          </table>
        </div>
        <div class="modal-actions">
          <button id="cancel-tsv-insert" type="button">Cancel</button>
          <button id="preview-tsv-insert" type="button">Preview</button>
          <button id="confirm-tsv-insert" type="button" ${!preview || hasErrors ? "disabled" : ""}>Insert</button>
        </div>
      </div>
    </div>
  `;
}

function renderPreviewValue(value: string | null | undefined): string {
  if (value === null) {
    return "NULL";
  }
  return value ?? "";
}

function shell(profile: ConnectionProfile, object: DbObject, body: string, nonce = ""): string {
  const title = `${escapeHtml(profile.name)} / ${escapeHtml(object.schema ? `${object.schema}.` : "")}${escapeHtml(object.name)}`;
  const csp = nonce
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">`
    : `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">`;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  ${csp}
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-font-family); margin: 0; }
    header { padding: 14px 18px; border-bottom: 1px solid var(--vscode-panel-border); }
    h1 { font-size: 18px; margin: 0 0 4px; font-weight: 600; }
    h2 { font-size: 14px; margin: 18px 0 10px; }
    .muted { color: var(--vscode-descriptionForeground); font-weight: 400; }
    .error { color: var(--vscode-errorForeground); padding: 18px; }
    .tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--vscode-panel-border); padding: 8px 12px 0; }
    button { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); border: 0; padding: 7px 10px; cursor: pointer; }
    button:disabled { cursor: not-allowed; opacity: 0.55; }
    .tab { padding: 7px 12px; }
    .tab.active { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
    .panel { display: none; padding: 0 18px 18px; }
    .panel.active { display: block; }
    .data-toolbar { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; margin: 12px 0; }
    .toolbar-group { align-items: center; border: 1px solid var(--vscode-panel-border); display: flex; gap: 6px; padding: 4px; }
    .toolbar-spacer { flex: 1; }
    .selection-count { color: var(--vscode-descriptionForeground); min-width: 56px; padding: 0 4px; }
    #where-input { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); color: var(--vscode-input-foreground); min-width: 280px; padding: 6px 8px; }
    .load-status { padding: 12px 0 18px; text-align: center; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    th, td { border: 1px solid var(--vscode-panel-border); padding: 6px 8px; text-align: left; vertical-align: top; white-space: nowrap; }
    th { background: var(--vscode-editorWidget-background); position: sticky; top: 0; }
    tr.selected-row td { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
    .selector { text-align: center; width: 36px; }
    .sort-column { background: transparent; color: inherit; display: block; font: inherit; padding: 0; text-align: left; width: 100%; }
    .sort-column.active-sort { color: var(--vscode-textLink-foreground); font-weight: 600; }
    .modal { align-items: center; background: rgba(0, 0, 0, 0.35); display: none; inset: 0; justify-content: center; position: fixed; z-index: 10; }
    .modal.active { display: flex; }
    .modal-dialog { background: var(--vscode-editor-background); border: 1px solid var(--vscode-panel-border); box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35); max-height: 88vh; overflow: auto; padding: 16px; width: min(980px, calc(100vw - 36px)); }
    .modal-dialog h3 { font-size: 15px; margin: 0 0 10px; }
    .insert-summary { color: var(--vscode-descriptionForeground); display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 10px; }
    #tsv-insert-input { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); color: var(--vscode-input-foreground); box-sizing: border-box; font-family: var(--vscode-editor-font-family); min-height: 140px; padding: 8px; width: 100%; }
    .insert-errors { color: var(--vscode-errorForeground); margin: 10px 0; padding-left: 20px; }
    .preview-table { margin-top: 10px; max-height: 320px; overflow: auto; }
    .modal-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 12px; }
    pre { overflow: auto; background: var(--vscode-textCodeBlock-background); padding: 12px; }
  </style>
</head>
<body>
  <header>
    <h1>${title}</h1>
    <div class="muted">${escapeHtml(object.type)}</div>
  </header>
  ${body}
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case "\"": return "&quot;";
      case "'": return "&#39;";
      default: return char;
    }
  });
}

function createNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i += 1) {
    nonce += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return nonce;
}
