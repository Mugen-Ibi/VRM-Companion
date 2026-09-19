import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import {
  MAX_BYTES,
  MAX_COUNT,
  MAX_FILE,
  NativeFiles,
  Organizer,
  planHash,
} from '../src/main/files';
import type { Store } from '../src/main/store';
import type { Identity, Plan, Root } from '../src/shared/types';

class MemoryStore {
  readonly directory = path.resolve('artifacts', 'virtual-budget', randomUUID(), 'state');
  records = new Map<string, unknown>();
  get<T>(bucket: string, id: string) {
    return structuredClone(this.records.get(bucket + ':' + id)) as T | undefined;
  }
  list<T>(bucket: string) {
    return [...this.records]
      .filter(([key]) => key.startsWith(bucket + ':'))
      .map(([, value]) => structuredClone(value) as T);
  }
  put(bucket: string, id: string, value: unknown) {
    this.records.set(bucket + ':' + id, structuredClone(value));
  }
}
class BudgetNative extends NativeFiles {
  files = new Map<string, Identity>();
  attempts: { from: string; maxBytes: number }[] = [];
  reads: { from: string; bytes: number }[] = [];
  onInspect?: (from: string) => void;
  constructor() {
    super(path.resolve('native/windows-files/bin/CompanionFiles.exe'));
  }
  override async run<T>(request: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const from = String(request.from);
    if (request.command === 'stat') {
      const value = this.files.get(from);
      if (!value) throw new Error('missing file');
      return { ...value, hash: undefined } as T;
    }
    assert.equal(request.command, 'inspect');
    const maxBytes = request.maxBytes as number;
    assert.ok(Number.isSafeInteger(maxBytes));
    this.attempts.push({ from, maxBytes });
    this.onInspect?.(from);
    const value = this.files.get(from);
    if (!value) throw new Error('missing file');
    if (value.size > maxBytes || value.size > MAX_FILE)
      throw new Error('事前確認後にファイルが増大し、読取り予算を超えました。');
    this.reads.push({ from, bytes: value.size });
    return structuredClone(value) as T;
  }
}
const signal = () => new AbortController().signal;
function fixture() {
  const store = new MemoryStore(),
    native = new BudgetNative();
  const root: Root = {
    id: randomUUID(),
    path: path.resolve('artifacts', 'virtual-budget', randomUUID(), 'files'),
    identity: 'ROOT',
    revoked: false,
  };
  store.put('roots', root.id, root);
  const organizer = new Organizer(
    store as unknown as Store,
    native,
    () => {},
    () => {},
  );
  function plan(sizes: number[], status: 'recovery' | 'completed' = 'recovery') {
    const id = randomUUID();
    const plan: Plan = {
      id,
      rootId: root.id,
      rootIdentity: root.identity,
      conversationId: randomUUID(),
      revision: 1,
      hash: '',
      expiresAt: 0,
      createdAt: Date.now(),
      status,
      entries: [],
      operations: sizes.map((size, i) => {
        const from = `${id}-${i}.txt`,
          to = '文書/' + from,
          identity: Identity = { id: randomUUID(), size, modified: '1', hash: 'a'.repeat(64) };
        native.files.set(status === 'completed' ? to : from, identity);
        return {
          id: randomUUID(),
          kind: 'move',
          from,
          to,
          identity,
          state: status === 'completed' ? 'done' : 'unresolved',
        };
      }),
      totalBytes: sizes.reduce((n, size) => n + size, 0),
    };
    plan.hash = planHash(plan);
    store.put('plans', id, plan);
    return plan;
  }
  return { store, native, organizer, root, plan };
}

test('recovery reserves exactly 2GiB across plans, leaves excess unresolved, and can continue later', async () => {
  const f = fixture(),
    plans = Array.from({ length: 5 }, () => f.plan([MAX_FILE]));
  await f.organizer.recover(signal());
  assert.equal(
    f.native.reads.reduce((n, read) => n + read.bytes, 0),
    MAX_BYTES,
  );
  assert.equal(f.native.attempts.length, 4);
  assert.deepEqual(
    f.native.attempts.map((a) => a.maxBytes),
    Array(4).fill(MAX_FILE),
  );
  for (const p of plans.slice(0, 4)) assert.equal(f.organizer.get(p.id).status, 'failed');
  const remaining = f.organizer.get(plans[4].id);
  assert.equal(remaining.status, 'recovery');
  assert.equal(remaining.operations[0].state, 'unresolved');
  assert.match(remaining.operations[0].error!, /2GiB/);
  await f.organizer.recover(signal());
  assert.equal(f.organizer.get(remaining.id).status, 'failed');
  assert.equal(f.native.attempts.length, 5);
});

test('matching original identities settle without ever hashing the destination', async () => {
  const f = fixture(),
    p = f.plan([1, 0]);
  for (const op of p.operations)
    f.native.files.set(op.to, { ...op.identity!, id: randomUUID(), size: MAX_FILE });
  await f.organizer.recover(signal());
  assert.equal(f.organizer.get(p.id).status, 'failed');
  assert.deepEqual(
    f.native.attempts.map((a) => a.from),
    p.operations.map((op) => op.from),
  );
  assert.equal(
    f.native.reads.reduce((n, read) => n + read.bytes, 0),
    1,
  );
});

test('source and destination attempts share the 200-file budget, including interrupted reads', async () => {
  const f = fixture(),
    p = f.plan(Array(101).fill(1));
  f.native.onInspect = (from) => {
    if (from.includes('/')) return;
    const value = f.native.files.get(from)!;
    f.native.files.delete(from);
    f.native.files.set('文書/' + from, value);
    throw new Error('file moved after metadata check');
  };
  await f.organizer.recover(signal());
  assert.equal(f.native.attempts.length, MAX_COUNT);
  assert.equal(f.native.reads.length, 100);
  const result = f.organizer.get(p.id);
  assert.equal(result.status, 'recovery');
  assert.equal(result.operations.filter((op) => op.state === 'done').length, 100);
  assert.equal(result.operations[100].state, 'unresolved');
  assert.match(result.operations[100].error!, /200ファイル/);
  await f.organizer.recover(signal());
  assert.equal(f.organizer.get(p.id).status, 'completed');
  assert.equal(f.native.attempts.length, 202);
});

test('an interrupted source hash keeps its byte reservation when the destination is inspected', async () => {
  const f = fixture(),
    p = f.plan(Array(4).fill(MAX_FILE));
  f.native.onInspect = (from) => {
    if (from.includes('/')) return;
    const identity = f.native.files.get(from)!;
    f.native.files.delete(from);
    f.native.files.set('文書/' + from, identity);
    throw new Error('hash result lost after an unknown amount of reading');
  };
  await f.organizer.recover(signal());
  assert.equal(
    f.native.attempts.reduce((n, attempt) => n + attempt.maxBytes, 0),
    MAX_BYTES,
  );
  assert.equal(f.native.attempts.length, 4);
  assert.equal(f.native.reads.length, 2);
  const result = f.organizer.get(p.id);
  assert.equal(result.status, 'recovery');
  assert.deepEqual(
    result.operations.map((op) => op.state),
    ['done', 'done', 'unresolved', 'unresolved'],
  );
});

test('oversized and changed metadata are rejected before content reads during recovery', async () => {
  const f = fixture(),
    oversized = f.plan([MAX_FILE + 1]),
    changed = f.plan([1]);
  const op = changed.operations[0];
  f.native.files.set(op.from!, { ...op.identity!, size: MAX_FILE });
  await f.organizer.recover(signal());
  assert.deepEqual(f.native.attempts, []);
  assert.equal(f.organizer.get(oversized.id).status, 'recovery');
  assert.match(f.organizer.get(oversized.id).operations[0].error!, /512MiB/);
  assert.equal(f.organizer.get(changed.id).status, 'recovery');
});

test('recovery passes the reserved size to inspect and never completes a file grown after stat', async () => {
  const f = fixture(),
    p = f.plan([1]);
  f.native.onInspect = (from) =>
    f.native.files.set(from, { ...f.native.files.get(from)!, size: 2 });
  await f.organizer.recover(signal());
  assert.equal(f.native.attempts[0].maxBytes, 1);
  assert.deepEqual(f.native.reads, []);
  assert.equal(f.organizer.get(p.id).status, 'recovery');
});

test('undo excludes excess bytes and files before hashing and admits exact boundaries', async () => {
  const bytes = fixture(),
    original = bytes.plan(Array(5).fill(MAX_FILE), 'completed');
  const undo = await bytes.organizer.undo(original.id, signal());
  assert.equal(undo.totalBytes, MAX_BYTES);
  assert.equal(undo.operations.length, 4);
  assert.equal(bytes.native.attempts.length, 4);
  assert.equal(undo.entries.filter((e) => e.excluded).length, 1);
  assert.match(undo.entries.find((e) => e.excluded)!.reason, /2GiB/);
  const files = fixture(),
    many = files.plan(Array(201).fill(0), 'completed');
  const bounded = await files.organizer.undo(many.id, signal());
  assert.equal(bounded.operations.length, MAX_COUNT);
  assert.equal(files.native.attempts.length, MAX_COUNT);
  assert.equal(bounded.totalBytes, 0);
  assert.match(bounded.entries.find((e) => e.excluded)!.reason, /200ファイル/);
});

test('undo reads neither oversized nor metadata-changed files and reports rejected growth', async () => {
  const large = fixture(),
    p = large.plan([MAX_FILE + 1], 'completed');
  await assert.rejects(() => large.organizer.undo(p.id, signal()), /512MiB/);
  assert.deepEqual(large.native.attempts, []);
  const changed = fixture(),
    original = changed.plan([1], 'completed'),
    op = original.operations[0];
  changed.native.files.set(op.to, { ...op.identity!, size: 2 });
  await assert.rejects(() => changed.organizer.undo(original.id, signal()), /ファイルが変更/);
  assert.deepEqual(changed.native.attempts, []);
  const growth = fixture(),
    grow = growth.plan([1], 'completed');
  growth.native.onInspect = (from) =>
    growth.native.files.set(from, { ...growth.native.files.get(from)!, size: 2 });
  await assert.rejects(() => growth.organizer.undo(grow.id, signal()), /読取り予算/);
  assert.equal(growth.native.attempts[0].maxBytes, 1);
  assert.deepEqual(growth.native.reads, []);
});

test('real native stat reads metadata only and inspect/move enforce reserved size before hashing', async () => {
  const base = path.resolve('artifacts/recovery-budget-tests');
  await fs.mkdir(base, { recursive: true });
  const directory = await fs.mkdtemp(path.join(base, 'case-'));
  try {
    const native = new NativeFiles(path.resolve('native/windows-files/bin/CompanionFiles.exe'));
    const root = await native.run<{ identity: string }>({ command: 'root', root: directory });
    const payload = Buffer.alloc(8 * 1024 * 1024, 0x5a),
      file = path.join(directory, 'a.txt');
    await fs.writeFile(file, payload);
    const request = { root: directory, rootIdentity: root.identity, from: 'a.txt' };
    let progress = 0;
    const stat = await native.run<Identity>({ ...request, command: 'stat' }, undefined, () => {
      progress++;
    });
    assert.equal(stat.size, payload.length);
    assert.ok(!stat.hash);
    assert.equal(progress, 0);
    await fs.appendFile(file, '!');
    await assert.rejects(
      () =>
        native.run({ ...request, command: 'inspect', maxBytes: stat.size }, undefined, () => {
          progress++;
        }),
      /読取り予算/,
    );
    assert.equal(progress, 0);
    await fs.mkdir(path.join(directory, '文書'));
    await assert.rejects(
      () =>
        native.run(
          {
            ...request,
            command: 'move',
            to: '文書/a.txt',
            maxBytes: stat.size,
            expected: { ...stat, hash: createHash('sha256').update(payload).digest('hex') },
          },
          undefined,
          () => {
            progress++;
          },
        ),
      /読取り予算/,
    );
    assert.equal(progress, 0);
    await assert.rejects(() => fs.lstat(path.join(directory, '文書', 'a.txt')), { code: 'ENOENT' });
    const inspected = await native.run<Identity>({
      ...request,
      command: 'inspect',
      maxBytes: stat.size + 1,
    });
    assert.equal(inspected.hash, createHash('sha256').update(payload).update('!').digest('hex'));
  } finally {
    const absolute = path.resolve(directory);
    assert.ok(absolute.startsWith(base + path.sep));
    await fs.rm(absolute, { recursive: true, force: true });
  }
});
