import * as vscode from "vscode";
import { JdbcClient } from "./jdbcClient";
import { DATABASE_TYPES } from "./databaseTypes";
import { ConnectionInput, ConnectionProfile } from "./types";

interface EditorState {
  mode: "add" | "edit";
  profile?: ConnectionProfile;
  passwordAvailable: boolean;
}

type EditorMessage =
  | { type: "pickJars"; target: "driver" | "support" }
  | { type: "test"; input: ConnectionInput }
  | { type: "save"; input: ConnectionInput }
  | { type: "cancel" };

export class ConnectionEditorPanel {
  static open(
    context: vscode.ExtensionContext,
    client: JdbcClient,
    existing?: ConnectionProfile,
    existingPassword = ""
  ): Promise<ConnectionInput | undefined> {
    return new Promise((resolve) => {
      const panel = vscode.window.createWebviewPanel(
        "dbViewer.connectionEditor",
        existing ? `Edit Connection: ${existing.name}` : "Add Connection",
        vscode.ViewColumn.One,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      let resolved = false;

      const state: EditorState = {
        mode: existing ? "edit" : "add",
        profile: existing,
        passwordAvailable: existingPassword.length > 0
      };
      panel.webview.html = renderEditor(state);

      panel.webview.onDidReceiveMessage(async (message: EditorMessage) => {
        try {
          if (message.type === "pickJars") {
            const selected = await vscode.window.showOpenDialog({
              title: message.target === "driver" ? "Select JDBC Driver JARs" : "Select JDBC Support JARs",
              openLabel: message.target === "driver" ? "Use as Driver JARs" : "Use as Support JARs",
              canSelectFiles: true,
              canSelectFolders: false,
              canSelectMany: true,
              filters: { "JAR files": ["jar"] }
            });
            await panel.webview.postMessage({
              type: "jarsPicked",
              target: message.target,
              paths: selected?.map((uri) => uri.fsPath) ?? []
            });
            return;
          }

          if (message.type === "test") {
            const profile = toTemporaryProfile(message.input, existing);
            const password = message.input.password ?? existingPassword;
            await client.request(profile, password, "testConnection");
            await panel.webview.postMessage({ type: "testResult", ok: true, message: "接続に成功しました。" });
            return;
          }

          if (message.type === "save") {
            resolved = true;
            panel.dispose();
            resolve(normalizePassword(message.input, existing));
            return;
          }

          if (message.type === "cancel") {
            resolved = true;
            panel.dispose();
            resolve(undefined);
          }
        } catch (error) {
          if (message.type === "test") {
            await panel.webview.postMessage({ type: "testResult", ok: false, message: (error as Error).message });
          } else {
            vscode.window.showErrorMessage((error as Error).message);
          }
        }
      });

      panel.onDidDispose(() => {
        if (!resolved) {
          resolve(undefined);
        }
      }, null, context.subscriptions);
    });
  }
}

function normalizePassword(input: ConnectionInput, existing?: ConnectionProfile): ConnectionInput {
  if (existing && input.password === "") {
    const { password: _password, ...rest } = input;
    return rest;
  }
  return input;
}

function toTemporaryProfile(input: ConnectionInput, existing?: ConnectionProfile): ConnectionProfile {
  return {
    id: existing?.id ?? "test",
    name: input.name,
    dbType: input.dbType,
    jdbcUrl: input.jdbcUrl,
    driverClass: input.driverClass,
    driverJarPaths: input.driverJarPaths,
    supportJarPaths: input.supportJarPaths,
    username: input.username,
    passwordSecretKey: existing?.passwordSecretKey ?? ""
  };
}

function renderEditor(state: EditorState): string {
  const nonce = createNonce();
  const profile = state.profile;
  const initial = {
    databaseTypes: DATABASE_TYPES,
    mode: state.mode,
    values: {
      name: profile?.name ?? "",
      dbType: profile?.dbType ?? "oracle",
      jdbcUrl: profile?.jdbcUrl ?? "",
      driverClass: profile?.driverClass ?? "oracle.jdbc.OracleDriver",
      driverJarPaths: profile?.driverJarPaths ?? [],
      supportJarPaths: profile?.supportJarPaths ?? [],
      username: profile?.username ?? "",
      password: ""
    },
    passwordAvailable: state.passwordAvailable
  };
  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font-family: var(--vscode-font-family); margin: 0; }
    main { max-width: 880px; padding: 18px 22px 28px; }
    h1 { font-size: 20px; font-weight: 600; margin: 0 0 18px; }
    fieldset { border: 1px solid var(--vscode-panel-border); margin: 0 0 16px; padding: 14px; }
    legend { color: var(--vscode-descriptionForeground); padding: 0 6px; }
    label { display: block; font-weight: 600; margin: 12px 0 6px; }
    input, select { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border); color: var(--vscode-input-foreground); box-sizing: border-box; padding: 7px 8px; width: 100%; }
    button { background: var(--vscode-button-secondaryBackground); border: 0; color: var(--vscode-button-secondaryForeground); cursor: pointer; padding: 7px 10px; }
    button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    button:disabled { cursor: not-allowed; opacity: 0.55; }
    .row { display: grid; gap: 12px; grid-template-columns: 1fr 1fr; }
    .actions, .jar-actions { display: flex; gap: 8px; margin-top: 12px; }
    .actions { border-top: 1px solid var(--vscode-panel-border); padding-top: 14px; }
    .jar-list { border: 1px solid var(--vscode-panel-border); margin-top: 8px; min-height: 36px; padding: 8px; }
    .jar-item { align-items: center; display: flex; gap: 8px; margin: 4px 0; }
    .jar-path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .hint, .status { color: var(--vscode-descriptionForeground); margin-top: 6px; }
    .status.ok { color: var(--vscode-testing-iconPassed); }
    .status.error { color: var(--vscode-errorForeground); white-space: pre-wrap; }
  </style>
</head>
<body>
  <main>
    <h1>${state.mode === "edit" ? "接続プロファイル編集" : "接続プロファイル作成"}</h1>
    <fieldset>
      <legend>基本情報</legend>
      <div class="row">
        <div>
          <label for="name">接続名</label>
          <input id="name" autocomplete="off">
        </div>
        <div>
          <label for="dbType">DB種別</label>
          <select id="dbType"></select>
        </div>
      </div>
      <label for="jdbcUrl">JDBC URL</label>
      <input id="jdbcUrl" autocomplete="off">
      <div id="jdbcUrlHint" class="hint"></div>
      <label for="driverClass">JDBCドライバークラス</label>
      <input id="driverClass" autocomplete="off">
    </fieldset>

    <fieldset>
      <legend>JAR</legend>
      <label>JDBCドライバーJAR</label>
      <div id="driverJars" class="jar-list"></div>
      <div class="jar-actions">
        <button id="pickDriverJars" type="button">選択</button>
        <button id="clearDriverJars" type="button">クリア</button>
      </div>
      <label>サポートJAR</label>
      <div id="supportJars" class="jar-list"></div>
      <div class="jar-actions">
        <button id="pickSupportJars" type="button">選択</button>
        <button id="clearSupportJars" type="button">クリア</button>
      </div>
      <div id="jarHint" class="hint"></div>
    </fieldset>

    <fieldset>
      <legend>認証</legend>
      <label for="username">ユーザー名</label>
      <input id="username" autocomplete="off">
      <label for="password">パスワード</label>
      <input id="password" type="password" autocomplete="new-password" placeholder="${state.mode === "edit" ? "空欄なら既存パスワードを維持" : ""}">
      <div class="hint">${state.mode === "edit" ? "保存時にパスワード欄が空の場合、既存のパスワードを維持します。" : ""}</div>
    </fieldset>

    <div id="status" class="status"></div>
    <div class="actions">
      <button id="save" class="primary" type="button">保存</button>
      <button id="test" type="button">接続テスト</button>
      <button id="cancel" type="button">キャンセル</button>
    </div>
  </main>
  <script nonce="${nonce}">
    (() => {
      const vscode = acquireVsCodeApi();
      const initial = ${safeJson(initial)};
      let driverJarPaths = [...initial.values.driverJarPaths];
      let supportJarPaths = [...initial.values.supportJarPaths];
      const elements = {
        name: document.querySelector("#name"),
        dbType: document.querySelector("#dbType"),
        jdbcUrl: document.querySelector("#jdbcUrl"),
        jdbcUrlHint: document.querySelector("#jdbcUrlHint"),
        driverClass: document.querySelector("#driverClass"),
        driverJars: document.querySelector("#driverJars"),
        supportJars: document.querySelector("#supportJars"),
        jarHint: document.querySelector("#jarHint"),
        username: document.querySelector("#username"),
        password: document.querySelector("#password"),
        status: document.querySelector("#status")
      };

      for (const dbType of initial.databaseTypes) {
        const option = document.createElement("option");
        option.value = dbType.value;
        option.textContent = dbType.label;
        elements.dbType.appendChild(option);
      }

      elements.name.value = initial.values.name;
      elements.dbType.value = initial.values.dbType;
      elements.jdbcUrl.value = initial.values.jdbcUrl;
      elements.driverClass.value = initial.values.driverClass;
      elements.username.value = initial.values.username;

      const currentDbType = () => initial.databaseTypes.find((dbType) => dbType.value === elements.dbType.value);
      const renderDbHints = () => {
        const dbType = currentDbType();
        elements.jdbcUrlHint.textContent = dbType ? "例: " + dbType.jdbcUrlExample : "";
        elements.jarHint.textContent = elements.dbType.value === "oracle"
          ? "OracleでORA-17056が発生する場合は、サポートJARにorai18n.jarを追加してください。"
          : "サポートJARは、JDBCドライバーが追加ライブラリを必要とする場合だけ指定します。";
        if (!elements.driverClass.value && dbType && dbType.defaultDriverClass) {
          elements.driverClass.value = dbType.defaultDriverClass;
        }
      };

      const jarName = (jarPath) => jarPath.split(/[\\\\/]/).pop() || jarPath;
      const renderJars = () => {
        renderJarList(elements.driverJars, driverJarPaths, (index) => {
          driverJarPaths.splice(index, 1);
          renderJars();
        });
        renderJarList(elements.supportJars, supportJarPaths, (index) => {
          supportJarPaths.splice(index, 1);
          renderJars();
        });
      };
      const renderJarList = (container, paths, remove) => {
        container.textContent = "";
        if (paths.length === 0) {
          const empty = document.createElement("div");
          empty.className = "hint";
          empty.textContent = "未選択";
          container.appendChild(empty);
          return;
        }
        paths.forEach((jarPath, index) => {
          const item = document.createElement("div");
          item.className = "jar-item";
          const path = document.createElement("span");
          path.className = "jar-path";
          path.title = jarPath;
          path.textContent = jarName(jarPath);
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = "削除";
          button.addEventListener("click", () => remove(index));
          item.append(path, button);
          container.appendChild(item);
        });
      };

      const input = () => ({
        name: elements.name.value.trim(),
        dbType: elements.dbType.value,
        jdbcUrl: elements.jdbcUrl.value.trim(),
        driverClass: elements.driverClass.value.trim(),
        driverJarPaths,
        supportJarPaths,
        username: elements.username.value.trim(),
        password: elements.password.value
      });
      const validate = () => {
        const value = input();
        if (!value.name) return "接続名を入力してください。";
        if (!value.jdbcUrl) return "JDBC URLを入力してください。";
        if (!value.driverClass) return "JDBCドライバークラスを入力してください。";
        if (value.driverJarPaths.length === 0) return "JDBCドライバーJARを1つ以上選択してください。";
        return "";
      };
      const setStatus = (message, ok) => {
        elements.status.textContent = message;
        elements.status.className = ok === undefined ? "status" : ok ? "status ok" : "status error";
      };
      const postValidated = (type) => {
        const error = validate();
        if (error) {
          setStatus(error, false);
          return;
        }
        setStatus(type === "test" ? "接続テスト中..." : "", undefined);
        vscode.postMessage({ type, input: input() });
      };

      document.querySelector("#pickDriverJars").addEventListener("click", () => vscode.postMessage({ type: "pickJars", target: "driver" }));
      document.querySelector("#pickSupportJars").addEventListener("click", () => vscode.postMessage({ type: "pickJars", target: "support" }));
      document.querySelector("#clearDriverJars").addEventListener("click", () => { driverJarPaths = []; renderJars(); });
      document.querySelector("#clearSupportJars").addEventListener("click", () => { supportJarPaths = []; renderJars(); });
      document.querySelector("#save").addEventListener("click", () => postValidated("save"));
      document.querySelector("#test").addEventListener("click", () => postValidated("test"));
      document.querySelector("#cancel").addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
      elements.dbType.addEventListener("change", () => {
        const dbType = currentDbType();
        if (dbType && dbType.defaultDriverClass) {
          elements.driverClass.value = dbType.defaultDriverClass;
        }
        renderDbHints();
      });

      window.addEventListener("message", (event) => {
        const message = event.data;
        if (message.type === "jarsPicked") {
          if (message.paths.length === 0) return;
          if (message.target === "driver") {
            driverJarPaths = message.paths;
          } else {
            supportJarPaths = message.paths;
          }
          renderJars();
        }
        if (message.type === "testResult") {
          setStatus(message.message, message.ok);
        }
      });

      renderDbHints();
      renderJars();
    })();
  </script>
</body>
</html>`;
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function createNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 32; i += 1) {
    nonce += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return nonce;
}
