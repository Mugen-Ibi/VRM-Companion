# VRM Companion

現在の公開版は **v0.0.1 Beta** です。承認済み設計のv0.1は後続の到達目標であり、このベータ版で全受け入れ条件の完了を宣言するものではありません。

ユーザーが用意した任意のVRMアバターと日本語で会話し、選択したフォルダの整理・復元を行うWindows用のローカルAIコンパニオンです。

MVPの実装とWindows向けパッケージを作成しました。検証結果と未確認事項は [検証記録](docs/verification.md) に記載します。素材の選択・入手はユーザーに委ね、特定の外見を必須にしません。音声会話は含みません。

## 起動

配布フォルダの `VRM-Companion.exe` を起動します。このリポジトリ内では `release/VRM-Companion-win32-x64/VRM-Companion.exe` です。実行ファイルだけ移動せず、フォルダ全体を保持してください。Node.jsやUnityは実行時に不要です。

1. 「アバター」から自分のVRMをインポートします。未選択でも会話と整理を使えます。
2. llama-serverを起動し、「設定」で接続先を指定します。初期値は `http://127.0.0.1:8080` です。
3. 「接続を確認」を押し、日本語で会話します。
4. フォルダを選んで「このフォルダを種類別に整理して」と依頼し、整理案の検証・承認を行います。

アバターだけを消すには、パネル右上の「アバターを隠す」か、アバターの右クリックメニューを使います。非表示のまま会話・整理を続けられ、次回起動にも非表示を引き継ぎます。パネルの×はパネルの非表示です。アプリ終了はトレイの「終了」を使います。外部llama-serverは終了しません。詳しい操作・保存・復旧は [使い方](docs/usage.md) を参照してください。

## llama.cpp

起動済みの既存サーバーを利用できます。検証モデルはQwen3.5-9B-Q4_K_Mです。GGUFは同梱・自動取得しません。

公式安定v0.4.1に対応するb10964のWindows CUDA版を、`.local/llama/b10964` へ導入するスクリプトを用意しました。GitHubアセットのSHA-256を検証し、既存環境と別に配置します。[公式リリース](https://github.com/ggml-org/llama.cpp/releases/tag/v0.4.1)

```powershell
./scripts/setup-llama.ps1
./scripts/start-llama.ps1 -Model 'D:\LLM\models\Qwen3.5-9B-Q4_K_M.gguf' -Port 8081
```

8080に既存サーバーがある場合は、どちらか一方を通常利用してください。GPUメモリ8GBでは9Bモデル2つを同時にGPUへ載せる余裕がありません。別ポートを使う際はアプリ設定も変更します。既存プロセスは停止しません。初期設定はcontext 4096・並列1です。

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

## 実装範囲

- VRM 0.x/1.0のコピー管理、切替、透明常駐、移動、倍率・fps設定、まばたきと待機動作。
- 日本語ストリーミング、停止、再入力、人格設定、会話履歴管理。
- 会話の意図判定、フォルダ直下の固定拡張子分類、計画の編集と明示承認。
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
