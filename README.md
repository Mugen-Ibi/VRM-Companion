# VRM Companion

現在の公開版は **[v0.0.0.5 Beta](https://github.com/Mugen-Ibi/VRM-Companion/releases/tag/v0.0.0.5)** です。承認済み設計のv0.1は後続の到達目標であり、このベータ版で全受け入れ条件の完了を宣言するものではありません。

ユーザーが用意した任意のVRMアバターと日本語で会話し、選択したフォルダの整理・復元を行うWindows用のローカルAIコンパニオンです。

MVPの実装とWindows向けパッケージを作成しました。検証結果と未確認事項は [検証記録](docs/verification.md) に記載します。素材の選択・入手はユーザーに委ね、特定の外見を必須にしません。音声会話は含みません。

## 起動

配布ZIPを展開し、フォルダ内の `VRM-Companion.exe` を起動します。今回のビルドは `release/v0.0.0.5/VRM-Companion-win32-x64/VRM-Companion.exe` です。旧版が動作中の場合はトレイから終了してから起動してください。実行ファイルだけ移動せず、フォルダ全体を保持してください。Node.jsやUnityは実行時に不要です。

1. 「アバター」から自分のVRMをインポートします。未選択でも会話と整理を使えます。
2. 「設定」でLLMの使い方を選びます。「フォルダーから選択」ではGGUFフォルダーと `llama-server.exe` を指定して保存します。起動済みサーバーにも接続でき、接続先の初期値は `http://127.0.0.1:8080` です。
3. 「接続を確認」を押し、日本語で会話します。
4. フォルダを選び、入力欄の「整理依頼」に切り替えて「このフォルダを種類別に整理して」と依頼します。整理案の検証・承認後に移動します。通常の「会話」では整理案を作りません。

アバターだけを消すには、パネル右上の「アバターを隠す」か、アバターの右クリックメニューを使います。非表示のまま会話・整理を続けられ、次回起動にも非表示を引き継ぎます。パネルの×はパネルの非表示です。アプリ終了はトレイの「終了」を使います。外部llama-serverは終了しません。詳しい操作・保存・復旧は [使い方](docs/usage.md) を参照してください。

## llama.cpp

起動済みの既存サーバーと、アプリが起動・停止する管理モードを選べます。管理モードは会話上部のモデル一覧で切り替え、1モデルずつ読み込みます。「メモリ解放」と既定5分の自動解放に対応し、解放後は次の送信時に再読込します。実機検証モデルはQwen3.5-9B-Q4_K_MとLFM2.5-1.2B-JPです。GGUFは同梱・自動取得しません。

管理モードはcontext 4096・並列1・batch 512 / ubatch 128・promptキャッシュRAM 0を既定とし、llama.cppの自動GPU割当を使用します。外部サーバーの設定やプロセスは変更しません。新機能と検証結果は [改善記録](docs/improvements.md) を参照してください。

共有環境を `D:\LLM` に集約しています。本体と対応するCUDA DLLは `releases/<build>-cuda<version>/bin` に保存し、`llama` ジャンクションで使用版を切り替えます。モデルは `models`、旧環境は `backups` に保持します。公式ZIPと展開後のファイルのSHA-256を検証します。構成・更新・性能比較は [llama.cpp環境管理](docs/llama-environment.md) を参照してください。

```powershell
./scripts/start-llama.ps1
# 停止
./scripts/stop-llama.ps1
# 安定版を取得（稼働版は変えません）
./scripts/setup-llama.ps1 -Build stable
# 最新プレリリースを取得
./scripts/setup-llama.ps1 -Build latest
```

通常の接続先は `http://127.0.0.1:8080` です。既存の起動設定を引き継ぎ、context 16384・GPU layers 99・並列1を初期値にしています。アプリ側のコンテキスト設定はサーバー以下にしてください。GPUメモリ8GBでは9Bモデル2つを同時にGPUへ載せる余裕がありません。起動スクリプトは使用中ポートを検出し、停止スクリプトは記録したプロセスだけを停止します。

## ソースから実行

Windows x64、Node.js 24以降、Windowsの.NET Framework 4.xコンパイラを使います。Electron/TypeScript/Three.js構成で、Unityはビルドにも不要です。

```powershell
npm.cmd ci
npm.cmd run setup
npm.cmd run dev
```

`npm` が古いユーザーフォルダのshimを参照する場合は、`& 'C:\Program Files\nodejs\npm.cmd' ci` のようにNode.js付属の実体を指定してください。`setup` はElectronの取得です。アプリ起動時の自動ダウンロードはありません。

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run test:ui
npm.cmd run package
```

`package` は最新ソースのビルドと依存ライセンス生成も行います。UI試験は自作VRM・模擬サーバー・使い捨てファイルで行い、個人データを整理しません。ファイル試験はWindows NTFSが必要です。UI試験の整理対象はアプリ自身の保護範囲を避け、隣の `VRM-Companion-test-artifacts` に作ります。

公開名・Gitタグ・Windows実行ファイルのバージョンは `package.json` の `releaseVersion`（現在 `0.0.0.3`）を使います。npm向けの `version` はSemVer形式の `0.0.3-beta.0` です。`COMPANION_PACKAGE_OUT` で出力先を指定でき、今回の配布用ビルドは `release/v0.0.0.5` に出力します。

v0.0.0.5では設定保存の競合を修正し、通知を差分化しました。バックアップ・履歴削除のバックアップ処理・VRM検査はworkerで実行します。履歴は自動削除しません。詳細は [リリースノート](docs/release-v0.0.0.5.md) を参照してください。

## 実装範囲

- VRM 0.x/1.0のコピー管理、切替、透明常駐、移動、倍率・fps・描画品質設定。まばたき・呼吸・視線・手振り・うなずき・おじぎ・伸び。
- GGUFフォルダーの選択、会話中のLLM切替、所有サーバーの起動・停止、未使用時のメモリ解放。
- 日本語ストリーミング、停止、再入力、人格設定、会話履歴管理。
- 通常会話と整理依頼の明示切替、フォルダ直下の固定拡張子分類、計画の編集と明示承認。
- 上書き禁止、ID/SHA-256検証、操作記録、クラッシュ後の照合、成功項目の復元。
- SQLiteバックアップと破損時の復旧案内。

整理はローカルNTFS・直下のみ、1計画200ファイル/2GiB、1ファイル512MiBです。削除、上書き、再帰整理、意味による分類、任意コマンドは対象外です。

| 資料 | 内容 |
| --- | --- |
| [要件定義](docs/requirements.md) | 目的・範囲・受け入れ条件 |
| [基本設計](docs/architecture.md) | 構成・権限・ファイル保全 |
| [開発と検証計画](docs/roadmap.md) | 検証条件と未確認事項 |
| [使い方](docs/usage.md) | セットアップ、日常操作、復旧 |
| [検証記録](docs/verification.md) | 実測値と要件対応 |

本体の [LICENSE](LICENSE) はUnlicenseです。外部ライブラリは [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) と配布物のElectron/Chromiumライセンスを参照してください。VRM・GGUFは各提供元の条件に従います。

梱包時に公式Electron ZIPをローカルで指定する場合は、公式 `SHASUMS256.txt` と照合したうえで `COMPANION_ELECTRON_ZIP_DIR` にZIPのあるディレクトリを指定できます。ZIP名は `electron-v<version>-win32-x64.zip` です。通常は自動取得を使います。
