# DB Viewer

JDBCドライバーを利用して、Visual Studio Codeからリレーショナルデータベースを参照・操作するための拡張機能です。

接続先のTable / Viewをツリーから開き、カラム・制約・インデックス・データ・定義SQLを確認できます。データの検索、ソート、コピー、ファイル出力に加え、Tableに限定したInsert / Update / Deleteとスナップショット差分にも対応しています。

## 主な機能

### 接続管理

- 接続プロファイルの作成、編集、複製、削除
- 保存前の接続テスト
- JDBCドライバーJARとサポートJARの複数指定
- パスワードをVS Codeの`SecretStorage`へ保存
- Table / Viewを接続ごとのツリーで表示
- 接続、Tables、Views単位のRefresh

### オブジェクト情報の確認

Table / Viewを開くと、次のタブを利用できます。

| タブ | 内容 |
| --- | --- |
| 情報 | カラム名、型、サイズ、NULL可否、主キー、自動採番、自動生成、デフォルト値、備考 |
| 制約 | 主キー、外部キー、Unique制約 |
| インデックス | Index名、Unique、対象列、並び順、種別 |
| データ | データ表示、検索、ソート、コピー、保存、Tableの限定的な書き込み操作 |
| 差分 | Tableスナップショットの保存と比較 |
| 定義SQL | JDBCメタデータから生成できる範囲のDDL |

### データの参照と出力

- 初期表示は100行。スクロールによる追加ロード
- SQLの`WHERE`句に相当する条件での絞り込み
- カラムヘッダ選択による昇順・降順ソート
- 選択行のTSV / INSERT SQLコピー
- 検索・ソート条件を反映したCSV / TSV / INSERT SQL保存
- 大量データ出力時の進捗表示とキャンセル

`WHERE`条件には、接続先DBで有効な条件式だけを入力します。例: `status = 'ACTIVE'`。任意SQLを実行するSQLコンソール機能ではありません。

### Tableへの書き込み

書き込み操作はTableだけが対象です。実行前に対象と変更内容をプレビューし、複数行を1トランザクションで処理します。途中で失敗した場合はロールバックします。Update / Deleteでは、処理件数が要求件数と一致しない場合もロールバックします。

- `Paste TSV Insert`
  - 自動生成列を除いたTable列順でTSVをInsert
  - 空欄は空文字、`\N`はNULL
  - ダブルクォートで囲んだフィールド内のタブ、改行、`""`による引用符エスケープに対応
  - JDBC型とNULL可否をプレビュー時に検証
- `Update Selected`
  - 主キーで一意に特定できる選択行を更新
  - 主キー列と自動生成列は更新対象外
  - DATE / TIME / TIMESTAMP向け入力UIと型検証を提供
- `Delete Selected`
  - 主キーで一意に特定できる選択行を削除

Viewへの書き込み、主キーのないTableに対するUpdate / Delete、任意SQLの実行には対応していません。

### Tableスナップショット差分

Tableの`差分`タブで変更前のスナップショットを保存し、現在のデータと比較できます。

- 行数と行順に依存しない内容フィンガープリントで変更を検出
- 主キーがある場合は追加・削除・更新を行単位で分類
- 更新行の変更列と変更前後の値を表示
- Status、主キー、変更列によるフィルター
- 50件単位のページ表示
- 比較結果をJSON / CSVで保存
- チャンク単位のSHA-256による破損検出
- 保存、取得失敗、キャンセル時の不完全データ削除

スナップショットの上限は1 Tableあたり5,000,000行または512 MiBです。行単位の詳細比較は、変更前・変更後がそれぞれ100,000行かつ128 MiB以内の場合に生成します。上限を超える場合は理由付きのサマリーを表示します。

## 対応データベース

接続画面には次のプリセットがあります。JDBCドライバーは拡張機能に同梱していません。利用するDBベンダーが提供するドライバーJARを別途用意してください。

| DB | JDBC URL例 | ドライバークラス |
| --- | --- | --- |
| Oracle | `jdbc:oracle:thin:@//localhost:1521/FREEPDB1` | `oracle.jdbc.OracleDriver` |
| PostgreSQL | `jdbc:postgresql://localhost:5432/postgres` | `org.postgresql.Driver` |
| MySQL | `jdbc:mysql://localhost:3306/app` | `com.mysql.cj.jdbc.Driver` |
| Microsoft SQL Server | `jdbc:sqlserver://localhost:1433;databaseName=database;encrypt=true` | `com.microsoft.sqlserver.jdbc.SQLServerDriver` |
| H2 | `jdbc:h2:mem:test` | `org.h2.Driver` |
| Other | `jdbc:vendor://host:port/database` | 使用するドライバーに従って指定 |

DB固有の型、DDL、SQLリテラルはJDBCメタデータを基準にベストエフォートで処理します。OracleのDATE / TIMESTAMP系と、Microsoft SQL Serverの主要な型・識別子・リテラル・ページングには個別対応しています。

## 必要な環境

- Visual Studio Code 1.90.0以上
- Java 17以上
- 接続先DBに対応したJDBCドライバーJAR
- DBへ接続できるネットワークと認証情報

Java helperの起動に`java`コマンドを使用します。VS Codeを起動する環境の`PATH`からJava 17以上を実行できることを確認してください。

```sh
java -version
```

## インストール

VS CodeのExtensionsビューで`DB Viewer`を検索し、`Install`を選択します。

コマンドラインからインストールする場合:

```sh
code --install-extension mtzw.vsc-dbviewer-plugin
```

## はじめに

1. 利用するDBのJDBCドライバーJARを用意します。
2. Activity Barから`DB Viewer`を開きます。
3. Connectionsビューの`Add Connection`を選択します。
4. 接続名、DB種別、JDBC URL、ドライバークラス、JAR、ユーザー名、パスワードを入力します。
5. `接続テスト`で接続を確認してから保存します。
6. 接続ノードを展開し、`Tables`または`Views`から対象を開きます。

DB側でTable / Viewを追加または削除した場合は、ConnectionsビューのRefreshを実行してください。

## セキュリティとデータの取り扱い

- パスワードはVS Codeの`SecretStorage`へ保存します。
- 接続名、JDBC URL、ユーザー名、JARパスなどの非秘密情報はVS Codeの拡張用状態へ保存します。
- JDBCドライバーは利用者が選択したローカルJARをJava helperのclasspathへ追加して実行します。信頼できる配布元から取得したJARだけを指定してください。
- 書き込み操作は、接続ユーザーに付与されたDB権限で実行されます。参照用途では読み取り専用ユーザーの利用を推奨します。
- 検索条件は接続先DBへSQL条件式として渡されます。信頼できない文字列をそのまま入力しないでください。
- スナップショットにはLOB / バイナリ列を除くTableデータが暗号化されずに保存されます。機微情報を含むTableで使用する場合は、端末とVS Codeの拡張用保存領域を適切に保護してください。
- スナップショットは30日を超えるとTable詳細を開いた際に削除されます。画面から手動削除することもできます。

LOB / バイナリ列が主キーに含まれる場合、その値もスナップショットへ保存しません。この場合は完全な主キーを構成できないため、行単位分類ではなくサマリー比較になります。

## 制限事項

- SQLコンソールや任意SQL実行機能はありません。
- Viewは参照とエクスポートのみです。
- Table / View一覧は接続ユーザーの現在スキーマを対象とします。
- DDL生成はJDBCメタデータで取得できる範囲のベストエフォートです。DB上の定義を完全には再現しない場合があります。
- 主キーとUnique Indexのどちらも取得できないTable / Viewでは、ページングと全件出力の一意な取得順を保証できません。
- Updateの競合検知は主キー一致のみです。表示後に別の利用者が同じ行を更新した場合、後から実行したUpdateで値を上書きする可能性があります。
- TIMESTAMP WITH TIME ZONEなどDB固有性が高い型は、専用入力UIではなく文字列入力になる場合があります。
- エクスポートをキャンセルすると、途中まで出力されたファイルが残ります。
- スナップショット取得はページごとに独立した要求を使う`best-effort`方式です。取得中にTableが更新されると、複数時点のデータが混在する可能性があります。

## トラブルシューティング

### Java helperを起動できない

`java -version`を実行し、Java 17以上が`PATH`から利用できることを確認してください。VS Codeを起動した後に`PATH`を変更した場合は、VS Codeを再起動します。

### JDBCドライバーを読み込めない

接続編集画面で、JDBCドライバーJARとドライバークラス名が一致していることを確認してください。ドライバーが依存する追加JARは`サポートJAR`へ指定します。

### Oracleで`ORA-17056`が表示される

利用している`ojdbc*.jar`に対応する`orai18n.jar`を用意し、接続編集画面の`サポートJAR`へ追加してください。

### SQL Serverへ暗号化接続できない

接続先の証明書構成とJDBC URLの`encrypt`、`trustServerCertificate`などの設定を確認してください。本番環境ではDB管理者の方針に従って証明書を検証してください。

## フィードバック

不具合報告や機能要望は[GitHub Issues](https://github.com/mtzw/vsc-dbviewer-plugin/issues)へお願いします。報告には、DB種別、Javaのバージョン、JDBCドライバーのバージョン、再現手順、表示されたエラーを含めてください。パスワード、接続文字列、Tableデータなどの機密情報は記載しないでください。

## ライセンス

[MIT License](LICENSE.md)

## 開発者向け

ソースからビルドする場合は、Node.js / npmとJDK 17以上が必要です。

```sh
npm install
npm run build
npm test
```

H2 JDBC統合テストを含める場合:

```sh
H2_JAR=/path/to/h2.jar npm test
```
