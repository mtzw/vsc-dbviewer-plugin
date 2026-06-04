import * as vscode from "vscode";
import { toInsertSql, toTsv } from "./copyFormat";
import { JdbcClient } from "./jdbcClient";
import { ProfileStore } from "./profileStore";
import { DbObject, ObjectData, ObjectDdl, ObjectInfo, ConnectionProfile } from "./types";

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
      const firstPage = await client.request<ObjectData>(profile, password, "getObjectData", { object, limit: 100, offset: 0 });
      let currentData = firstPage;
      panel.webview.html = renderObject(context, panel.webview, profile, object, info, currentData, ddl, "info");

      panel.webview.onDidReceiveMessage(async (message: WebviewMessage) => {
        try {
          if (message.type === "loadMore") {
            if (!currentData.hasNext) {
              return;
            }
            const nextPage = await client.request<ObjectData>(profile, password, "getObjectData", {
              object,
              limit: currentData.limit,
              offset: currentData.offset + currentData.rows.length
            });
            currentData = {
              ...nextPage,
              rows: [...currentData.rows, ...nextPage.rows],
              offset: 0,
              hasPrevious: false
            };
            panel.webview.html = renderObject(context, panel.webview, profile, object, info, currentData, ddl, "data");
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
              : toInsertSql(currentData, object, info.identifierQuoteString, rowIndexes);
            await vscode.env.clipboard.writeText(text);
            vscode.window.showInformationMessage(`${rowIndexes.length} row(s) copied as ${message.format === "tsv" ? "TSV" : "INSERT SQL"}.`);
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
  | { type: "copy"; format: "tsv" | "insert"; rowIndexes: number[] };

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
  activeTab: "info" | "data" | "ddl"
): string {
  const nonce = createNonce();
  const content = `
    <div class="tabs" role="tablist">
      <button class="tab ${activeTab === "info" ? "active" : ""}" data-tab="info" type="button">情報</button>
      <button class="tab ${activeTab === "data" ? "active" : ""}" data-tab="data" type="button">データ</button>
      <button class="tab ${activeTab === "ddl" ? "active" : ""}" data-tab="ddl" type="button">定義SQL</button>
    </div>
    <section id="info" class="panel ${activeTab === "info" ? "active" : ""}">
      <h2>Columns</h2>
      ${renderInfo(info)}
    </section>
    <section id="data" class="panel ${activeTab === "data" ? "active" : ""}">
      <h2>Data <span class="muted">${data.rows.length} loaded</span></h2>
      ${renderData(data)}
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
        const copyTsv = document.querySelector("#copy-tsv");
        const copyInsert = document.querySelector("#copy-insert");
        const selectAll = document.querySelector("#select-all");
        const clearSelection = document.querySelector("#clear-selection");
        const loadStatus = document.querySelector("#load-status");
        const dataPanel = document.querySelector("#data");
        const rowChecks = Array.from(document.querySelectorAll(".row-check"));
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

function renderData(data: ObjectData): string {
  const headers = data.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("");
  const rows = data.rows.map((row, rowIndex) => `
    <tr>
      <td class="selector"><input class="row-check" type="checkbox" data-row-index="${rowIndex}" aria-label="Select row ${data.offset + rowIndex + 1}"></td>
      ${row.map((value) => `<td>${escapeHtml(value === null ? "NULL" : String(value))}</td>`).join("")}
    </tr>
  `).join("");
  const body = rows || `<tr><td colspan="${data.columns.length + 1}" class="muted">No rows found.</td></tr>`;
  return `
    <div class="data-toolbar">
      <button id="select-all" type="button">全選択</button>
      <button id="clear-selection" type="button">選択解除</button>
      <span class="muted">選択: <span id="selected-count">0</span></span>
      <button id="copy-tsv" type="button" disabled>TSVコピー</button>
      <button id="copy-insert" type="button" disabled>INSERT SQLコピー</button>
      <span class="toolbar-spacer"></span>
      <span class="muted">${data.rows.length} rows loaded</span>
    </div>
    <table>
      <thead><tr><th class="selector"></th>${headers}</tr></thead>
      <tbody>${body}</tbody>
    </table>
    <div id="load-status" class="load-status muted">${data.hasNext ? "末尾までスクロールすると追加ロードします。" : "すべての表示可能な行を読み込みました。"}</div>
  `;
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
    .data-toolbar { align-items: center; display: flex; gap: 8px; margin: 12px 0; }
    .toolbar-spacer { flex: 1; }
    .load-status { padding: 12px 0 18px; text-align: center; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    th, td { border: 1px solid var(--vscode-panel-border); padding: 6px 8px; text-align: left; vertical-align: top; white-space: nowrap; }
    th { background: var(--vscode-editorWidget-background); position: sticky; top: 0; }
    .selector { text-align: center; width: 36px; }
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
