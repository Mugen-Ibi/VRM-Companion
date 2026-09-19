import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { NativeFiles, Organizer, MAX_FILE, MAX_BYTES } from '../src/main/files';
import { Store } from '../src/main/store';
import type { Identity, Plan, Root } from '../src/shared/types';
import { randomUUID } from 'node:crypto';
const base = path.resolve('artifacts/file-tests');
await fs.mkdir(base, { recursive: true });
const native = new NativeFiles(path.resolve('native/windows-files/bin/CompanionFiles.exe'));
async function fixture(fn: (o: Organizer, s: Store, dir: string, rootId: string) => Promise<void>) {
  const dir = await fs.mkdtemp(path.join(base, 'case-'));
  const root = path.join(dir, 'files');
  await fs.mkdir(root);
  const s = new Store(path.join(dir, 'state'));
  const o = new Organizer(
    s,
    native,
    () => {},
    () => {},
  );
  try {
    const r = await o.register(root);
    await fn(o, s, root, r.id);
  } finally {
    s.close();
    assert.ok(path.resolve(dir).startsWith(base + path.sep));
    await fs.rm(dir, { recursive: true, force: true });
  }
}
test('native move, journal, and reverse plan preserve identity and contents', () =>
  fixture(async (o, s, dir, rootId) => {
    await fs.writeFile(path.join(dir, '写真.png'), 'image bytes');
    await fs.writeFile(path.join(dir, 'notes.txt'), 'hello');
    await fs.mkdir(path.join(dir, 'nested'));
    await fs.writeFile(path.join(dir, 'nested', 'keep.txt'), 'keep');
    const p = await o.propose(rootId, randomUUID(), new AbortController().signal);
    assert.equal(
      p.entries.find((e) => e.name === 'nested')?.excluded,
      'サブフォルダは走査しません',
    );
    await o.prepare(p.id, new AbortController().signal);
    const ready = o.get(p.id);
    assert.equal(ready.status, 'ready');
    const result = await o.execute(p.id, ready.revision, ready.hash);
    assert.equal(result.status, 'completed', JSON.stringify(result));
    assert.equal(await fs.readFile(path.join(dir, '画像', '写真.png'), 'utf8'), 'image bytes');
    await assert.rejects(() => o.execute(p.id, ready.revision, ready.hash));
    const undo = await o.undo(p.id, new AbortController().signal);
    assert.equal((await o.execute(undo.id, undo.revision, undo.hash)).status, 'completed');
    assert.equal(await fs.readFile(path.join(dir, 'notes.txt'), 'utf8'), 'hello');
    assert.equal(await fs.readFile(path.join(dir, 'nested', 'keep.txt'), 'utf8'), 'keep');
  }));
test('same-name race is rejected by kernel and existing destination is preserved', () =>
  fixture(async (o, s, dir, rootId) => {
    await fs.mkdir(path.join(dir, '文書'));
    await fs.writeFile(path.join(dir, 'a.txt'), 'source');
    const p = await o.propose(rootId, randomUUID(), new AbortController().signal);
    await o.prepare(p.id, new AbortController().signal);
    const ready = o.get(p.id);
    await fs.writeFile(path.join(dir, '文書', 'a.txt'), 'existing');
    const result = await o.execute(p.id, ready.revision, ready.hash);
    assert.equal(result.status, 'recovery');
    assert.equal(await fs.readFile(path.join(dir, '文書', 'a.txt'), 'utf8'), 'existing');
    assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), 'source');
    await o.recover(new AbortController().signal);
    assert.equal(o.get(p.id).status, 'failed');
    assert.equal(o.get(p.id).operations[0].state, 'failed');
    assert.equal(await fs.readFile(path.join(dir, '文書', 'a.txt'), 'utf8'), 'existing');
    assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), 'source');
  }));
test('known destination collisions are excluded from the approved plan without renaming or overwriting', () =>
  fixture(async (o, s, dir, rootId) => {
    await fs.mkdir(path.join(dir, '文書'));
    await fs.writeFile(path.join(dir, 'a.txt'), 'source');
    await fs.writeFile(path.join(dir, '文書', 'a.txt'), 'keep');
    await fs.writeFile(path.join(dir, 'b.txt'), 'move');
    const p = await o.propose(rootId, randomUUID(), new AbortController().signal);
    await o.prepare(p.id, new AbortController().signal);
    const ready = o.get(p.id);
    assert.equal(ready.entries.find((e) => e.name === 'a.txt')?.category, '変更なし');
    assert.match(ready.entries.find((e) => e.name === 'a.txt')?.excluded ?? '', /同名/);
    assert.equal(ready.totalBytes, 4);
    assert.deepEqual(
      ready.operations.map((op) => op.from),
      ['b.txt'],
    );
    await o.execute(ready.id, ready.revision, ready.hash);
    assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), 'source');
    assert.equal(await fs.readFile(path.join(dir, '文書', 'a.txt'), 'utf8'), 'keep');
    assert.equal(await fs.readFile(path.join(dir, '文書', 'b.txt'), 'utf8'), 'move');
  }));
test('content changes after approval invalidate move, including same size changes', () =>
  fixture(async (o, s, dir, rootId) => {
    await fs.writeFile(path.join(dir, 'a.txt'), 'before');
    const p = await o.propose(rootId, randomUUID(), new AbortController().signal);
    await o.prepare(p.id, new AbortController().signal);
    const ready = o.get(p.id);
    await fs.writeFile(path.join(dir, 'a.txt'), 'after!');
    const result = await o.execute(p.id, ready.revision, ready.hash);
    assert.equal(result.status, 'recovery');
    assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), 'after!');
  }));
test('manual recovery acknowledgement preserves uncertainty, never mutates files and cannot reuse an old revision', () =>
  fixture(async (o, s, dir, rootId) => {
    await fs.writeFile(path.join(dir, 'a.txt'), 'before');
    const p = await o.propose(rootId, randomUUID(), new AbortController().signal);
    await o.prepare(p.id, new AbortController().signal);
    const ready = o.get(p.id);
    await fs.writeFile(path.join(dir, 'a.txt'), 'after!');
    await o.execute(p.id, ready.revision, ready.hash);
    await o.recover(new AbortController().signal);
    const uncertain = o.get(p.id);
    assert.equal(uncertain.status, 'recovery');
    assert.throws(() => o.acknowledge(p.id, uncertain.revision + 1));
    o.acknowledge(p.id, uncertain.revision);
    const reviewed = o.get(p.id);
    assert.equal(reviewed.status, 'reviewed');
    assert.ok(reviewed.manualReviewedAt);
    assert.equal(reviewed.operations.find((op) => op.kind === 'move')?.state, 'unverified');
    assert.equal(await fs.readFile(path.join(dir, 'a.txt'), 'utf8'), 'after!');
    await assert.rejects(() => o.undo(p.id, new AbortController().signal), /復元できる項目/);
    assert.throws(() => o.acknowledge(p.id, uncertain.revision));
    const next = await o.propose(rootId, randomUUID(), new AbortController().signal);
    await o.prepare(next.id, new AbortController().signal);
    const readyNext = o.get(next.id);
    assert.equal(
      (await o.execute(next.id, readyNext.revision, readyNext.hash)).status,
      'completed',
    );
  }));
test('recovery reconciles a move completed before result commit without replay', () =>
  fixture(async (o, s, dir, rootId) => {
    await fs.mkdir(path.join(dir, '文書'));
    await fs.writeFile(path.join(dir, 'a.txt'), 'source');
    const p = await o.propose(rootId, randomUUID(), new AbortController().signal);
    await o.prepare(p.id, new AbortController().signal);
    const ready = o.get(p.id),
      op = ready.operations[0],
      root = o.root(rootId);
    op.state = 'intent';
    ready.status = 'executing';
    o.save(ready);
    await native.run({
      command: 'move',
      root: dir,
      rootIdentity: root.identity,
      from: op.from,
      to: op.to,
      expected: op.identity,
    });
    await o.recover(new AbortController().signal);
    assert.equal(o.get(p.id).status, 'completed');
    assert.equal(o.get(p.id).operations[0].state, 'done');
  }));
test('native adapter refuses traversal and directory junctions', () =>
  fixture(async (o, s, dir, rootId) => {
    const root = o.root(rootId);
    await assert.rejects(() =>
      native.run({
        command: 'inspect',
        root: dir,
        rootIdentity: root.identity,
        from: '../state/companion.sqlite',
      }),
    );
    const outside = path.join(path.dirname(dir), 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(dir, '文書'), 'junction');
    await fs.writeFile(path.join(dir, 'a.txt'), 'source');
    const p = await o.propose(rootId, randomUUID(), new AbortController().signal);
    await assert.rejects(() => o.prepare(p.id, new AbortController().signal));
    assert.equal((await fs.readdir(outside)).length, 0);
  }));
test('plan edits invalidate prior approval; revocation prevents execution', () =>
  fixture(async (o, s, dir, rootId) => {
    await fs.writeFile(path.join(dir, 'a.txt'), 'source');
    const p = await o.propose(rootId, randomUUID(), new AbortController().signal);
    await o.prepare(p.id, new AbortController().signal);
    const ready = o.get(p.id);
    o.edit(p.id, ready.revision, { [p.entries[0].id]: '画像' });
    await assert.rejects(() => o.execute(p.id, ready.revision, ready.hash));
    const root = o.root(rootId);
    root.revoked = true;
    s.put('roots', root.id, root);
    await assert.rejects(() => o.prepare(p.id, new AbortController().signal));
  }));
test('hash byte limits stop preparation before reading oversized files', () =>
  fixture(async (o, s, dir, rootId) => {
    const file = await fs.open(path.join(dir, 'large.mp4'), 'w');
    await file.truncate(MAX_FILE + 1);
    await file.close();
    const p = await o.propose(rootId, randomUUID(), new AbortController().signal);
    await assert.rejects(() => o.prepare(p.id, new AbortController().signal), /512MiB/);
    assert.equal(o.get(p.id).status, 'draft');
  }));
test('protected application paths reject descendants but allow a similarly named sibling', () =>
  fixture(async (o, s, dir) => {
    const guarded = new Organizer(
      s,
      native,
      () => {},
      () => {},
      [dir],
    );
    await assert.rejects(() => guarded.register(path.join(dir, '..', 'files')), /アプリ管理領域/);
    await fs.mkdir(path.join(dir, 'child'));
    await assert.rejects(() => guarded.register(path.join(dir, 'child')), /アプリ管理領域/);
    const sibling = dir + '-other';
    await fs.mkdir(sibling);
    const allowed = await guarded.register(sibling);
    assert.equal(allowed.path, sibling);
  }));

// The stub models a short-name alias with a junction fixture when NTFS has 8.3 creation disabled.
// Production must still reject a junction on the original spelling (tested separately below).
class AliasNative extends NativeFiles {
  calls: Record<string, unknown>[] = [];
  constructor(
    private alias: string,
    private canonical: string,
    private identity: string,
    private confirmedIdentity = identity,
  ) {
    super(native.executable);
  }
  override async run<T>(request: Record<string, unknown>): Promise<T> {
    this.calls.push(request);
    assert.equal(request.command, 'root');
    if (this.calls.length === 1) {
      assert.equal(request.root, this.alias);
      return { path: this.alias, identity: this.identity } as T;
    }
    assert.equal(this.calls.length, 2);
    assert.equal(request.root, this.canonical);
    assert.equal(request.rootIdentity, this.identity);
    return { path: this.canonical, identity: this.confirmedIdentity } as T;
  }
}

test('registration persists the canonical alias path only after confirming the original identity', () =>
  fixture(async (o, s, dir, rootId) => {
    const alias = dir + '-alias',
      canonical = await fs.realpath(dir);
    await fs.symlink(dir, alias, 'junction');
    const stub = new AliasNative(alias, canonical, o.root(rootId).identity),
      organizer = new Organizer(
        s,
        stub,
        () => {},
        () => {},
      );
    const root = await organizer.register(alias);
    assert.equal(root.id, rootId);
    assert.equal(root.path, canonical);
    assert.equal(s.get<Root>('roots', rootId)?.path, canonical);
    assert.equal(stub.calls.length, 2);
  }));

test('canonical resolution blocks a protected folder hidden behind an alias', () =>
  fixture(async (o, s, dir, rootId) => {
    const alias = dir + '-alias',
      canonical = await fs.realpath(dir);
    await fs.symlink(dir, alias, 'junction');
    const before = s.list<Root>('roots'),
      stub = new AliasNative(alias, canonical, o.root(rootId).identity),
      guarded = new Organizer(
        s,
        stub,
        () => {},
        () => {},
        [canonical],
      );
    await assert.rejects(() => guarded.register(alias), /アプリ管理領域/);
    assert.equal(stub.calls.length, 2);
    assert.deepEqual(s.list<Root>('roots'), before);
  }));

test('identity changes during alias resolution cannot reauthorize a revoked root', () =>
  fixture(async (o, s, dir, rootId) => {
    const identity = o.root(rootId).identity,
      alias = dir + '-alias',
      canonical = await fs.realpath(dir);
    await fs.symlink(dir, alias, 'junction');
    o.revoke(rootId);
    const before = s.list<Root>('roots'),
      stub = new AliasNative(alias, canonical, identity, 'different-directory'),
      organizer = new Organizer(
        s,
        stub,
        () => {},
        () => {},
      );
    await assert.rejects(() => organizer.register(alias), /確認中に対象フォルダが変わりました/);
    assert.equal(stub.calls.length, 2);
    assert.deepEqual(s.list<Root>('roots'), before);
    assert.equal(organizer.isRevoked(rootId), true);
  }));

test('registration rejects a junction in the original path before canonical resolution', () =>
  fixture(async (o, s, dir) => {
    const alias = dir + '-alias';
    await fs.symlink(dir, alias, 'junction');
    const before = s.list<Root>('roots');
    await assert.rejects(() => o.register(alias));
    assert.deepEqual(s.list<Root>('roots'), before);
  }));

test('actual Windows short names cannot bypass protected folders', async (t) =>
  fixture(async (o, s, dir) => {
    const folder = path.join(dir, 'protected folder with long name');
    await fs.mkdir(folder);
    const script = `[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition 'using System; using System.Text; using System.Runtime.InteropServices; public class ShortPathFixture { [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern uint GetShortPathName(string path, StringBuilder buffer, uint size); }'
$buffer = New-Object System.Text.StringBuilder 32768
$length = [ShortPathFixture]::GetShortPathName($env:VRM_TEST_SHORT_PATH, $buffer, 32768)
if ($length -eq 0) { throw "GetShortPathName failed" }
[Console]::Write($buffer.ToString())`;
    const { stdout } = await promisify(execFile)(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true,
        timeout: 15000,
        encoding: 'utf8',
        env: { ...process.env, VRM_TEST_SHORT_PATH: folder },
      },
    );
    const alias = stdout.trim(),
      canonical = await fs.realpath(folder);
    if (alias.toLowerCase() === canonical.toLowerCase()) {
      t.skip(
        'NTFS returned the long path; canonical alias and identity-race regressions run with a native stub.',
      );
      return;
    }
    assert.equal(await fs.realpath(alias), canonical);
    const guarded = new Organizer(
        s,
        native,
        () => {},
        () => {},
        [canonical],
      ),
      before = s.list<Root>('roots');
    await assert.rejects(() => guarded.register(alias), /アプリ管理領域/);
    assert.deepEqual(s.list<Root>('roots'), before);
    const allowed = await o.register(alias);
    assert.equal(allowed.path, canonical);
    assert.equal(s.get<Root>('roots', allowed.id)?.path, canonical);
  }));
