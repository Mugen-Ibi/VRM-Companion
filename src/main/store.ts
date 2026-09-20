import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { validateStoredRecord } from './repositories';
const SCHEMA_VERSION = 2;
const ENCRYPTED = 'enc:v1:';

export type DataProtection = {
  protect(key: Buffer): string;
  unprotect(wrapped: string): Buffer;
};
type StoreOptions = { protection?: DataProtection; dataKey?: Uint8Array };

function aad(bucket: string, id: string) {
  return Buffer.from(bucket + '\0' + id, 'utf8');
}
function seal(value: string, bucket: string, id: string, key: Buffer) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(aad(bucket, id));
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return ENCRYPTED + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}
function open(value: string, bucket: string, id: string, key?: Buffer) {
  if (!value.startsWith(ENCRYPTED)) return value;
  if (!key) throw new Error('暗号化された保存データを開く鍵がありません。');
  const payload = Buffer.from(value.slice(ENCRYPTED.length), 'base64');
  if (payload.length < 29) throw new Error('暗号化された保存データが壊れています。');
  const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0, 12));
  decipher.setAAD(aad(bucket, id));
  decipher.setAuthTag(payload.subarray(12, 28));
  try {
    return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString(
      'utf8',
    );
  } catch {
    throw new Error(`保存データを復号できません（${bucket}/${id}）。`);
  }
}
function migrateDatabase(db: DatabaseSync, key: Buffer, wrapped: string) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT OR REPLACE INTO metadata(name,value) VALUES(?,?)').run(
      'wrapped_data_key',
      wrapped,
    );
    const rows = db.prepare('SELECT bucket,id,value FROM records').all() as {
      bucket: string;
      id: string;
      value: string;
    }[];
    const update = db.prepare('UPDATE records SET value=? WHERE bucket=? AND id=?');
    for (const row of rows)
      update.run(
        seal(open(row.value, row.bucket, row.id, key), row.bucket, row.id, key),
        row.bucket,
        row.id,
      );
    db.exec(`PRAGMA user_version=${SCHEMA_VERSION}; COMMIT;`);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;');
}
export class Store {
  private db: DatabaseSync;
  private key?: Buffer;
  private wrappedKey?: string;
  constructor(
    readonly directory: string,
    options: StoreOptions = {},
  ) {
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
      let version = Number(
        (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      );
      if (version > SCHEMA_VERSION)
        throw new Error('新しいバージョンで作られた保存データです。アプリを更新してください。');
      this.db.exec(
        'CREATE TABLE IF NOT EXISTS records (bucket TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(bucket,id)); CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);',
      );
      const wrapped = this.db
        .prepare("SELECT value FROM metadata WHERE name='wrapped_data_key'")
        .get() as { value: string } | undefined;
      if (options.dataKey) {
        this.key = Buffer.from(options.dataKey);
        if (this.key.length !== 32) throw new Error('保存データの暗号鍵が不正です。');
        if (version !== SCHEMA_VERSION)
          throw new Error('暗号化前の保存データをworkerから開くことはできません。');
      } else if (options.protection) {
        if (wrapped) {
          this.key = options.protection.unprotect(wrapped.value);
          this.wrappedKey = wrapped.value;
        } else {
          if (version === SCHEMA_VERSION)
            throw new Error('保存データの暗号鍵が見つかりません。原本を保持してください。');
          this.key = randomBytes(32);
          this.wrappedKey = options.protection.protect(this.key);
        }
        if (this.key.length !== 32) throw new Error('保存データの暗号鍵が不正です。');
        if (version < SCHEMA_VERSION) {
          migrateDatabase(this.db, this.key, this.wrappedKey!);
          version = SCHEMA_VERSION;
        }
        this.migrateBackups();
      } else if (version === 0) {
        this.db.exec('PRAGMA user_version=1;');
        version = 1;
      } else if (version === SCHEMA_VERSION && wrapped) {
        throw new Error('暗号化された保存データを開く保護機構がありません。');
      }
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  get<T>(bucket: string, id: string): T | undefined {
    const row = this.db
      .prepare('SELECT value FROM records WHERE bucket=? AND id=?')
      .get(bucket, id) as { value: string } | undefined;
    return row ? (JSON.parse(open(row.value, bucket, id, this.key)) as T) : undefined;
  }
  list<T>(bucket: string): T[] {
    return (
      this.db.prepare('SELECT id,value FROM records WHERE bucket=? ORDER BY rowid').all(bucket) as {
        id: string;
        value: string;
      }[]
    ).map((row) => JSON.parse(open(row.value, bucket, row.id, this.key)) as T);
  }
  records() {
    return (
      this.db.prepare('SELECT bucket,id,value FROM records').all() as {
        bucket: string;
        id: string;
        value: string;
      }[]
    ).map((row) => ({
      ...row,
      value: JSON.parse(open(row.value, row.bucket, row.id, this.key)) as unknown,
    }));
  }
  put(bucket: string, id: string, value: unknown) {
    this.db
      .prepare(
        'INSERT INTO records(bucket,id,value) VALUES(?,?,?) ON CONFLICT(bucket,id) DO UPDATE SET value=excluded.value',
      )
      .run(
        bucket,
        id,
        this.key ? seal(JSON.stringify(value), bucket, id, this.key) : JSON.stringify(value),
      );
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
  exportDataKey() {
    if (!this.key) return undefined;
    return new Uint8Array(this.key);
  }
  private migrateBackups() {
    if (!this.key || !this.wrappedKey) return;
    const directory = path.join(this.directory, 'backups');
    if (!fs.existsSync(directory)) return;
    for (const name of fs
      .readdirSync(directory)
      .filter((entry) => /^backup-\d+-[a-f0-9-]+\.sqlite$/.test(entry))) {
      const file = path.join(directory, name),
        snapshot = new DatabaseSync(file);
      try {
        const version = Number(
          (snapshot.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        );
        if (version > SCHEMA_VERSION)
          throw new Error(`新しい形式のバックアップを移行できません（${name}）。`);
        snapshot.exec(
          'PRAGMA secure_delete=ON; CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);',
        );
        if (version < SCHEMA_VERSION) migrateDatabase(snapshot, this.key, this.wrappedKey);
      } finally {
        snapshot.close();
      }
    }
  }
  /** Offline recovery: keep damaged files, revoke roots and invalidate every restored approval. */
  static restore(directory: string, snapshot: string, protection?: DataProtection) {
    const staging = path.join(directory, `restore-${randomUUID()}.sqlite`),
      archive = path.join(directory, `damaged-${Date.now()}-${randomUUID()}`);
    fs.copyFileSync(snapshot, staging, fs.constants.COPYFILE_EXCL);
    let recovery: DatabaseSync | undefined;
    try {
      recovery = new DatabaseSync(staging);
      const integrity = recovery.prepare('PRAGMA quick_check').get() as Record<string, unknown>;
      const storedVersion = Number(
        (recovery.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      );
      if (
        Object.values(integrity)[0] !== 'ok' ||
        storedVersion < 1 ||
        storedVersion > SCHEMA_VERSION
      )
        throw new Error('対応する正常なバックアップではありません。');
      recovery.exec(
        'CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);',
      );
      let version = storedVersion,
        key: Buffer | undefined;
      const wrapped = recovery
        .prepare("SELECT value FROM metadata WHERE name='wrapped_data_key'")
        .get() as { value: string } | undefined;
      if (version === SCHEMA_VERSION) {
        if (!protection || !wrapped)
          throw new Error('暗号化バックアップをこのWindowsアカウントで復号できません。');
        key = protection.unprotect(wrapped.value);
      } else if (protection) {
        key = randomBytes(32);
        const protectedKey = protection.protect(key);
        migrateDatabase(recovery, key, protectedKey);
        version = SCHEMA_VERSION;
      }
      const rows = recovery.prepare('SELECT bucket,id,value FROM records').all() as {
        bucket: string;
        id: string;
        value: string;
      }[];
      const put = recovery.prepare('UPDATE records SET value=? WHERE bucket=? AND id=?');
      recovery.exec('BEGIN IMMEDIATE;');
      for (const row of rows) {
        const value = JSON.parse(open(row.value, row.bucket, row.id, key));
        validateStoredRecord(row.bucket, row.id, value);
        if (row.bucket === 'roots') {
          value.revoked = true;
          put.run(
            key ? seal(JSON.stringify(value), row.bucket, row.id, key) : JSON.stringify(value),
            row.bucket,
            row.id,
          );
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
          put.run(
            key ? seal(JSON.stringify(value), row.bucket, row.id, key) : JSON.stringify(value),
            row.bucket,
            row.id,
          );
        }
      }
      recovery.prepare("DELETE FROM records WHERE bucket='approvals'").run();
      recovery
        .prepare("INSERT OR REPLACE INTO records(bucket,id,value) VALUES('recovery','restored',?)")
        .run(
          key
            ? seal(
                JSON.stringify({
                  at: Date.now(),
                  warning:
                    'バックアップを復元しました。保存時点以後の記録は含まれません。整理対象の実ファイルを確認し、必要なフォルダを選び直して作業記録を照合してください。',
                }),
                'recovery',
                'restored',
                key,
              )
            : JSON.stringify({
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
    this.key?.fill(0);
    this.key = undefined;
  }
}
