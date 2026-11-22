# dumpproof

[English](README.md) · [Português](README.pt-BR.md) · 日本語

一度も復元したことのないバックアップは、ただの推測です。**dumpproof** はネットワークを切った使い捨てコンテナにバックアップを復元し、全テーブルの行数を数えて、本当に使えるかを教えます。終わったらコンテナは削除します。

```bash
npx @guihakka2/dumpproof backup.sql.gz                    # PostgreSQL / MySQL ダンプ（Docker が必要）
npx @guihakka2/dumpproof db.dump --require users,orders   # pg_dump -Fc、これらのテーブルに行が必要
npx @guihakka2/dumpproof app.sqlite                       # SQLite：整合性チェックと行数（Docker 不要）
npx @guihakka2/dumpproof volume-backup.tar.gz             # Docker ボリュームのアーカイブを最後まで検証
```

- **PostgreSQL**（プレーン SQL / `-Fc`）と **MySQL/MariaDB**：`postgres:17-alpine` / `mysql:8.4` に復元（`--image` で変更可）
- **SQLite**：`PRAGMA integrity_check` と行数、読み取り専用（Node 22.13+）
- **tar / tar.gz**：各ヘッダーのチェックサム、サイズ、gzip の末尾まで、危険なパス（`../`）を確認
- 所有者エラー（`role "app" does not exist`）は別サーバーへの復元では想定内なので数えて無視。それ以外のエラーは失敗

セキュリティ：`--network none` のコンテナ、ランダムなパスワード、終了時（Ctrl+C でも）必ず削除。行データは表示せず、テーブル名と行数のみ。詳細は [SECURITY.md](SECURITY.md)。
