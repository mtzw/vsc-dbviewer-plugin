# DB Viewer

DB Viewer は、ユーザーが指定した JDBC ドライバーを使って RDB に接続する、VS Code / VS Code 互換エディタ向けの読み取り専用データベースビューアです。

## v1 の範囲

- JDBC 接続プロファイルの追加、編集、削除
- 接続プロファイルの非秘密情報を VS Code `globalState` に保存
- パスワードを VS Code `SecretStorage` に保存
- DB Viewer の Activity Bar から接続ユーザーの Table / View をツリー表示
- Table と View を `Tables` / `Views` フォルダに分けて表示
- Table / View を Webview で開き、`情報`、`データ`、`定義SQL` タブを表示
- `データ` タブは読み取り専用で、初期表示は最大 100 行

v1 では、SQL / TSV コピー、TSV 貼り付け Insert、Java Entity / Record 生成は未実装です。

## v1.1 の改善点

- 接続作成 / 編集時に DB 種別を選択します。
- JDBC ドライバーJARとサポートJARの選択ステップを分離しました。
- Oracle を選択した場合は、`orai18n.jar` が必要になるケースを UI 上で案内します。
- 保存前に、実際に classpath に追加されるJAR一覧を確認できます。

## v2 の範囲

- データタブで行を選択できます。
- 表示中の選択行を TSV としてコピーできます。
- 表示中の選択行を `INSERT SQL` としてコピーできます。
- データタブで末尾付近までスクロールすると追加ロードできます。
- v2でも読み取り専用です。Insert、Update、Delete、任意SQL実行は行いません。

## v2.1 の改善点

- 接続プロファイルの作成 / 編集UIをWebviewフォームに変更しました。
- JDBCドライバーJARとサポートJARをフォーム上で一覧確認、削除、再選択できます。
- フォーム上で接続テストを実行し、結果を確認できます。
- 接続プロファイルを複製できます。

## v2.2 の改善点

- DB Viewerツリーで、接続ノードや `Tables` / `Views` フォルダ単位のRefreshを実行できます。
- Table / View詳細に `制約`、`インデックス` タブを追加しました。
- 主キー、外部キー、Unique、IndexなどのJDBCメタデータ表示を強化しました。
- `INSERT SQLコピー` でOracleのDATE / TIMESTAMP / TIMESTAMP WITH TIME ZONE向けリテラル生成に対応しました。

## v2.3 の改善点

- データタブからTable / View全体をCSV / TSV / InsertSQL形式で保存できます。
- エクスポートはページ単位でデータを取得し、VS Codeの進捗通知とキャンセルに対応します。
- CSV / TSVはヘッダ行付きで保存します。

## v2.4 の改善点

- データタブ上部の操作UIをグループ化し、コピー系と保存系の操作を整理しました。
- 選択した行をハイライト表示します。
- データリロード、where条件相当の簡易検索、ヘッダクリックによるソートに対応しました。
- 検索条件とソート条件は、追加ロードとCSV / TSV / InsertSQL保存にも適用されます。

## ロードマップ

- v3.0: TSV形式のレコードをペーストしてInsertできるようにします。書き込み前の確認、トランザクション、失敗時の扱いを設計します。
- v3.1: データタブで行Updateできるようにし、コミット、ロールバックに対応予定です。
- v3.2以降: Java Entity / Record生成機能を追加し、型マッピング、命名規則、package、JPA / Jakarta対応などを設定可能にします。

## 開発手順

```sh
npm install
npm run build
```

テストを実行する場合:

```sh
npm test
```

`npm test` は TypeScript 側の単体テストを実行します。H2 JDBC ドライバーの JAR を指定した場合は、Java ヘルパーの H2 統合テストも実行します。

```sh
H2_JAR=/path/to/h2.jar npm test
```

## VSIX作成手順

メンバー間で配布する場合は、VS Code拡張のパッケージファイルである `.vsix` を作成します。

1. 依存関係をインストールします。

```sh
npm install
```

2. 拡張本体と Java ヘルパーをビルドします。

```sh
npm run build
```

3. テストを実行します。

```sh
npm test
```

4. VSIXを作成します。

```sh
npx @vscode/vsce package
```

作成に成功すると、プロジェクト直下に次のようなファイルが生成されます。

```text
vsc-dbviewer-plugin-0.2.4.vsix
```

バージョン番号は `package.json` の `version` に従います。配布前にバージョンを上げる場合は、`package.json` を更新してから `npm install --package-lock-only` を実行し、`package-lock.json` も同期してください。

## VSIXインストール手順

配布されたVSIXは、各メンバーの環境で以下の方法でインストールできます。

コマンドラインからインストールする場合:

```sh
code --install-extension vsc-dbviewer-plugin-0.2.4.vsix
```

VS Code の画面からインストールする場合:

1. Extensionsビューを開きます。
2. 右上の `...` メニューを開きます。
3. `Install from VSIX...` を選択します。
4. 配布された `.vsix` ファイルを選択します。

更新版を配布する場合は、`package.json` の `version` を上げてからVSIXを作成してください。同じバージョン番号のまま配布すると、利用者側で更新されたか分かりにくくなります。

## 動作確認手順

1. 依存関係をインストールし、拡張本体と Java ヘルパーをビルドします。

```sh
npm install
npm run build
```

2. VS Code でこのディレクトリを開きます。

```sh
code .
```

3. `Run and Debug` から `Extension Development Host` を起動します。

起動構成が無い場合は、VS Code の拡張開発用デバッグ構成を追加してから実行してください。

4. Extension Development Host 側で Activity Bar の `DB Viewer` を開きます。

5. `Add Connection` を実行し、接続情報を入力します。

入力項目:

- 接続名
- DB 種別
- JDBC URL
- JDBC ドライバークラス
- JDBC ドライバーJAR
- サポートJAR
- ユーザー名
- パスワード

接続プロファイル画面では、入力内容を保存する前に `接続テスト` を実行できます。既存プロファイルを編集する場合、パスワード欄を空のまま保存すると既存パスワードを維持します。

PostgreSQL の入力例:

- JDBC URL: `jdbc:postgresql://localhost:5432/postgres`
- JDBC ドライバークラス: `org.postgresql.Driver`
- JDBC ドライバー JAR: `postgresql-*.jar`

Oracle の入力例:

- JDBC URL: `jdbc:oracle:thin:@//localhost:1521/FREEPDB1`
- JDBC ドライバークラス: `oracle.jdbc.OracleDriver`
- JDBC ドライバーJAR: `ojdbc*.jar`
- サポートJAR: 文字セット対応が必要な場合は `orai18n.jar`

H2 の入力例:

- JDBC URL: `jdbc:h2:mem:test`
- JDBC ドライバークラス: `org.h2.Driver`
- JDBC ドライバー JAR: `h2-*.jar`

6. 接続保存後、必要に応じて `Test Connection` を実行します。

7. DB Viewer のツリーを展開し、`Tables` または `Views` 配下の Table / View を選択します。

8. Table / View を開き、Webview 上で以下を確認します。

- `情報`: カラム、型、Nullable、主キー、デフォルト値、備考
- `制約`: 主キー、外部キー、Unique制約
- `インデックス`: Index名、Unique、列、並び順、種別
- `データ`: 最大 100 行の読み取り専用データ
- `定義SQL`: JDBC メタデータから生成できる範囲の定義SQL、または取得できない場合の補足メッセージ

データタブでは、行チェックボックスを選択して以下の操作ができます。

- `Reload`
- where条件相当の検索
- ヘッダクリックによるソート
- `全選択`
- `選択解除`
- `TSVコピー`
- `INSERT SQLコピー`
- `CSV保存`
- `TSV保存`
- `INSERT SQL保存`
- 末尾付近までスクロールした際の追加ロード

## 注意事項

- JDBC ドライバーは同梱していません。利用する DB の JDBC ドライバー JAR を事前に用意してください。
- Oracle で `ORA-17056` が発生する場合は、接続編集で `ojdbc*.jar` に加えて `orai18n.jar` をサポートJARとして指定してください。
- Table / View 一覧は、接続ユーザーの現在スキーマを対象に表示します。Oracle では通常、接続ユーザー所有の Table / View が対象です。
- Java 実行環境が必要です。`java` コマンドが PATH から実行できる状態にしてください。
- View の定義SQLは汎用 JDBC メタデータだけでは取得できないため、v1 では補足メッセージを表示します。
- DB ごとの厳密な DDL 取得は v1 ではベストエフォートです。
- `INSERT SQLコピー` はクリップボードへ文字列をコピーするだけです。DBへの書き込みは行いません。
- `INSERT SQLコピー` の日付/時刻リテラルのRDB方言対応はベストエフォートです。OracleのDATE/TIMESTAMP向けリテラル生成はJDBC型情報に基づいて行います。
- `INSERT SQL保存` はSQL文字列をファイルへ保存するだけです。Viewを対象にした場合、そのSQLがDBで実行可能であることは保証しません。
- データタブの検索条件はSQLのwhere句相当の条件式として扱います。セミコロンを含む条件式は指定できません。
- 大量データのエクスポートは時間がかかる場合があります。キャンセルした場合、途中まで出力されたファイルが残ります。
- DB側でTable / Viewを追加、削除した場合は、DB ViewerのRefreshを実行してツリーを更新してください。
