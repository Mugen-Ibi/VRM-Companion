import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { NativeFiles, Organizer } from '../src/main/files';
import { Store } from '../src/main/store';

const base = path.resolve('artifacts/file-boundary-tests');
await fs.mkdir(base, { recursive: true });
const executable = path.resolve('native/windows-files/bin/CompanionFiles.exe');
const signal = () => new AbortController().signal;
class ObservedNative extends NativeFiles {
  onStart?: (request: Record<string, unknown>) => void;
  override run<T>(
    request: Record<string, unknown>,
    abort?: AbortSignal,
    progress?: (done: number, total: number) => void,
  ): Promise<T> {
    const result = super.run<T>(request, abort, progress);
    this.onStart?.(request);
    return result;
  }
}
type Fixture = {
  organizer: Organizer;
  store: Store;
  native: ObservedNative;
  dir: string;
  rootId: string;
  onProgress?: (text: string, done: number, total: number) => void;
};
async function fixture(fn: (f: Fixture) => Promise<void>) {
  const work = await fs.mkdtemp(path.join(base, 'case-')),
    dir = path.join(work, 'files');
  await fs.mkdir(dir);
  const store = new Store(path.join(work, 'state')),
    native = new ObservedNative(executable);
  const f: Fixture = { store, native, dir, rootId: '', organizer: undefined! };
  f.organizer = new Organizer(
    store,
    native,
    (text, done, total) => f.onProgress?.(text, done, total),
    () => {},
  );
  try {
    f.rootId = (await f.organizer.register(dir)).id;
    await fn(f);
  } finally {
    store.close();
    const absolute = path.resolve(work);
    assert.ok(absolute.startsWith(base + path.sep), 'only this test fixture may be removed');
    await fs.rm(absolute, { recursive: true, force: true });
  }
}
async function ready(f: Fixture) {
  const p = await f.organizer.propose(f.rootId, randomUUID(), signal());
  await f.organizer.prepare(p.id, signal());
  return f.organizer.get(p.id);
}
async function missing(file: string) {
  await assert.rejects(() => fs.lstat(file), { code: 'ENOENT' });
}

test('NTFS hardlinks are excluded from scan and rejected by native inspection', () =>
  fixture(async (f) => {
    const original = path.join(f.dir, 'original.txt'),
      alias = path.join(f.dir, 'alias.txt');
    await fs.writeFile(original, 'keep linked data');
    await fs.link(original, alias);
    assert.equal((await fs.stat(original)).nlink, 2);
    const p = await f.organizer.propose(f.rootId, randomUUID(), signal());
    assert.equal(p.entries.length, 2);
    assert.ok(p.entries.every((e) => e.excluded?.includes('リンク') && e.category === '変更なし'));
    const root = f.organizer.root(f.rootId);
    await assert.rejects(
      () =>
        f.native.run({
          command: 'inspect',
          root: f.dir,
          rootIdentity: root.identity,
          from: 'original.txt',
        }),
      /リンク/,
    );
    await assert.rejects(() => f.organizer.prepare(p.id, signal()), /移動対象がありません/);
    assert.equal(await fs.readFile(original, 'utf8'), 'keep linked data');
    assert.equal(await fs.readFile(alias, 'utf8'), 'keep linked data');
    await missing(path.join(f.dir, '文書'));
  }));

test('a hardlink created after approval blocks the real native move', () =>
  fixture(async (f) => {
    await fs.mkdir(path.join(f.dir, '文書'));
    await fs.writeFile(path.join(f.dir, 'a.txt'), 'approved data');
    const p = await ready(f);
    await fs.link(path.join(f.dir, 'a.txt'), path.join(f.dir, 'alias.txt'));
    const result = await f.organizer.execute(p.id, p.revision, p.hash);
    assert.equal(result.status, 'recovery');
    assert.equal(result.operations[0].state, 'unresolved');
    assert.match(result.operations[0].error!, /リンク/);
    assert.equal(await fs.readFile(path.join(f.dir, 'a.txt'), 'utf8'), 'approved data');
    assert.equal(await fs.readFile(path.join(f.dir, 'alias.txt'), 'utf8'), 'approved data');
    await missing(path.join(f.dir, '文書', 'a.txt'));
  }));

test('expired approval starts neither category creation nor a file move', () =>
  fixture(async (f) => {
    await fs.writeFile(path.join(f.dir, 'a.txt'), 'unchanged');
    const p = await ready(f);
    p.expiresAt = Date.now() - 1;
    f.organizer.save(p);
    const mutations: unknown[] = [];
    f.native.onStart = (request) => {
      if (['mkdir', 'move'].includes(String(request.command))) mutations.push(request);
    };
    await assert.rejects(() => f.organizer.execute(p.id, p.revision, p.hash), /失効/);
    assert.deepEqual(mutations, []);
    assert.equal(await fs.readFile(path.join(f.dir, 'a.txt'), 'utf8'), 'unchanged');
    await missing(path.join(f.dir, '文書'));
    assert.equal(f.store.get('approvals', p.id), undefined);
  }));

test('cancel during a real native move commits the active move and never starts the next', () =>
  fixture(async (f) => {
    await fs.mkdir(path.join(f.dir, '文書'));
    for (const name of ['a.txt', 'b.txt', 'c.txt'])
      await fs.writeFile(path.join(f.dir, name), 'contents of ' + name);
    const p = await ready(f);
    assert.ok(p.operations.every((op) => op.kind === 'move'));
    const started: string[] = [];
    f.native.onStart = (request) => {
      if (request.command !== 'move') return;
      started.push(String(request.from));
      // NativeFiles.run has spawned its child; this is an in-flight cancellation.
      f.organizer.canceled = true;
    };
    const result = await f.organizer.execute(p.id, p.revision, p.hash);
    assert.equal(result.status, 'canceled');
    assert.deepEqual(started, [p.operations[0].from]);
    assert.deepEqual(
      result.operations.map((op) => op.state),
      ['done', 'pending', 'pending'],
    );
    for (let i = 0; i < p.operations.length; i++) {
      const op = p.operations[i],
        present = path.join(f.dir, i === 0 ? op.to : op.from!);
      assert.equal(await fs.readFile(present, 'utf8'), 'contents of ' + op.from);
      await missing(path.join(f.dir, i === 0 ? op.from! : op.to));
    }
    const undo = await f.organizer.undo(p.id, signal());
    assert.equal(undo.operations.length, 1);
  }));

test('undo excludes occupied original paths and changed contents while restoring safe files', () =>
  fixture(async (f) => {
    for (const name of ['occupied.txt', 'changed.txt', 'safe.txt'])
      await fs.writeFile(path.join(f.dir, name), 'original');
    const p = await ready(f);
    assert.equal((await f.organizer.execute(p.id, p.revision, p.hash)).status, 'completed');
    await fs.writeFile(path.join(f.dir, 'occupied.txt'), 'new file at original path');
    await fs.writeFile(path.join(f.dir, '文書', 'changed.txt'), 'modified'); // Same byte count.
    const undo = await f.organizer.undo(p.id, signal());
    assert.deepEqual(
      undo.operations.map((op) => op.from),
      ['文書/safe.txt'],
    );
    assert.match(
      undo.entries.find((e) => e.name === '文書/occupied.txt')!.excluded!,
      /元のパスが使用/,
    );
    assert.match(
      undo.entries.find((e) => e.name === '文書/changed.txt')!.excluded!,
      /ファイルが変更/,
    );
    assert.equal(
      (await f.organizer.execute(undo.id, undo.revision, undo.hash)).status,
      'completed',
    );
    assert.equal(
      await fs.readFile(path.join(f.dir, 'occupied.txt'), 'utf8'),
      'new file at original path',
    );
    assert.equal(await fs.readFile(path.join(f.dir, '文書', 'occupied.txt'), 'utf8'), 'original');
    assert.equal(await fs.readFile(path.join(f.dir, '文書', 'changed.txt'), 'utf8'), 'modified');
    assert.equal(await fs.readFile(path.join(f.dir, 'safe.txt'), 'utf8'), 'original');
    await missing(path.join(f.dir, 'changed.txt'));
  }));

test('a restore destination occupied after its preview is preserved by the kernel', () =>
  fixture(async (f) => {
    await fs.writeFile(path.join(f.dir, 'a.txt'), 'original');
    const p = await ready(f);
    await f.organizer.execute(p.id, p.revision, p.hash);
    const undo = await f.organizer.undo(p.id, signal());
    await fs.writeFile(path.join(f.dir, 'a.txt'), 'new occupant');
    const result = await f.organizer.execute(undo.id, undo.revision, undo.hash);
    assert.equal(result.status, 'recovery');
    await f.organizer.recover(signal());
    assert.equal(f.organizer.get(undo.id).status, 'failed');
    assert.equal(await fs.readFile(path.join(f.dir, 'a.txt'), 'utf8'), 'new occupant');
    assert.equal(await fs.readFile(path.join(f.dir, '文書', 'a.txt'), 'utf8'), 'original');
  }));

test('abort from real hash progress discards preparation and invalidates prior approval', () =>
  fixture(async (f) => {
    const payload = Buffer.alloc(16 * 1024 * 1024, 0x5a),
      file = path.join(f.dir, 'hash.txt');
    await fs.writeFile(file, payload);
    const p = await ready(f);
    const abort = new AbortController();
    let progressBytes = 0;
    f.onProgress = (text, done) => {
      if (text === '変更前の状態を検証しています' && done > 0) {
        progressBytes = done;
        abort.abort();
      }
    };
    await assert.rejects(() => f.organizer.prepare(p.id, abort.signal), /中断/);
    assert.ok(progressBytes > 0);
    assert.ok(progressBytes <= payload.length);
    const canceled = f.organizer.get(p.id);
    assert.equal(canceled.status, 'draft');
    assert.equal(canceled.hash, '');
    assert.deepEqual(canceled.operations, []);
    await assert.rejects(() => f.organizer.execute(p.id, p.revision, p.hash), /失効/);
    assert.ok((await fs.readFile(file)).equals(payload));
    await missing(path.join(f.dir, '文書'));
    // The aborted child must also have released its Windows file handles.
    const renamed = path.join(f.dir, 'released.txt');
    await fs.rename(file, renamed);
    await fs.rename(renamed, file);
  }));
