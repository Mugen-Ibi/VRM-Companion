# Security policy

## Reporting a vulnerability

公開Issueには、未修正の脆弱性、個人データ、認証情報、再現用の機密ファイルを投稿しないでください。GitHubリポジトリの **Security** → **Report a vulnerability** からPrivate vulnerability reportを送ってください。

報告には影響する版、再現条件、想定される影響、可能なら最小限の再現手順を含めてください。受領確認と公開時期は、影響と修正準備を確認してから連絡します。

## Distribution trust

公開用Windowsバイナリはコード署名を必須とします。署名証明書が用意されるまで、プロジェクトの梱包処理は公開用の未署名ビルドを拒否します。`COMPANION_ALLOW_UNSIGNED=1` は開発者自身のローカル検証だけに使用し、その成果物を配布しないでください。

利用者が選択する `llama-server.exe` はSHA-256で固定します。公式リリースのmanifestと照合できないファイルは、ハッシュを示した警告に利用者が明示同意した場合だけ実行します。ファイルが変更された場合は再選択が必要です。

## Local data

設定、会話、許可、計画、操作記録、アプリ内バックアップは、Windowsアカウントで保護した鍵により暗号化します。バックアップは同じWindowsアカウントでの復旧用です。VRM、GGUF、整理対象ファイルはデータベースの暗号化対象外です。
