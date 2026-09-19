# llama.cpp環境管理

2026-09-19に従来のb9843から **安定版v0.4.1（b10964 / CUDA 13.3）** に更新しました。最新プレリリースb11050 / CUDA 13.4も導入し、性能比較用に保存しています。

## 採用理由と測定結果

[公式安定版v0.4.1](https://github.com/ggml-org/llama.cpp/releases/tag/v0.4.1) の `nightly-tag.txt` はb10964を指し、両タグの実コミットは `b29c606e28a01b1bc8c1351026a0fa6e616bf6c4` で一致します。[b11050](https://github.com/ggml-org/llama.cpp/releases/tag/b11050) は確認時点の最新番号付きプレリリースです。

RTX 5070 Laptop GPU（8GB）、ドライバー616.92、同じ `Qwen3.5-9B-Q4_K_M.gguf` で比較しました。本体とCUDA DLLの組み合わせを含めた公式配布パッケージの比較です。CUDAバージョンを揃えたソースコード単体の比較ではありません。

| 測定項目 | 安定版b10964 | 最新版b11050 |
| --- | ---: | ---: |
| llama-bench 入力512トークン、tokens/秒 | 2,572.52 | 2,516.84 |
| llama-bench 入力2,048トークン、tokens/秒 | 2,522.51 | 2,478.01 |
| llama-bench 128トークン生成、tokens/秒 | 57.90 | 57.65 |
| サーバーAPI 入力処理、tokens/秒 | 2,326.34 | 2,330.79 |
| サーバーAPI 生成、tokens/秒 | 52.85 | 52.98 |
| サーバーAPI 1リクエスト所要時間、ミリ秒 | 3,011.35 | 3,003.28 |

表は算術平均です。llama-benchはABBA順で各ケース5回×2ブロック、計10回。ウォームアップあり、GPU layers 99、threads 8、batch/ubatch 512、Flash Attention on、KV f16、生成開始時のdepth 0です。プロンプト処理と生成は独立ケースです。

APIはcontext 16,384・並列1・GPU layers 99、他の起動条件も同一です。ABBA順で各サーバー起動後に1回ウォームアップ、3回測定×2ブロック、計6回。固定1,402入力トークン、128トークン生成、temperature 0、seed 1234、`cache_prompt=false`、`ignore_eos=true` の `/completion` を用いました。モデル読み込み時間と初回ウォームアップはAPI測定に含めません。

安定版は基礎測定の入力処理で約1.8〜2.2%高い平均値でした。生成とAPI所要時間の差は0.5%未満です。測定値にはばらつきがあり、全用途で安定版のほうが速いと断定できる差ではありません。今回の環境では最新版の実用上明確な優位を確認できなかったため、基礎測定でわずかに優位な安定版を選びました。別モデルや長い会話では結果が変わる可能性があります。

生データは `D:\LLM\benchmarks\20260919-195438` と `D:\LLM\benchmarks\server-20260919-200117` に保存しています。モデルSHA-256、測定設定、個別サンプル、GPUの状態、ログを確認できます。途中で停止スクリプトの日時比較を修正してやり直したAPI試験のディレクトリは、採用結果に含めません。

## 配置

```text
D:\LLM\
  llama\                         使用版binへのジャンクション（既存パスを維持）
  releases\
    b10964-cuda13.3\
      bin\                       本体と対応するCUDA DLL
      manifest.json              取得URL・ZIPと展開ファイルのSHA-256
    b11050-cuda13.4\
      bin\
      manifest.json
  models\                        元のGGUFをそのまま保持
  scripts\                       単独で動く保守用PowerShellスクリプト
  cache\                         検証済み配布ZIP
  backups\                       元のb9843・別置きCUDA DLLなど
  benchmarks\                    性能比較の再現情報と結果
  logs\                          起動ごとに分けたログ
  run\                           停止時の照合用PID・開始時刻・実行パス
```

実行用途には公式バイナリのリリース管理を採用しました。Git cloneやCUDA Toolkitのインストール、グローバルPATH変更は不要です。既存バイナリに `.git` を付けてもupstreamのソースとは同期できないため、実行物はバージョンとハッシュで固定します。保守スクリプトの原本はVRM-Companionの `scripts` でGit管理できる構成とし、セットアップ実行時に `D:\LLM\scripts` にコピーします。

元の `llama` と別置きCUDA 13.3 DLLは `backups\legacy-20260919-200301` に退避しました。モデルの移動・改変・追加ダウンロードは行っていません。

## 日常の起動・停止

PowerShell 7（`pwsh`）で実行します。管理者権限は通常不要です。

```powershell
& D:\LLM\scripts\start-llama.ps1
& D:\LLM\scripts\stop-llama.ps1
```

既定モデルはQwen3.5-9B-Q4_K_M、接続先は `http://127.0.0.1:8080`。context 16,384、GPU layers 99、並列1、temperature 0.3、top-p 0.9、repeat penalty 1.1です。VRM Companionの接続URLを変更する必要はありません。アプリのコンテキスト設定はサーバー以下にします。起動完了は `/health` で確認し、失敗時は今回起動したプロセスを終了します。

```powershell
& D:\LLM\scripts\start-llama.ps1 -Model 'D:\LLM\models\Agents-A1-4B-Q4_K_M.gguf' -Context 4096
```

8GB VRAMで9Bモデルのサーバーを複数同時起動しないでください。使用中ポートでは起動を拒否します。停止コマンドは記録したPID・開始時刻・実行パスを照合します。従来のターミナルから手動起動したサーバーは、そのターミナルのCtrl+Cで停止します。

## 更新・比較・切り替え

取得だけでは使用版を変更しません。ネットワーク接続が必要なのは取得コマンドです。

```powershell
# 最新の安定版／番号付きプレリリースを取得
& D:\LLM\scripts\setup-llama.ps1 -Build stable
& D:\LLM\scripts\setup-llama.ps1 -Build latest
# バージョンとCUDAを指定して再現可能な取得
& D:\LLM\scripts\setup-llama.ps1 -Build b11050 -Cuda 13.4

# 比較時はサーバーを止める
& D:\LLM\scripts\stop-llama.ps1
& D:\LLM\scripts\compare-llama.ps1 -StableVersion b10964-cuda13.3 -LatestVersion b11050-cuda13.4
& D:\LLM\scripts\compare-llama-server.ps1 -StableVersion b10964-cuda13.3 -LatestVersion b11050-cuda13.4

# 採用版へ切り替えて再起動
& D:\LLM\scripts\use-llama.ps1 -Version b10964-cuda13.3
& D:\LLM\scripts\start-llama.ps1
```

将来は表示されたビルドとCUDAの番号に置き換えます。新しいCUDAがドライバーで使えるかはインストール時の `--list-devices` で検証します。失敗した場合はドライバー互換性を確認して対応する配布版を `-Cuda` で指定します。稼働中のバイナリは上書きしません。切り替え前にllamaプロセスを停止する必要があります。ロールバックは保存済みのバージョンを `use-llama.ps1` に指定するだけです。

## 動作確認

安定版を8080で起動し、GPU認識、ヘルスチェック、モデル一覧、日本語ストリーミング、会話テンプレート適用、トークン化、JSON Schema応答を実機で確認しました。VRM Companionの `scripts/verify-llama.ts` は意図判定6件すべて期待どおり、日本語挨拶の初回応答287ms・完了750msでした。この短い挨拶の値は単発の動作確認であり、上表の性能比較とは別です。
