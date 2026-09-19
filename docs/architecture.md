# VRM-Companion 基本設計書

作成日: 2026-09-19 / 状態: レビュー反映版 / 対応: [要件定義書](requirements.md)

## 1. 技術選定

**Electron + TypeScript + Three.js + @pixiv/three-vrmを第一候補とし、llama.cppは別プロセスのllama-serverとして接続する。**

透明表示、チャットUI、ローカルAPI連携を一つの言語系でまとめ、個人開発で小さく完成させるための判断である。最軽量・最高描画性能を実測で確認した結論ではない。

| 候補 | このプロジェクトとの適合 | 懸念／判断 |
| --- | --- | --- |
| Electron + Three.js | 透明ウィンドウ、トレイ、Webベースの会話UIとVRM表示をまとめやすい | Chromiumの常駐コストとGPU競合を実機確認。第一候補 |
| Tauri + Three.js | Web UIとRust側の機能を分ける構成を取れる | WebViewとOSごとの差、RustとTypeScriptの開発負担を比較。Electronのリソース目標不達時の候補 |
| Unity + UniVRM | アニメーションや3D演出を中心にする場合の有力候補 | チャットUI、透明常駐、ファイル操作との統合を別途設計。高度な3D体験を優先する場合に再評価 |

APIの存在は [ElectronウィンドウAPI](https://www.electronjs.org/docs/latest/api/browser-window)、[TauriウィンドウAPI](https://v2.tauri.app/reference/javascript/api/namespacewindow/)、[UniVRM](https://vrm.dev/en/univrm/) を参照。上表の開発負担・優先順位は本プロジェクトに対する設計判断である。

UIはTypeScriptと軽量なコンポーネント構成で開始する。React等の採用は画面実装時に決め、VRMの毎フレーム更新はUIの状態更新から分離する。Three.jsとthree-vrmの互換バージョンを組み合わせて固定し、lockfileと検証モデルを管理する。[three-vrm公式](https://github.com/pixiv/three-vrm)

対象実機はWindows 11 Pro、RTX 5070 Laptop（VRAM 8GB）。CPUとシステムRAMは未確認。LLMとVRM描画でVRAMを共有するため、8GBすべてをLLM重みに割り当てる構成は採用しない。最初の実験は小型の量子化GGUF、短めのcontext、1同時生成、30fps上限とし、実測した空き容量を見てGPUオフロード量を増やす。音声モデルを同時常駐させる場合は別途予算を見直す。

## 2. 論理構成と権限境界

```text
利用者
  ├─ Avatar Window（透明なVRM表示、入力判定、表情）
  └─ Panel Window（チャット、設定、整理プレビュー、結果）
            │ 限定したpreload API / 型付きIPC
            ▼
Electron Main（ウィンドウ管理、IPC送信元検証、認可）
  ├─ Conversation Service / Intent Router ── LLM Adapter ── localhost llama-server
  │       └─ 検証済み整理依頼 → Agent Coordinator
  ├─ Avatar Registry / Settings / Local Store
  └─ Agent Coordinator
       ├─ Scanner → Planner（固定の拡張子ルール）
       ├─ Policy Validator → Plan Store → Approval
       └─ Executor → Windows File Adapter → 許可フォルダ
                       │
                       └─ Operation Journal / Recovery
```

rendererはNode.js・シェル・任意パスへのアクセス権を持たない。Mainは`contextIsolation: true`、`sandbox: true`、`nodeIntegration: false`を前提に、IPCの送信元ウィンドウ、フレーム、引数を検証する。アバター用ウィンドウに承認APIを公開しない。会話表示はプレーンテキストを基本とし、モデル出力をHTMLやスクリプトとして実行しない。[Electronセキュリティ指針](https://www.electronjs.org/docs/latest/tutorial/security)

ローカル同梱コンテンツだけを読み込み、CSP、外部遷移・外部リソースの拒否を適用する。preloadで汎用`invoke(channel, args)`を公開せず、用途別メソッドに絞る。スキャン、ハッシュ計算、DB処理、移動などの重い仕事はworkerまたは補助プロセスへ移す。プロセス分割だけをOSのアクセス制限とは見なさず、アプリ側の検証を必須とする。

## 3. 画面・ウィンドウ設計

| 画面 | 役割 |
| --- | --- |
| Avatar Window | フレームなし・透明・小さな描画領域。キャラクターを表示し、クリックでパネルを開く |
| Panel Window | 通常ウィンドウ。会話、送信・停止、接続状態、作業カード、モデル・人格設定 |
| 整理プレビュー | 対象ルート、移動前後一覧、理由、除外、分類先修正、件数、「この内容で整理する」 |
| 作業結果／復元 | 成功・失敗・未実行、エラー理由、復元案、競合表示 |
| トレイ | パネルを開く、表示／非表示、操作モード、緊急停止、終了 |

初期版は吹き出しを別ウィンドウにせず、会話をPanelに集約する。アバターのドラッグは専用操作モードで行う。倍率はカメラ／モデルのスケールで変え、透明ウィンドウ自体のリサイズには依存しない。全画面オーバーレイは避ける。

透明背景だけではクリックは透過しない。`setIgnoreMouseEvents`とWindowsでのマウス移動転送を使い、キャラクターの当たり判定に応じて入力を切り替える。初期判定は3Dレイキャストとし、半透明の髪・装飾では完全なピクセル単位判定を保証しない。操作不能時はトレイから全体透過を解除する。[透明ウィンドウの制約](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles)、[クリック透過API](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions)

混在DPI、複数モニター、負座標、モニター切断を検証し、保存位置が画面外なら使用中モニターへ戻す。最前面は切替可能にし、通知や作業完了でフォーカスを奪わない。

## 4. VRM表示とキャラクター制御

モデルの探索・選定・入手はユーザーに委ねる。モデル検索、推薦、配布、固定アバターの同梱はMVPに含めない。ユーザーが選んだ対応仕様・上限内のVRMを受け入れ、作者・見た目・モデル名による制限は設けない。未選択時はインポート案内を表示する。人格設定はモデルの外見と独立して管理する。

インポートは、ファイル選択 → サイズ／GLB形式／VRM拡張の検査 → 埋め込みメタ情報の表示 → 一時プレビュー → 管理領域へ保存 → 選択切替、の順とする。検証失敗時は既存モデルを維持する。外部URLや外部ファイルを参照するアセットは初期版では拒否する。

VRM 0.xと1.0は内部アダプターで向き・表情・メタ情報を統一する。両世代には仕様差があるため、単に拡張子が同じという理由で同一処理にしない。[VRM 1.0の変更点](https://vrm.dev/en/vrm1/changed/)

検証用の初期上限案はファイル100MiB、三角形20万、テクスチャ一辺4096px、デコード後テクスチャ合計256MiBとし、利用モデルを測定して確定する。メタ情報の文字列も長さ制限して表示する。読み込み時間・メモリを監視し、停止できない読み込みはrenderer再生成で回復する。

表示状態は`idle / thinking / responding / working / success / error`。利用可能なまばたき、視線、表情、ボーン動作へ変換する。表情の対応がないモデルは中立表示に戻し、neutral自体がない場合は表情ウェイトの変更を行わない。状態はパネルのテキストでも伝える。特定の衣装・性別・キャラクター設定を前提とせず、LLMへ毎フレームの制御を任せない。VRMに歩行や特定の仕草が付属すると仮定せず、追加動作は後続版のモーション機能として扱う。

切替時は古いモデルのgeometry・material・textureなどを解放する。表情とまばたきの競合を調整し、非表示時は描画を停止、復帰時は経過時間を制限して物理の飛びを抑える。

## 5. llama.cppとの接続

v0.1は利用者が起動したllama-serverへ接続する。LLMバイナリやモデルの同梱、ダウンロード、GPUバックエンドの自動セットアップは後続版とする。

接続先は`http://127.0.0.1:<port>`またはIPv6ループバックに限定し、HTTPリダイレクトを拒否する。APIキーを設定可能にし、rendererやログに渡さない。外部起動サーバーのlisten設定自体はアプリで強制できないため、セットアップでループバックbindと認証を案内する。

アダプターは`/health`、`/v1/models`、`/v1/chat/completions`を使用する。SSEの分割受信を正しく組み立て、中断はAbortController等で通信を停止する。通信の中断後にサーバー側計算が停止するかは採用ビルドで確認する。OpenAI互換は全仕様への完全互換とはみなさない。[llama-server公式資料](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)

会話はsystem（人格と応答規則）、直近履歴、現在入力を基本とする。モデルのコンテキスト上限から生成予約分を除き、古い履歴から外す。履歴の省略をUIに表示する。初期版は自動要約・ベクトルDBを必須にせず、会話履歴と恒久的な記憶を区別する。

同時生成は1件。依頼の解釈と通常会話の生成をキューで直列化し、停止を優先する。分類・計画生成自体はLLMを呼ばない。接続5秒、最初の応答60秒、応答無通信30秒、1リクエスト全体180秒を初期タイムアウト案とし、低速PC向けに設定可能とする。ネットワーク障害では変更操作を自動再試行しない。

### 構造化出力

LLMは依頼の解釈に使い、MVPの分類は固定ルールで行う。意図判定はschema制約付きJSONを採用し、アプリで再検証する。function callingとの二重実装はMVPに含めない。モデルとchat templateを含む採用構成で構造化出力を確認する。[llama-serverのresponse_format](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)

JSON修復の再生成は1回まで。それでも失敗したら依頼を開始せず、明示的な「種類別に整理」ボタンを案内する。1ユーザー入力につき意図判定・修復・通常応答を合わせ最大3推論呼び出し、同時ジョブ1件とし、無制限なエージェントループを作らない。llama-server組み込みのファイル操作・shellツールは有効化せず、実行はアプリ側に集約する。

### 会話から整理への契約

`chat.send(conversationId, text)`はMain側のIntent Routerへ渡る。意図判定中のJSONや説明文はチャットに逐次表示しない。判定結果の概念スキーマは`{ intent: chat | organize | clarify | unsupported, method: by_extension | null, target: selected | unspecified | other }`とし、追加キーや不正な値を拒否する。LLMにrootId、絶対パス、承認情報を生成させない。

| 分岐 | 処理 |
| --- | --- |
| `chat` | 通常応答を別リクエストでストリーミング表示する。ファイル操作は開始しない |
| `organize` + `by_extension` | 対象を確定後、検証済みの型付き要求でPlannerを呼び、整理カードを同じ会話に追加する |
| `clarify` / method未指定 | アプリの定型質問で種類別整理かを確認し、選択ボタンでpending requestを補完する |
| `unsupported` / 未対応method | 案件別・意味による分類などは未対応と表示。種類別整理への切替を選ぶまで計画を作らない |

対象は会話に紐づくユーザー選択済みの`selectedRootId`を使う。`target=selected`でも選択がなければ対象選択を求める。`unspecified`または別フォルダの指定では既存の許可ルート選択／OSダイアログへ誘導し、自然文のフォルダ名を勝手に解決しない。UIで選んだrootIdのみをMainで照合して採用する。

確認待ちは`requestId + conversationId`に結びつけ、選択後に同じ依頼を再開する。キャンセル・新規会話・権限解除で破棄し、古い回答を別依頼へ流用しない。計画カードには対象ルートと固定分類方式を常に表示する。明示的な整理ボタンも同じPlanner経路を使い、LLM判定を省略できる。

作業依頼として扱うターンの受付・進行・完了・失敗メッセージはアプリの定型文で生成する。`job.result`の件数・パス・状態を唯一の結果根拠とし、LLMによる要約や成功文は挿入しない。作業結果を尋ねるUIは記録済みjobIdを参照する。通常のLLM会話は実行記録ではなく、誤判定・幻覚を完全に防げるとはしないが、その文章を実行済み状態や成功カードへ昇格させない。

## 6. フォルダ整理の設計

### 6.1 対象とスキャン

許可はOSダイアログで選んだルートのIDで管理する。`readMetadata`と`organizeFiles`を区別し、会話から権限を追加できない。解除時は待機計画を無効化し、実行中は進行中の1操作を収束させて停止する。

MVPは直下のみを走査し、サブフォルダへ降りない。直下の走査1万エントリ、1計画200ファイルを初期上限とする。走査上限に達した場合は不完全な一覧と明示し、範囲を絞って再走査する。分類済みサブフォルダ内のファイルは再整理しない。候補が計画上限を超えた場合は利用者が対象を絞るまで承認できず、黙って先頭だけを実行しない。

分類入力はスキャナーが割り当てた`fileId`、相対パス、拡張子、サイズ、更新日時とし、分類判断には固定の拡張子ルールを使う。ファイルの名前・本文・一覧は分類のためにLLMへ送らない。整合性検証のハッシュ計算ではローカルで内容を読み取るため、「本文を読み取らない」とは説明しない。ファイル名に含まれる命令を解釈せず、判定不能なものは保持する。

システム・アプリ管理領域、隠し／システム属性、再解析ポイントとその配下を除外する。同期フォルダは未対応とし、既知の同期ルートとクラウド属性を検出して拒否する。ただし任意の同期ソフトを完全検出できるとはしないため、通常のローカルフォルダであることをセットアップに明示する。

### 6.2 計画の生成と承認

Plannerが拡張子対応表から`fileId → categoryId`と分類理由を生成する。例は`.png/.jpg → 画像`、`.pdf/.txt → 文書`。大文字小文字を正規化し、完全な対応表はバージョン付きの同梱設定として実装時に固定する。カテゴリは画像、文書、動画、音声、圧縮ファイル、その他、変更なしとし、未知・拡張子なしは自動で移動せず「変更なし」にする。「その他」はユーザーが明示選択したときだけ使う。

ユーザーはファイルの除外と固定カテゴリへの変更ができる。分類先フォルダ名の自由入力はMVPに含めない。LLMの出力から分類先・移動パスを作らず、同じsnapshot・ルール版・ユーザー修正なら同じ計画を作る。

アプリは元ファイル名を維持した移動計画へ展開する。移動先は同一ルート直下の分類フォルダに限る。ディレクトリ移動・リネーム・内容変更は含めない。同名衝突は自動連番で処理せず、当該項目を計画から除外して理由を表示する。必要な分類フォルダの新規作成もプレビューに含める。

計画は正規化した内容のhash、revision、scanId、対象ファイルの識別情報と結びつけて保存する。承認はMainが発行する一回限りの記録にし、UIからの承認を`planId + revision + hash`に固定する。有効期限は初期案10分。内容変更、対象状態の変化、権限変更、アプリ再起動で失効する。

### 6.3 実行前の検証

文字列の前方一致だけで許可ルートを判定しない。実体パス・ボリューム・ファイルID・親ディレクトリを確認し、`..`、UNC、デバイスパス、代替データストリーム、末尾ドット／空白、大小文字別名、ジャンクション／symlinkによる逸脱を拒否する。

承認後の差し替えに備え、実行直前にもファイルの識別・サイズ・更新日時・SHA-256を照合する。ハッシュは整理対象候補に対してバックグラウンドで計算し、承認可能になる前に確定する。リンク数が複数のファイルは初期版で除外する。移動元／先の親を含めた再解析ポイントの検査を行う。

ハッシュ対象は1ファイル512MiB以下、1計画のファイルサイズ合計2GiB以下、200ファイル以下を初期上限とする。上限超過を一覧に示し、除外して上限内に収めるまでハッシュ計算と承認を開始しない。サイズ合計は候補確定時と実行直前に再確認し、増加・変更時は計画を失効させる。承認前と実行時で合計最大4GiB程度の読取りを要するため、元データサイズと読取り進捗は区別して表示する。復旧・復元でも別フェーズとして同じ上限を適用し、対象変更・上限超過は自動処理せず報告する。

計算はストリーム読取りで行い、読取り済みバイト数、対象件数、停止ボタンを表示する。キャンセルや読取り失敗時は未検証として保持し、移動を開始しない。実行中の検証中断は完了済み操作を記録して後続を停止する。性能はP3で測定し、上限変更は設定値と検証条件を同時に更新する。

`realpath`チェック後の通常のrenameだけでは競合時間差を塞げない。Windows File Adapterは、ハンドルに基づく識別と親の保持、置換を禁止した同一ボリューム移動を行う小さなネイティブ補助層を想定する。OSの共有・renameの挙動とAPI方式はP0/P3で実証し、条件を満たせなければ実ファイル移動を公開しない。単純な「存在しなければrename」の実装で代用しない。

### 6.4 実行・記録・復旧

操作は直列化する。各操作について「実行予定を永続化 → OS操作 → 結果を永続化」の順とする。アプリの重複起動と同時ジョブを防止する。DBトランザクションとファイルシステム操作は一つの原子的処理にはならない。

```text
draft → validated → awaiting_approval → approved → executing → completed
             ↑             │                         ├→ partial / failed
             └─ 編集 ──────┘                         └→ canceled
再起動時のexecuting → recovery_required → 照合 → 結果確定／手動対応
```

移動失敗、ファイル状態変更、記録失敗が起きたら後続操作を停止する。キャンセルは進行中の1操作の結果を確定した後に止める。完了済みを勝手に巻き戻さず、結果と復元選択肢を提示する。記録用ディスク容量不足の場合は新しい変更を開始しない。

クラッシュで結果不明となった項目は、元・先の存在とファイルID・hashを照合する。元だけに一致すれば未実行、先だけに一致すれば実行済みとして記録を補完する。両方ある、どちらにもない、識別が一致しない場合は自動処理しない。同じ操作IDの再実行で二重移動しない。

復元は成功項目の逆順に別計画を生成して承認する。移動先の内容が変更済み、元のパスが使用済み、ルートの許可が解除済みならスキップして報告する。復元も履歴へ残す。新規作成した空の分類フォルダは初期版では残す。外部アプリによる変更を含む完全なロールバックは保証しない。

## 7. データとAPIの契約

保存先はElectronの`userData`配下とし、実際の絶対パスを設定画面に表示する。SQLiteに設定・履歴・計画・操作記録を置き、VRM本体は`avatars/<id>/model.vrm`へ保存する。SQLite実装はパッケージ化とクラッシュ復旧を検証して選ぶ。操作ジャーナルは各手順で永続化し、ファイル操作より先に記録する。

| エンティティ | 主な項目 |
| --- | --- |
| Avatar | id, managedPath, contentHash, vrmVersion, metadata, displaySettings |
| Persona | id, displayName, userName, speakingStyle |
| ModelProfile | endpoint, modelId, contextLimit, outputLimit, structuredOutputVerified, testedBuild |
| Conversation / Message | id, personaId, role, content, createdAt, status |
| PendingRequest | requestId, conversationId, intent, method, selectedRootId, state |
| AllowedRoot | id, canonicalPath, volumeId, directoryId, permissions, revokedAt |
| ScanSnapshot | id, rootId, completed, createdAt, entriesと識別情報 |
| OrganizationPlan | id, revision, hash, scanId, ruleVersion, totalBytes, operations, status, expiresAt |
| Approval | planId, revision, hash, grantedAt, consumedAt |
| OperationJournal | operationId, planId, source, destination, beforeIdentity, afterIdentity, state, error |

計画スキーマの概念例（パスはアプリが生成し、LLMが直接指定しない）:

```json
{
  "id": "plan-001",
  "revision": 1,
  "rootId": "root-001",
  "scanId": "scan-001",
  "operations": [
    { "id": "op-001", "kind": "mkdir", "relativePath": "画像" },
    { "id": "op-002", "kind": "move", "fileId": "file-001",
      "from": "photo.png", "to": "画像/photo.png" }
  ],
  "status": "awaiting_approval"
}
```

| preloadメソッド | 呼び出し元／意味 |
| --- | --- |
| `avatar.importFromDialog()` / `avatar.select(id)` | Panelのみ。任意パスの読出しAPIは公開しない |
| `chat.send(conversationId, text)` / `chat.cancel(requestId)` | Panelのみ。Intent Routerを経由し、意図判定または通常応答を中断できる |
| `chat.resolveRequest(requestId, rootId, method)` | Panelの確認カードのみ。保留依頼を同一会話の選択結果で補完する |
| `roots.selectFromDialog()` / `roots.revoke(rootId)` | Panelのみ。フォルダ権限の変更 |
| `organize.propose(conversationId, rootId, method)` | Panelの明示ボタンのみ。methodはby_extension固定。Routerも同じMain側サービスを呼ぶ |
| `organize.cancelPreparation(requestId)` | Panelのみ。計画準備中のスキャン・ハッシュ計算を停止し、未検証の計画を承認不可にする |
| `organize.edit(planId, revision, selections)` | Panelのみ。候補からの除外・分類修正、再検証 |
| `organize.approve(planId, revision, hash)` | Panelの承認画面のみ。保存済み計画に対する承認と開始 |
| `organize.cancel(jobId)` / `organize.previewUndo(jobId)` | 停止／復元案生成。復元も通常の承認経路を使う |
| `window.setInteractionMode(mode)` | 許可した表示用設定のみ。任意ウィンドウ指定を禁止 |

イベントは`chat.delta / chat.done / chat.error / chat.actionRequired / avatar.state / plan.progress / plan.ready / job.progress / job.result`に限定する。各イベントにrequestIdまたはjobIdと連番を付け、古い要求の出力を現在の画面へ混ぜない。`plan.progress`にはスキャン／ハッシュのフェーズと処理量を含める。

会話保存無効時は会話をメモリ上だけに保持する。一方、変更操作の復旧ジャーナルは必須であり無効化しない。UIで違いを説明する。作業履歴は初期版では自動削除しない。完了済み履歴の明示削除時は復元できなくなる範囲を表示し、未解決の復旧記録は削除対象にしない。DBのschemaVersionと移行前バックアップを管理する。

## 8. 推奨コード構成

```text
src/
  main/             # Electron起動、トレイ、ウィンドウ、IPC
  preload/          # 限定したAPI公開
  renderer/avatar/  # Three.js、VRM、入力判定、表情
  renderer/panel/   # 会話、設定、整理案・結果
  domain/chat/      # 文脈、人格、応答状態
  domain/organize/  # 計画、検証、承認、復旧ルール
  adapters/llama/   # HTTP、SSE、構造化出力
  adapters/files/   # スキャン、Windows File Adapter
  adapters/storage/ # SQLite、モデル保管
  shared/           # IPC・イベントのスキーマ
native/windows-files/ # 必要なハンドル操作だけを持つ補助層
tests/fixtures/     # 自作の整理用ファイル、利用可能なVRM参照
```

これは作成予定の構成であり、現時点では存在しない。独自の汎用エージェント基盤、プラグイン機構、MCP統合はv0.1に追加しない。ファイル操作は監査できる固定機能から始める。

## 9. 主な設計判断

| 判断 | 理由 | 再検討する条件 |
| --- | --- | --- |
| Electronを第一候補 | 表示・会話・PC統合を短い経路で作る | P0で常駐負荷や透過の目標を満たせない |
| llama-serverを外部起動 | GPUビルドとモデル配布をアプリから切り離す | セットアップの手間が日常利用を妨げる |
| 1体・テキスト先行 | 音声はMVP対象外という利用者の指定。まず「一緒にいる・話す」を確かめる | MVP後の音声機能追加時 |
| 提案と実行を分離 | モデルの誤りで未承認のファイル変更を起こさない | 分離自体は維持し、自律ルールだけ追加 |
| 任意のユーザー提供VRM | 外見・モデル選定をユーザーに委ね、特定モデルへ依存しない | 対応仕様と上限は互換性検証に応じて更新 |
| LLMは依頼解釈、分類は固定ルール | 処理時間と結果を予測可能にする。本文をLLMへ送らない | 意味に基づく分類が必要になった段階 |
| 直下から固定フォルダへの移動のみ | 対応範囲を縮めつつ承認・記録・復元を維持する | 検証済みの復旧方式で再帰整理等を追加できる |

参照したWeb資料は2026-09-19時点。実装時は採用するリリース／commitと依存バージョンを別途記録し、最新版ドキュメントの記述をそのまま固定仕様としない。
