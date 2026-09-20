# VRM-Companion 基本設計書

作成・更新日: 2026-09-20 / 状態: 承認済み設計の実装反映版・受け入れ検証中 / 対応: [要件定義書](requirements.md)

本書は設計意図と現在の実装を記録する。承認済みの受け入れ条件は変更しない。実装済みであることと実機での合格は区別し、最新の結果と残る差分は[検証記録](verification.md)を参照する。

## 1. 技術選定

**Electron + TypeScript + Three.js + @pixiv/three-vrmを採用し、llama.cppは別プロセスのllama-serverとして接続する。**

透明表示、チャットUI、ローカルAPI連携を一つの言語系でまとめ、個人開発で小さく完成させるための判断である。最軽量・最高描画性能を実測で確認した結論ではない。

| 候補 | このプロジェクトとの適合 | 懸念／判断 |
| --- | --- | --- |
| Electron + Three.js | 透明ウィンドウ、トレイ、Webベースの会話UIとVRM表示をまとめやすい | 現在の採用構成。Chromiumの常駐コストとGPU競合を実機確認 |
| Tauri + Three.js | Web UIとRust側の機能を分ける構成を取れる | WebViewとOSごとの差、RustとTypeScriptの開発負担を比較。Electronのリソース目標不達時の候補 |
| Unity + UniVRM | アニメーションや3D演出を中心にする場合の有力候補 | 利用者がUnityを新規導入し使用を許可済み。現実装では使用せず、高度な3D体験を優先する場合に再評価 |

APIの存在は [ElectronウィンドウAPI](https://www.electronjs.org/docs/latest/api/browser-window)、[TauriウィンドウAPI](https://v2.tauri.app/reference/javascript/api/namespacewindow/)、[UniVRM](https://vrm.dev/en/univrm/) を参照。上表の開発負担・優先順位は本プロジェクトに対する設計判断である。

UIはTypeScriptによるDOM操作で実装し、Reactは使用していない。VRMの毎フレーム更新はパネルの状態更新から分離する。現在の組合せはElectron 44.4.3、Three.js 0.180.0、three-vrm 3.5.5で、実際の依存解決はpackage-lock.jsonに記録する。package.jsonのThree.js指定は`^0.180.0`であるため、更新時はlockfileと互換性試験を確認する。[three-vrm公式](https://github.com/pixiv/three-vrm)

対象実機はWindows 11 Pro、AMD Ryzen 7 260、RAM 32GB、RTX 5070 Laptop（VRAM 8GB）、NVIDIAドライバー32.0.16.1692。LLMとVRM描画でVRAMを共有するため、GGUFの容量だけでGPU使用量を判断しない。現アプリの既定はcontext 4096、応答上限512トークン、1同時生成、30fps。実測した空き容量を見てGPUオフロード量を調整する。これらは性能保証値ではなく、音声モデルを同時常駐させる場合は別途予算を見直す。

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

ローカル同梱コンテンツだけを読み込み、CSP、外部遷移・外部リソースの拒否を適用する。preloadで汎用`invoke(channel, args)`を公開せず、用途別メソッドに絞る。スキャン、ハッシュ計算、移動はC#製の補助プロセス`CompanionFiles.exe`で行う。操作ジャーナルの短いDB更新はMain内の`node:sqlite` / `DatabaseSync`を使い、永続化完了を待ってから変更を実行する。`VACUUM INTO`と過去バックアップ内の会話削除は単発workerへ分離し、VRMのJSON・画像ヘッダー検査・SHA-256もworkerで行う。画像の寸法はデコード前に確認する。全DB処理をworker化した構成ではなく、起動時検査・通常の読書きはMainに残る。プロセス分割だけをOSのアクセス制限とは見なさず、アプリ側の検証を必須とする。

上図のService、Router、Coordinatorは責務名である。実ファイルではウィンドウ／IPC／会話調停を`src/main/index.ts`、LLM通信と意図判定を`llama.ts`、整理計画・実行・復旧を`files.ts`、保存を`store.ts`に実装している。詳細な対応は第8節に示す。

## 3. 画面・ウィンドウ設計

| 画面 | 役割 |
| --- | --- |
| Avatar Window | フレームなし・透明・小さな描画領域。キャラクターを表示し、クリックでパネルを開く |
| Panel Window | 通常ウィンドウ。会話、送信・停止、接続状態、作業カード、モデル・人格設定 |
| 整理プレビュー | 対象ルート、移動前後一覧、理由、除外、分類先修正、件数、「この内容で整理する」 |
| 作業結果／復元 | 成功・失敗・未実行、エラー理由、復元案、競合表示 |
| トレイ | パネルを開く、表示／非表示、操作モード、緊急停止、終了 |

初期版は吹き出しを別ウィンドウにせず、会話をPanelに集約する。アバターは380×540の透明ウィンドウで表示し、モデル上のドラッグに対応する。トレイには自動クリック透過・移動モード・全体クリック透過を用意する。倍率はカメラ距離で変え、透明ウィンドウ自体のリサイズには依存しない。全画面オーバーレイは避ける。

全タブ共通のパネル上部とアバター右クリックメニューに、アプリを終了せず表示だけを隠す操作を設ける。表示切替は会話・ファイル処理中でも可能。`Settings.avatarVisible`に明示的な表示希望を保存し、`State.avatarVisible`で実ウィンドウの表示状態を伝える。非表示時は描画とドラッグを止め、モデル選択・会話・作業は保持する。再起動時も非表示を維持する。

透明背景だけではクリックは透過しない。`setIgnoreMouseEvents`とWindowsでのマウス移動転送を使い、キャラクターの当たり判定に応じて入力を切り替える。初期判定は3Dレイキャストとし、半透明の髪・装飾では完全なピクセル単位判定を保証しない。操作不能時はトレイから全体透過を解除する。[透明ウィンドウの制約](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles)、[クリック透過API](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions)

混在DPI、複数モニター、負座標、モニター切断を検証し、保存位置が画面外なら使用中モニターへ戻す。最前面は切替可能にし、通知や作業完了でフォーカスを奪わない。

## 4. VRM表示とキャラクター制御

モデルの探索・選定・入手はユーザーに委ねる。モデル検索、推薦、配布、固定アバターの同梱はMVPに含めない。ユーザーが選んだ対応仕様・上限内のVRMを受け入れ、作者・見た目・モデル名による制限は設けない。未選択時はインポート案内を表示する。人格設定はモデルの外見と独立して管理する。

インポートは、ファイル選択 → サイズ／GLB形式／VRM拡張の検査 → 埋め込みメタ情報の表示・利用者確認 → 管理領域への候補コピー → 一時プレビュー → 選択の永続化、の順で実装した。当初案の「プレビュー後にファイル保存」と異なり、候補のVRMバイトを先に保管し、表示成功後にモデル登録と選択を確定する。失敗・タイムアウト時は未登録候補を除去して既存モデルへ戻す。外部URL、外部ファイル、URI形式の画像を含むアセットは拒否する。

VRM 0.xと1.0は内部アダプターで向き・表情・メタ情報を統一する。両世代には仕様差があるため、単に拡張子が同じという理由で同一処理にしない。[VRM 1.0の変更点](https://vrm.dev/en/vrm1/changed/)

現在の入力検査上限はファイル100MiB、三角形20万、テクスチャ一辺4096px、デコード後テクスチャ合計256MiB、ノード1万、GLBのJSONチャンク8MiB。メタ情報の文字列は2000文字で制限し、Draco圧縮メッシュは未対応として拒否する。プレビューは30秒で打ち切り、古い非同期ロード結果を世代番号で破棄する。renderer停止時はトレイから再表示・再読込みできる。モデル間の表示互換性や負荷の受け入れ結果は別途検証する。

表示状態の実装名は`idle / thinking / responding / working / success / error / canceled / attention`。`motion.ts`で正規化Humanoidボーンを制御し、呼吸・重心の小さな揺れ・視線・手振り・うなずき・おじぎ・伸びを合成する。表情は`blink`、`happy`、`relaxed`を利用可能な範囲で用いる。動作には補間と復帰を設け、モーション強度を選べる。姿勢を毎フレーム基準姿勢から計算し、累積回転を避ける。特定の衣装・性別・モデル名や付属アニメーションに依存せず、LLMへ毎フレームの制御を任せない。

非表示時にはrequestAnimationFrameの予約自体を取消し、復帰時に再開する。描画品質の上限DPRは省リソース1・標準1.5・高画質2。当たり判定を約30Hzに制限し、判定変化時だけIPCを送る。ドラッグ開始から終了までクリック透過を固定解除し、移動を16msごとにまとめる。移動は固定DIP寸法付きsetBoundsで行い、透明ウィンドウをinvalidateする。これにより125% DPIで観測した移動中の寸法増加を防ぐ。

切替時は古いモデルのgeometry・material・textureなどを解放する。表情とまばたきの競合を調整し、非表示時は描画を停止、復帰時は経過時間を制限して物理の飛びを抑える。

## 5. llama.cppとの接続

外部起動のllama-serverへの接続と、アプリ管理モードを選べる。管理モードは`model-runtime.ts`で利用者が選択した実行ファイルとGGUFフォルダーを扱い、シェルを介さず子プロセスを起動する。直下一覧とファイルヘッダーを検証し、モデルの指定にはMainで発行したIDを使う。1モデルずつ動かし、切替・解放・終了では保持した子プロセスの終了を待つ。外部プロセスは終了しない。

起動は127.0.0.1の空きポート、起動ごとのランダムAPIキー、固定aliasで行う。キーをrendererに渡さず、認証付きモデル一覧で準備完了を確認する。起動期限は3分で、停止・失敗時は子プロセスを回収する。既定context 4096、並列1、batch 512、ubatch 128、cache-ram 0、fit on / target 1024MiB、flash-attn auto。未使用時の解放は既定5分。通常起動でLLMを先読みせず、選択・接続確認・送信時に必要なモデルを読み込む。

LLMバイナリ・モデルの同梱、ダウンロード、GPUバックエンドの自動セットアップは行わない。開発・セットアップ用の`setup-llama.ps1`と`start-llama.ps1`による外部環境の準備とは区別する。

初期検証にはユーザー提供の`Qwen3.5-9B-Q4_K_M.gguf`と旧llama.cpp b9843を使用した。その後、共有環境を`D:\LLM`へ集約し、現在の管理モードはb10964（v0.4.1、CUDA 13.3）でQwen 9BとLFM 1.2Bを検証している。外部接続先の既定8080は維持し、管理モードは別の空きポートを使う。環境構成は[llama.cpp環境管理](llama-environment.md)、追加機能の結果は[改善記録](improvements.md)を参照する。

接続先は`http://127.0.0.1:<port>`またはIPv6ループバックに限定し、HTTPリダイレクトを拒否する。APIキーを設定可能にし、rendererやログに渡さない。外部起動サーバーのlisten設定自体はアプリで強制できないため、セットアップでループバックbindと認証を案内する。

アダプターは`/health`、`/v1/models`、`/v1/chat/completions`を使用する。さらに`/apply-template`と`/tokenize`で会話テンプレート込みの入力トークン数を数える。旧サーバーが404/405/501を返す場合のみ保守的なUTF-8バイト数推定へ切り替え、認証失敗・切断・不正応答は隠さない。SSEの分割受信を組み立て、中断や解析エラーではAbortControllerとreaderのキャンセルで通信を停止する。通信の中断後にサーバー側計算が停止するかは採用ビルドで確認する。OpenAI互換は全仕様への完全互換とはみなさない。[llama-server公式資料](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)

会話はsystem（人格と応答規則）、直近履歴、現在入力を基本とする。モデルのコンテキスト上限から生成予約分を除き、古い履歴から外す。履歴の省略をUIに表示する。初期版は自動要約・ベクトルDBを必須にせず、会話履歴と恒久的な記憶を区別する。

同時生成は1件。Mainの`busy`で同時ジョブを拒否する。通常の「会話」は直接応答を生成し、利用者が選んだ「整理依頼」だけ意図判定を行う。整理依頼でchatと判定された場合は通常応答を続ける。分類・計画生成自体はLLMを呼ばない。現実装は接続確認全体15秒、意図判定全体60秒、通常応答の最初の通信60秒・受信後の無通信30秒・全体180秒。当初案の接続5秒およびUIからのタイムアウト変更は未実装の差分として残る。ネットワーク障害では変更操作を自動再試行しない。生成時は`chat_template_kwargs.enable_thinking=false`を渡す。

### 構造化出力

LLMは依頼の解釈に使い、MVPの分類は固定ルールで行う。意図判定はschema制約付きJSONを採用し、アプリで再検証する。function callingとの二重実装はMVPに含めない。モデルとchat templateを含む採用構成で構造化出力を確認する。[llama-serverのresponse_format](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)

JSON修復の再生成は1回まで。それでも失敗したら依頼を開始せず、明示的な「種類別に整理」ボタンを案内する。1ユーザー入力につき意図判定・修復・通常応答を合わせ最大3推論呼び出し、同時ジョブ1件とし、無制限なエージェントループを作らない。llama-server組み込みのファイル操作・shellツールは有効化せず、実行はアプリ側に集約する。

### 会話から整理への契約

`window.companion.send(conversationId, text, mode?)`は`chat`（省略時）と`organize`をMainで検証する。`chat`は通常応答へ直接渡し、`organize`だけIntent Routerへ渡る。意図判定中のJSONや説明文はチャットに逐次表示しない。判定スキーマは`{ intent: chat | organize | clarify | unsupported, method: by_extension | null, target: selected | unspecified | other }`とし、Zodのstrict schemaで追加キーや不正な値を拒否する。LLMにrootId、絶対パス、承認情報を生成させない。

| 分岐 | 処理 |
| --- | --- |
| `chat` | 通常応答を別リクエストでストリーミング表示する。ファイル操作は開始しない |
| `organize` + `by_extension` | 対象を確定後、検証済みの型付き要求でPlannerを呼び、整理カードを同じ会話に追加する |
| `clarify` / method未指定 | アプリの定型質問で種類別整理かを確認し、選択ボタンでpending requestを補完する |
| `unsupported` / 未対応method | 案件別・意味による分類などは未対応と表示。種類別整理への切替を選ぶまで計画を作らない |

対象は会話に紐づくユーザー選択済みの`Conversation.rootId`を使う（設計時の`selectedRootId`に相当）。`target=selected`でも選択がなければ対象選択を求める。`unspecified`または別フォルダの指定では既存の許可ルート選択／OSダイアログへ誘導し、自然文のフォルダ名を勝手に解決しない。UIで選んだrootIdのみをMainで照合して採用する。

確認待ちは`Pending.id + conversationId`に結びつけ、選択後に同じ依頼を再開する。キャンセル・新規会話・権限解除で破棄し、古い回答を別依頼へ流用しない。計画カードには対象ルートと固定分類方式を常に表示する。明示的な整理ボタンも同じ`Organizer.propose`経路を使い、LLM判定を省略できる。

作業依頼として扱うターンの受付・進行・完了・失敗メッセージはアプリの定型文で生成する。現実装は`Plan.operations`に記録された件数・パス・状態を唯一の結果根拠とし、LLMによる要約や成功文は挿入しない。設計時の独立した`job.result`イベント／jobIdは設けず、計画IDを作業記録IDとして使用する。通常のLLM会話は実行記録ではなく、誤判定・幻覚を完全に防げるとはしないが、その文章を実行済み状態や成功カードへ昇格させない。

## 6. フォルダ整理の設計

### 6.1 対象とスキャン

許可はOSダイアログで選んだ`Root`のID・パス・ディレクトリ識別情報・`revoked`で管理し、会話から権限を追加できない。現実装は登録済みルートの走査許可と、計画単位の明示承認による変更許可を分離している。設計時の`readMetadata`／`organizeFiles`という個別の永続権限フラグは設けていない。解除時はメモリ内の失効と停止フラグを先に設定し、その後にDBへ保存する。保存失敗でもそのプロセス内の権限は戻らず、再登録時も古い承認は失効する。実行中は進行中の1操作を収束させて停止する。

MVPは直下のみを走査し、サブフォルダへ降りない。直下の走査1万エントリ、1計画200ファイルを上限とする。現実装は走査上限を超えると走査全体をエラーとし、不完全な一覧を保存・承認させない。分類済みサブフォルダ内のファイルは再整理しない。候補が計画上限を超えた場合は利用者が対象を絞るまで承認できず、黙って先頭だけを実行しない。

走査結果は相対名・サイズ・更新日時・ネイティブのファイル識別情報を含み、アプリが候補ごとに`Entry.id`を割り当てる。分類判断には固定の拡張子ルールを使う。ファイルの名前・本文・一覧は分類のためにLLMへ送らない。整合性検証のハッシュ計算ではローカルで内容を読み取るため、「本文を読み取らない」とは説明しない。ファイル名に含まれる命令を解釈せず、判定不能なものは保持する。

システム・アプリ管理領域、隠し／システム属性、再解析ポイントとその配下を除外する。Mainからアプリ本体と実行ファイル配置先を保護パスとして渡し、ユーザーデータ／ネイティブ補助層と合わせて境界付きで照合する。同期フォルダは未対応とし、既知のOneDrive環境変数とクラウド属性を検出して拒否する。ただし任意の同期ソフトを完全検出できるとはしないため、通常のローカルフォルダであることをセットアップに明示する。

### 6.2 計画の生成と承認

Plannerが拡張子対応表から分類と理由を生成する。実装上は`Entry.id`と`Entry.category`を使い、`.png/.jpg → 画像`、`.pdf/.txt → 文書`などの対応表を`src/main/files.ts`に固定している。ルール版は計画hash内の`ruleVersion: 1`とする。カテゴリは画像、文書、動画、音声、圧縮ファイル、その他、変更なしとし、未知・拡張子なしは自動で移動せず「変更なし」にする。「その他」はユーザーが明示選択したときだけ使う。

ユーザーはファイルの除外と固定カテゴリへの変更ができる。分類先フォルダ名の自由入力はMVPに含めない。LLMの出力から分類先・移動パスを作らず、同じsnapshot・ルール版・ユーザー修正なら同じ計画を作る。

アプリは元ファイル名を維持した移動計画へ展開する。移動先は同一ルート直下の分類フォルダに限る。ディレクトリ移動・リネーム・内容変更は含めない。同名衝突は自動連番で処理せず、検証時に判明した項目を理由付きで除外し「変更なし」にする。承認後の競合は実行時のカーネル検査で拒否して後続を停止する。必要な分類フォルダの新規作成もプレビューに含める。

計画は内容のSHA-256、revision、rootId／rootIdentity、対象ファイルの識別情報と結びつけて保存する。現実装は走査結果を`Plan.entries`へ保持し、独立したscanIdは設けていない。承認を`planId + revision + hash`に固定し、Mainが消費時刻を記録して`ready`から`executing`へ移す。再実行は状態検査で拒否する。有効期限は10分。内容変更、対象状態の変化、権限変更、アプリ再起動で失効する。

### 6.3 実行前の検証

文字列の前方一致だけで許可ルートを判定しない。実体パス・ボリューム・ファイルID・親ディレクトリを確認し、`..`、UNC、デバイスパス、代替データストリーム、末尾ドット／空白、大小文字別名、ジャンクション／symlinkによる逸脱を拒否する。

承認後の差し替えに備え、実行直前にもファイルの識別・サイズ・更新日時・SHA-256を照合する。ハッシュは整理対象候補に対してバックグラウンドで計算し、承認可能になる前に確定する。リンク数が複数のファイルは初期版で除外する。移動元／先の親を含めた再解析ポイントの検査を行う。

ハッシュ対象は1ファイル512MiB以下、1計画のファイルサイズ合計2GiB以下、200ファイル以下を初期上限とする。上限超過を一覧に示し、除外して上限内に収めるまでハッシュ計算と承認を開始しない。サイズ合計は候補確定時と実行直前に再確認し、増加・変更時は計画を失効させる。承認前と実行時で合計最大4GiB程度の読取りを要するため、元データサイズと読取り進捗は区別して表示する。復旧・復元でも別フェーズとして同じ上限を適用し、対象変更・上限超過は自動処理せず報告する。

`prepare()`は候補総量・件数を読取り前に検査する。復旧は1回の呼出し全体、復元案生成は1案ごとに、合計2GiB・200回のハッシュ読取り予算を持つ。ネイティブの`stat`で内容を読まずにサイズと識別情報を確認し、予算を予約してから`inspect(maxBytes)`を呼ぶ。stat後の増大もネイティブ側でハッシュ開始前に拒否する。失敗した読取りの予約は返却せず、元・先の双方を検査する場合も共通の予算を消費する。元ファイルの完全一致で未移動と判定できる場合は先をハッシュしない。上限に達した復旧操作は未確定のまま残し、復元候補は理由付きで対象外にする。準備・実行でも走査／承認時のサイズを`maxBytes`として渡す。大容量の境界試験と実負荷の測定は区別して[検証記録](verification.md)へ記録する。

計算はストリーム読取りで行い、読取り済みバイト数、対象件数、停止ボタンを表示する。キャンセルや読取り失敗時は未検証として保持し、移動を開始しない。実行中の検証中断は完了済み操作を記録して後続を停止する。性能はP3で測定し、上限変更は設定値と検証条件を同時に更新する。

`realpath`チェック後の通常のrenameだけでは競合時間差を塞げない。実装したWindows File Adapterは`CreateFile`でルートまでの親と分類先を保持し、再解析ポイントを検査する。移動元は書込み・削除共有を許可せず開いた同じハンドルで識別とSHA-256を照合し、`SetFileInformationByHandle(FileRenameInfo)`の`ReplaceIfExists = FALSE`で移動する。C#ソースをWindows付属の.NET Frameworkコンパイラでx64実行ファイルへビルドする。実NTFSの移動・同名競合・ジャンクション・ハードリンク拒否をテストしているが、未検証条件まで保全を保証しない。受け入れ条件を満たせなければ実ファイル移動を公開しない。

### 6.4 実行・記録・復旧

操作は直列化する。各操作について「実行予定を永続化 → OS操作 → 結果を永続化」の順とする。アプリの重複起動と同時ジョブを防止する。DBトランザクションとファイルシステム操作は一つの原子的処理にはならない。

```text
draft → prepare → ready → 明示承認 → executing → completed / canceled
  ↑                 │                     └→ recovery
  └── 編集・再検証 ─┘
再起動時のready → stale、executing → recovery
recovery → 読取りによる照合 → completed / partial / failed / recovery
recovery → 対象を固定した手動確認 → reviewed
操作単位: pending → intent（永続化）→ done、結果不明時はunresolved
手動確認で終了した未確定操作: unresolved → unverified
```

移動失敗、ファイル状態変更、記録失敗が起きたら後続操作を停止する。キャンセルは進行中の1操作の結果を確定した後に止める。完了済みを勝手に巻き戻さず、結果と復元選択肢を提示する。保存故障は`Organizer.journalFault`に保持し、保存が一時的に回復しても新しい変更を開始しない。`executing / recovery`または操作の`intent / unresolved`が残る場合も全体で変更を拒否する。`recover()`による照合と永続書込み確認が成功した場合にだけ保存故障のラッチを解除する。

クラッシュで結果不明となった項目は、元・先の存在とファイルID・hash・サイズ・更新日時を照合する。元がなく先が一致すれば実行済みとする。元の通常ファイルが完全一致し、先が一致しなければ、同名の別ファイルが先にあっても元は未移動と確定して両方を保持する。検査時にはリンク数1も確認する。両方が一致、どちらにもない、識別が一致しない場合は自動確定しない。同じ操作を自動再実行しない。

手動照合終了は`acknowledgeRecovery(id, revision)`から専用ダイアログで行う。既定はキャンセルで、利用者が元・先を確認して当該記録の終了を明示した場合だけ`Organizer.acknowledge()`を呼ぶ。未確定操作は`unverified`として保持し、成功・失敗確定の件数には混ぜない。計画は`reviewed`、手動確認時刻は`manualReviewedAt`に記録する。未確定操作を再実行せず、復元対象は`done`だけに限定する。実行中や古いrevisionの確認は拒否し、保存故障のラッチはこの操作では解除しない。個別の検証結果は[検証記録](verification.md)を参照する。

復元は成功項目の逆順に別計画を生成して承認する。移動先の内容が変更済み、元のパスが使用済み、ルートの許可が解除済みならスキップして報告する。復元も履歴へ残す。新規作成した空の分類フォルダは初期版では残す。外部アプリによる変更を含む完全なロールバックは保証しない。

## 7. データとAPIの契約

保存先はElectronの`userData`配下とし、実際の絶対パスを設定画面に表示する。現在の配置はDBが`companion.sqlite`、VRM本体が`avatars/<id>.vrm`であり、当初案の`avatars/<id>/model.vrm`から簡素化した。SQLiteは`node:sqlite`を使用し、`records(bucket, id, value)`にJSONレコードを保存する。`journal_mode=WAL`、`synchronous=FULL`、`busy_timeout=3000`、`secure_delete=ON`を設定し、起動時に`quick_check`と`user_version`を確認する。操作ジャーナルは各手順で永続化し、ファイル操作より先に記録する。

| 実装上の型／記録 | 主な項目・設計時との対応 |
| --- | --- |
| Avatar | id, name, version, authors, license, hash, size。管理パスはidから生成 |
| Settings | persona, userName, style, endpoint, model, context, outputTokens, avatarId, scale, fps等。独立したPersona／ModelProfileテーブルは設けない |
| Conversation / Message | Conversationはid, title, rootId, messages。Messageはid, role, content, createdAt, status |
| Pending | id, conversationId, reason, needsTarget。確認待ちはメモリ上の1件 |
| Root | id, path, identity, revoked。identityはボリュームとディレクトリIDをまとめた識別子 |
| Entry / Identity | Entryはid, name, size, category, reason, excluded, identity。Identityはid, size, modified, hash。走査結果はPlan.entriesに保持 |
| Plan | id, rootId, rootIdentity, conversationId, revision, hash, expiresAt, createdAt, status, entries, operations, totalBytes, undoOf, error, manualReviewedAt |
| approvalsバケット | 計画IDをキーとしrevision, hash, consumedAtを記録 |
| Operation | Plan.operations内のid, kind, from, to, identity, state, error。独立したOperationJournalテーブルは設けない |
| journal / recoveryバケット | 復旧後の書込み確認時刻、バックアップ復元警告など |

計画の保存形式の抜粋（識別情報や日時等は省略。完全な型は`src/shared/types.ts`。パスはアプリが生成し、LLMが直接指定しない）:

```json
{
  "id": "6bc85181-5fb0-4daf-823d-88fefb394824",
  "revision": 1,
  "rootId": "a48f2069-f2de-43f4-b3c0-81be30587819",
  "operations": [
    { "id": "9316e165-64af-4a6a-89c6-53df2bf72c97", "kind": "mkdir", "to": "画像", "state": "pending" },
    { "id": "fcf7aa92-40e0-45b0-bfca-15381114453a", "kind": "move",
      "from": "photo.png", "to": "画像/photo.png", "state": "pending" }
  ],
  "status": "ready"
}
```

Panelでは`window.companion`を公開する。設計時の`avatar.* / chat.* / organize.*`という名前空間は、次の平坦なAPIに対応する。

| preloadメソッド | 呼び出し元／意味 |
| --- | --- |
| `state()` / `settings(value, key?)` / `connect()` | 状態取得、検証付き設定保存、接続確認 |
| `importAvatar()` / `selectAvatar(id)` / `deleteAvatar(id)` | VRM選択ダイアログ、登録済みモデルの切替・削除 |
| `send(conversationId, text, mode?)` / `cancel()` | 通常会話、明示した整理依頼の意図判定、検証中断。単一の稼働ジョブを停止 |
| `newConversation()` / `deleteConversation(id)` / `clearHistory()` | 会話の作成・削除 |
| `resolvePending(id)` / `dismissPending()` | 同じ確認待ち依頼の再開・破棄 |
| `selectRoot(conversationId)` / `chooseRoot(conversationId, rootId)` / `revokeRoot(rootId)` | フォルダ選択ダイアログ、登録済み対象の選択、許可解除 |
| `propose(conversationId)` / `editPlan(id, revision, choices)` / `prepare(id)` | 種類別整理案、候補修正、ハッシュを含む再検証 |
| `approve(id, revision, hash)` / `undo(id)` / `recover()` | 明示承認・実行、復元案生成、未確定記録の照合 |
| `acknowledgeRecovery(id, revision)` | 対象を固定した専用ダイアログで手動照合を終了。未確定の操作結果は保持 |
| `deleteJob(id)` | 完了等の記録削除。未解決の復旧記録は削除できない |
| `avatarBytes(id)` / `showAvatar()` / `hideAvatar()` | 許可済みモデルIDによる取得と表示切替。任意パスを受け取らない |
| `openData()` / `backupData()` | 保存先表示とDBバックアップ作成。処理中のバックアップは拒否 |

Avatar側は`window.avatarHost`の`state / bytes / hit / openPanel / drag / report / onUpdate`に限定する。任意のウィンドウ指定や承認APIは公開しない。入力モード変更はMainのトレイメニューに置く。

Panelイベントは`companion:event`上の`update / conversation / plan / remove / clearConversations / delta / progress / error`と、再同期用の`state`である。頻繁な`update`には全会話・全計画を含めず、変更した会話・計画だけ別イベントで送る。全イベントに連番を付け、rendererは欠落を検出すると`state()`で再取得する。初期取得中のイベントを保留し、スナップショットに取り込み済みのdeltaを二重適用しない。パネルの再表示でも全状態を送る。画面通知の失敗は永続化や実行結果と切り離す。Avatarは`avatar:update`のsettings／phase／visibleとモデルロードの世代番号を使う。

通常会話の表示は100メッセージ単位、整理記録は10計画単位。更新中の計画カードだけを差し替える。DBの初期読込み・初期IPCスナップショットは引き続き全件であり、サーバー側のページ取得や履歴の遅延読込みは今後の大規模データ対策として残る。

会話保存無効時は新しい会話の更新をメモリ上だけに保持し、既存の保存履歴を消すには履歴削除を行う。一方、変更操作の復旧ジャーナルは必須であり無効化しない。作業履歴は自動削除せず、削除時は復元できなくなる範囲を表示する。未解決の復旧記録は削除対象にしない。会話・許可・計画・アバターに型付きRepositoryとZod検証を導入し、起動とバックアップ復元前にレコード形状・IDを確認する。不正レコードを黙って削除・補正しない。設定とAPIキー、アバター登録と選択は各々SQLiteトランザクションでまとめる。非同期の設定保存は待機後の最新状態へ編集項目をマージし、表示・選択・位置など専用操作の変更を保持する。保存形式は互換のままで、スキーマ版は`user_version=1`で管理し、既存の旧スキーマを更新する前にはDBバックアップを作成する。新しい未知のスキーマを勝手に開き直さない。

### 7.1 バックアップと破損時の復元

設定画面の`backupData()`はSQLiteの`VACUUM INTO`で、コミット済みWALを含む整合したDBスナップショットを`backups/backup-<時刻>-<UUID>.sqlite`へ作る。バックアップにVRM本体・GGUF・整理対象の実ファイルは含まれず、モデルについては登録メタ情報だけを含む。会話削除時にはアプリ管理下のこの命名規則のバックアップからも該当会話を削除する。利用者が別の場所へ複製したバックアップは管理対象外である。

DB破損や設定読込みエラーで起動できない場合は、「保存先を開く」「バックアップを選んで復元」「終了」を表示する。バックアップ選択後の`Store.restore()`はアプリの通常起動前に行い、ステージングDBの整合性と対応スキーマを検査する。元のDB・WAL・SHMは`damaged-<時刻>-<UUID>/`へ保持し、検証済みDBへ置換して再起動する。無効なバックアップで現存DBを上書きしない。

復元後はフォルダの許可と承認を失効させ、保存時点の確定済み履歴を保持し、照合が必要な計画を復旧対象として提示する。実ファイルを確認して必要な対象を選び直すまで変更を再開しない。バックアップ作成以後の会話や作業記録は戻らず、DB復元はファイル移動の巻き戻しではない。古い記録を根拠に未記録の操作を自動再実行することもない。

## 8. 現在のコード構成

```text
src/
  main/index.ts       # Electron起動、トレイ、ウィンドウ、IPC、会話調停
  main/llama.ts       # 文脈、意図判定、HTTP、SSE
  main/files.ts       # 固定分類、計画、権限、承認、実行、復旧
  main/store.ts       # SQLite、トランザクション、オフライン復元
  main/repositories.ts # 永続レコードの型・検証
  main/settings.ts    # 設定スキーマ、保存時のマージ
  main/maintenance.ts # worker起動・終了・期限管理
  main/maintenance-worker.ts # DB保守、VRM検査
  main/notifications.ts # 通知失敗の隔離
  main/vrm.ts         # GLB／VRM入力検査、メタ情報
  preload/            # panel.ts、avatar.tsの限定API
  renderer/avatar.ts  # Three.js、VRM、入力判定、表情
  renderer/panel.ts   # 会話、設定、整理案・結果、表示ページ
  renderer/state-sync.ts # 通知連番、欠落検出、再同期
  renderer/           # HTML、CSS
  shared/types.ts     # 設定・計画・IPC・イベントの型
native/windows-files/
  Program.cs          # ハンドルによるWindowsファイル操作
  bin/                # ビルド生成物CompanionFiles.exe
scripts/              # ビルド、起動、梱包、検証、LLM導入補助
tests/                # TypeScriptの自動テスト
artifacts/            # テスト専用フィクスチャ・測定結果（Git管理外）
dist/                 # アプリのビルド生成物（Git管理外）
release/              # Windows x64向け梱包結果（Git管理外）
.local/               # 明示導入したLLMランタイム等（Git管理外）
```

当初の`domain/`／`adapters/`分割は上記のMain内モジュールにまとめた。責務はモジュール単位で分離し、独自の汎用エージェント基盤、プラグイン機構、MCP統合は追加していない。`esbuild`でビルドし、`@electron/packager`でWindows x64向けに梱包する。梱包では開発用ソース・テスト・artifacts・.localを除外し、モデルやLLMバイナリをアプリへ取り込まない。

## 9. 主な設計判断

| 判断 | 理由 | 再検討する条件 |
| --- | --- | --- |
| Electronを採用 | 表示・会話・PC統合を短い経路で作る | 実機で常駐負荷や透過の目標を満たせない |
| llama-serverを外部起動 | GPUビルドとモデル配布をアプリから切り離す | セットアップの手間が日常利用を妨げる |
| 1体・テキスト先行 | 音声はMVP対象外という利用者の指定。まず「一緒にいる・話す」を確かめる | MVP後の音声機能追加時 |
| 提案と実行を分離 | モデルの誤りで未承認のファイル変更を起こさない | 分離自体は維持し、自律ルールだけ追加 |
| 任意のユーザー提供VRM | 外見・モデル選定をユーザーに委ね、特定モデルへ依存しない | 対応仕様と上限は互換性検証に応じて更新 |
| LLMは依頼解釈、分類は固定ルール | 処理時間と結果を予測可能にする。本文をLLMへ送らない | 意味に基づく分類が必要になった段階 |
| 直下から固定フォルダへの移動のみ | 対応範囲を縮めつつ承認・記録・復元を維持する | 検証済みの復旧方式で再帰整理等を追加できる |

参照したWeb資料は2026-09-19時点。採用リリース／commit、モデルと資産のhash、依存バージョン、実機条件はlockfile・導入manifest・[検証記録](verification.md)へ記録し、最新版ドキュメントの記述をそのまま固定仕様としない。2時間耐久試験は進行中であり、本書は合格や全要件完了を宣言しない。
