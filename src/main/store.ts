import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateStoredRecord } from './repositories';
const SCHEMA_VERSION = 1;
export class Store {
  private db: DatabaseSync;
  constructor(readonly directory: string) {
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'companion.sqlite');
    this.db = new DatabaseSync(file);
    try {
      this.db.exec(
        'PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000; PRAGMA secure_delete=ON;',
      );
      const integrity = this.db.prepare('PRAGMA quick_check').get() as Record<string, unknown>;
      if (Object.values(integrity)[0] !== 'ok')
        throw new Error('保存データの整合性を確認できません。データを保持して起動を停止しました。');
      const version = Number(
        (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      );
      if (version > SCHEMA_VERSION)
        throw new Error('新しいバージョンで作られた保存データです。アプリを更新してください。');
      if (
        version < SCHEMA_VERSION &&
        this.db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='records'")
          .get()
      )
        this.backup();
      this.db.exec(
        'CREATE TABLE IF NOT EXISTS records (bucket TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(bucket,id)); PRAGMA user_version=1;',
      );
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  get<T>(bucket: string, id: string): T | undefined {
    const row = this.db
      .prepare('SELECT value FROM records WHERE bucket=? AND id=?')
      .get(bucket, id) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  list<T>(bucket: string): T[] {
    return (
      this.db.prepare('SELECT value FROM records WHERE bucket=? ORDER BY rowid').all(bucket) as {
        value: string;
      }[]
    ).map((row) => JSON.parse(row.value) as T);
  }
  records() {
    return (
      this.db.prepare('SELECT bucket,id,value FROM records').all() as {
        bucket: string;
        id: string;
        value: string;
      }[]
    ).map((row) => ({ ...row, value: JSON.parse(row.value) as unknown }));
  }
  put(bucket: string, id: string, value: unknown) {
    this.db
      .prepare(
        'INSERT INTO records(bucket,id,value) VALUES(?,?,?) ON CONFLICT(bucket,id) DO UPDATE SET value=excluded.value',
      )
      .run(bucket, id, JSON.stringify(value));
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      if (value && typeof (value as { then?: unknown }).then === 'function')
        throw new Error('Database transactions must be synchronous.');
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  removeBackupHistory(id?: string) {
    const directory = path.join(this.directory, 'backups');
    if (!fs.existsSync(directory)) return;
    for (const name of fs
      .readdirSync(directory)
      .filter((name) => /^backup-\d+-[a-f0-9-]+\.sqlite$/.test(name))) {
      const file = path.join(directory, name);
      let snapshot: DatabaseSync | undefined;
      try {
        snapshot = new DatabaseSync(file);
        snapshot.exec('PRAGMA secure_delete=ON;');
        if (id)
          snapshot.prepare("DELETE FROM records WHERE bucket='conversations' AND id=?").run(id);
        else snapshot.prepare("DELETE FROM records WHERE bucket='conversations'").run();
      } catch (error) {
        throw new Error(
          'バックアップ内の会話を削除できません。保存先を確認してください。 ' + String(error),
        );
      } finally {
        snapshot?.close();
      }
    }
  }
  delete(bucket: string, id: string) {
    if (bucket === 'conversations') this.removeBackupHistory(id);
    this.db.prepare('DELETE FROM records WHERE bucket=? AND id=?').run(bucket, id);
  }
  clear(bucket: string) {
    if (bucket === 'conversations') this.removeBackupHistory();
    this.db.prepare('DELETE FROM records WHERE bucket=?').run(bucket);
  }
  // Caller has already completed backup cleanup in a worker while holding the task lock.
  deleteConversationRecord(id?: string) {
    if (id) this.db.prepare("DELETE FROM records WHERE bucket='conversations' AND id=?").run(id);
    else this.db.prepare("DELETE FROM records WHERE bucket='conversations'").run();
  }
  backup() {
    const directory = path.join(this.directory, 'backups');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, `backup-${Date.now()}-${randomUUID()}.sqlite`);
    // SQLite takes a consistent snapshot, including committed WAL pages.
    try {
      this.db.prepare('VACUUM INTO ?').run(file);
    } catch (error) {
      fs.rmSync(file, { force: true });
      throw error;
    }
    return file;
  }
  /** Offline recovery: keep damaged files, revoke roots and invalidate every restored approval. */
  static restore(directory: string, snapshot: string) {
    const staging = path.join(directory, `restore-${randomUUID()}.sqlite`),
      archive = path.join(directory, `damaged-${Date.now()}-${randomUUID()}`);
    fs.copyFileSync(snapshot, staging, fs.constants.COPYFILE_EXCL);
    let recovery: DatabaseSync | undefined;
    try {
      recovery = new DatabaseSync(staging);
      const integrity = recovery.prepare('PRAGMA quick_check').get() as Record<string, unknown>;
      if (
        Object.values(integrity)[0] !== 'ok' ||
        (recovery.prepare('PRAGMA user_version').get() as { user_version: number }).user_version !==
          SCHEMA_VERSION
      )
        throw new Error('対応する正常なバックアップではありません。');
      const rows = recovery.prepare('SELECT bucket,id,value FROM records').all() as {
        bucket: string;
        id: string;
        value: string;
      }[];
      const put = recovery.prepare('UPDATE records SET value=? WHERE bucket=? AND id=?');
      recovery.exec('BEGIN IMMEDIATE;');
      for (const row of rows) {
        const value = JSON.parse(row.value);
        validateStoredRecord(row.bucket, row.id, value);
        if (row.bucket === 'roots') {
          value.revoked = true;
          put.run(JSON.stringify(value), row.bucket, row.id);
        }
        if (row.bucket === 'plans') {
          if (!Array.isArray(value.operations)) throw new Error('計画の記録が不正です。');
          const settled =
            ['completed', 'partial', 'canceled', 'failed', 'reviewed'].includes(value.status) &&
            value.operations.every(
              (op: { state: string }) => !['intent', 'unresolved'].includes(op.state),
            );
          if (!settled) {
            for (const op of value.operations) op.state = 'unresolved';
            value.status = value.operations.length ? 'recovery' : 'stale';
            value.error = 'バックアップ復元後の照合が必要です。';
          }
          value.hash = '';
          value.expiresAt = 0;
          put.run(JSON.stringify(value), row.bucket, row.id);
        }
      }
      recovery.prepare("DELETE FROM records WHERE bucket='approvals'").run();
      recovery
        .prepare("INSERT OR REPLACE INTO records(bucket,id,value) VALUES('recovery','restored',?)")
        .run(
          JSON.stringify({
            at: Date.now(),
            warning:
              'バックアップを復元しました。保存時点以後の記録は含まれません。整理対象の実ファイルを確認し、必要なフォルダを選び直して作業記録を照合してください。',
          }),
        );
      recovery.exec('COMMIT; PRAGMA wal_checkpoint(TRUNCATE);');
      recovery.close();
      recovery = undefined;
      fs.mkdirSync(archive);
      const moved: string[] = [];
      try {
        for (const name of ['companion.sqlite', 'companion.sqlite-wal', 'companion.sqlite-shm'])
          if (fs.existsSync(path.join(directory, name))) {
            fs.renameSync(path.join(directory, name), path.join(archive, name));
            moved.push(name);
          }
        fs.renameSync(staging, path.join(directory, 'companion.sqlite'));
      } catch (error) {
        for (const name of moved.reverse())
          fs.renameSync(path.join(archive, name), path.join(directory, name));
        throw error;
      }
      return archive;
    } finally {
      recovery?.close();
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(staging + suffix, { force: true });
    }
  }
  close() {
    this.db.close();
  }
}
