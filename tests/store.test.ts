import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/main/store';
function fixture() {
  const directory = path.resolve('artifacts/store-tests', randomUUID());
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}
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
  store.put('roots', 'root', { id: 'root', revoked: false });
  store.put('plans', 'plan', {
    operations: [
      { kind: 'move', state: 'pending' },
      { kind: 'mkdir', state: 'done' },
    ],
    status: 'ready',
    hash: 'approved',
    expiresAt: Date.now() + 10000,
  });
  store.put('plans', 'settled', {
    operations: [{ kind: 'move', state: 'done' }],
    status: 'completed',
  });
  store.put('approvals', 'plan', { consumedAt: 0 });
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
    assert.equal(restored.get<{ revoked: boolean }>('roots', 'root')!.revoked, true);
    const plan = restored.get<{ status: string; hash: string; operations: { state: string }[] }>(
      'plans',
      'plan',
    )!;
    assert.equal(plan.status, 'recovery');
    assert.equal(plan.hash, '');
    assert.ok(plan.operations.every((op) => op.state === 'unresolved'));
    assert.deepEqual(restored.list('approvals'), []);
    assert.ok(restored.get('recovery', 'restored'));
    assert.equal(restored.get<{ status: string }>('plans', 'settled')!.status, 'completed');
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
