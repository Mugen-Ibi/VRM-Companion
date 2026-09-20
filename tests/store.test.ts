import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/main/store';
import { DEFAULTS } from '../src/shared/types';
function fixture() {
  const directory = path.resolve('artifacts/store-tests', randomUUID());
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}
const protection = {
  protect: (key: Buffer) => 'test:' + key.toString('base64'),
  unprotect: (wrapped: string) => Buffer.from(wrapped.replace(/^test:/, ''), 'base64'),
};
test('protected stores migrate existing records and backups without leaving plaintext values', () => {
  const directory = fixture(),
    conversationId = randomUUID();
  let store = new Store(directory);
  store.put('settings', 'main', DEFAULTS);
  store.put('conversations', conversationId, {
    id: conversationId,
    title: 'private title',
    messages: [
      {
        id: randomUUID(),
        role: 'user',
        content: 'private message',
        createdAt: 1,
      },
    ],
  });
  const legacyBackup = store.backup();
  store.close();

  store = new Store(directory, { protection });
  try {
    assert.equal(
      store.get<{ messages: { content: string }[] }>('conversations', conversationId)!.messages[0]
        .content,
      'private message',
    );
    for (const file of [path.join(directory, 'companion.sqlite'), legacyBackup]) {
      const db = new DatabaseSync(file, { readOnly: true });
      const values = db.prepare('SELECT value FROM records').all() as { value: string }[];
      assert.ok(values.length > 0);
      assert.ok(values.every((row) => row.value.startsWith('enc:v1:')));
      assert.ok(values.every((row) => !row.value.includes('private')));
      assert.equal(
        (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        2,
      );
      db.close();
    }
    const snapshot = store.backup();
    store.close();
    fs.writeFileSync(path.join(directory, 'companion.sqlite'), 'damaged');
    Store.restore(directory, snapshot, protection);
    store = new Store(directory, { protection });
    assert.equal(
      store.get<{ title: string }>('conversations', conversationId)!.title,
      'private title',
    );
  } finally {
    store.close();
  }
});
test('backup includes committed WAL data and conversation deletion also updates snapshots', () => {
  const directory = fixture(),
    store = new Store(directory);
  try {
    store.put('conversations', 'one', { text: 'private one' });
    store.put('conversations', 'two', { text: 'private two' });
    store.put('plans', 'job', { status: 'completed' });
    const snapshot = store.backup();
    let db = new DatabaseSync(snapshot, { readOnly: true });
    assert.equal(
      db.prepare("SELECT count(*) n FROM records WHERE bucket='conversations'").get()!.n,
      2,
    );
    db.close();
    store.delete('conversations', 'one');
    db = new DatabaseSync(snapshot, { readOnly: true });
    assert.equal(
      db.prepare("SELECT count(*) n FROM records WHERE bucket='conversations'").get()!.n,
      1,
    );
    db.close();
    store.clear('conversations');
    db = new DatabaseSync(snapshot, { readOnly: true });
    assert.equal(
      db.prepare("SELECT count(*) n FROM records WHERE bucket='conversations'").get()!.n,
      0,
    );
    assert.equal(db.prepare("SELECT count(*) n FROM records WHERE bucket='plans'").get()!.n, 1);
    db.close();
  } finally {
    store.close();
  }
});
test('offline restore archives damaged DB, revokes roots and reconciles every recorded operation', () => {
  const directory = fixture(),
    store = new Store(directory);
  const rootId = randomUUID(),
    planId = randomUUID(),
    settledId = randomUUID();
  store.put('roots', rootId, {
    id: rootId,
    path: directory,
    identity: 'root-identity',
    revoked: false,
  });
  const move = {
    id: randomUUID(),
    kind: 'move',
    from: 'a.txt',
    to: '文書/a.txt',
    identity: { id: 'file', size: 1, modified: '1', hash: 'a'.repeat(64) },
    state: 'pending',
  };
  const plan = {
    id: planId,
    rootId,
    rootIdentity: 'root-identity',
    conversationId: randomUUID(),
    revision: 1,
    hash: 'a'.repeat(64),
    expiresAt: Date.now() + 10000,
    createdAt: 1,
    status: 'ready',
    entries: [],
    operations: [move, { id: randomUUID(), kind: 'mkdir', to: '文書', state: 'done' }],
    totalBytes: 1,
  };
  store.put('plans', planId, plan);
  store.put('plans', settledId, {
    ...plan,
    id: settledId,
    status: 'completed',
    operations: [{ ...move, state: 'done' }],
  });
  store.put('approvals', planId, { consumedAt: 0 });
  const snapshot = store.backup();
  store.close();
  const damaged = Buffer.from('not a database');
  fs.writeFileSync(path.join(directory, 'companion.sqlite'), damaged);
  assert.throws(() => new Store(directory));
  assert.deepEqual(fs.readFileSync(path.join(directory, 'companion.sqlite')), damaged);
  const archive = Store.restore(directory, snapshot);
  assert.deepEqual(fs.readFileSync(path.join(archive, 'companion.sqlite')), damaged);
  const restored = new Store(directory);
  try {
    assert.equal(restored.get<{ revoked: boolean }>('roots', rootId)!.revoked, true);
    const plan = restored.get<{ status: string; hash: string; operations: { state: string }[] }>(
      'plans',
      planId,
    )!;
    assert.equal(plan.status, 'recovery');
    assert.equal(plan.hash, '');
    assert.ok(plan.operations.every((op) => op.state === 'unresolved'));
    assert.deepEqual(restored.list('approvals'), []);
    assert.ok(restored.get('recovery', 'restored'));
    assert.equal(restored.get<{ status: string }>('plans', settledId)!.status, 'completed');
  } finally {
    restored.close();
  }
});
test('invalid restore snapshot does not replace existing data and future schema is refused', () => {
  const directory = fixture(),
    store = new Store(directory);
  store.put('settings', 'x', { kept: true });
  store.close();
  const original = fs.readFileSync(path.join(directory, 'companion.sqlite')),
    bad = path.join(directory, 'bad.sqlite');
  fs.writeFileSync(bad, 'broken');
  assert.throws(() => Store.restore(directory, bad));
  assert.deepEqual(fs.readFileSync(path.join(directory, 'companion.sqlite')), original);
  const db = new DatabaseSync(path.join(directory, 'companion.sqlite'));
  db.exec('PRAGMA user_version=999');
  db.close();
  assert.throws(() => new Store(directory), /新しいバージョン/);
});

test('a SQLite-valid snapshot with malformed records cannot replace the current database', () => {
  const directory = fixture(),
    store = new Store(directory);
  store.put('conversations', 'invalid-id', { messages: 'not an array' });
  const bad = store.backup();
  store.delete('conversations', 'invalid-id');
  // Keep the intentionally malformed snapshot independent of conversation cleanup.
  const db = new DatabaseSync(bad);
  db.prepare('INSERT INTO records VALUES(?,?,?)').run(
    'conversations',
    'invalid-id',
    JSON.stringify({ messages: 'not an array' }),
  );
  db.close();
  store.close();
  const file = path.join(directory, 'companion.sqlite'),
    before = fs.readFileSync(file);
  assert.throws(() => Store.restore(directory, bad), /保存データの形式/);
  assert.deepEqual(fs.readFileSync(file), before);
});
