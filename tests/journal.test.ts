import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { NativeFiles, Organizer, planHash } from '../src/main/files';
import type { Store } from '../src/main/store';
import type { Identity, Plan, Root } from '../src/shared/types';

class MemoryStore {
  readonly directory = path.resolve('artifacts', 'virtual-journal', randomUUID(), 'state');
  readonly records = new Map<string, unknown>();
  fail?: (bucket: string, id: string, value: unknown) => boolean;
  get<T>(bucket: string, id: string): T | undefined {
    return structuredClone(this.records.get(`${bucket}:${id}`)) as T | undefined;
  }
  list<T>(bucket: string): T[] {
    return [...this.records.entries()]
      .filter(([key]) => key.startsWith(bucket + ':'))
      .map(([, value]) => structuredClone(value) as T);
  }
  put(bucket: string, id: string, value: unknown) {
    if (this.fail?.(bucket, id, value)) throw new Error('simulated journal write failure');
    this.records.set(`${bucket}:${id}`, structuredClone(value));
  }
}
class MemoryNative extends NativeFiles {
  files = new Map<string, Identity>();
  mutations: string[] = [];
  gate?: Promise<void>;
  constructor(readonly root: Root) {
    super(path.resolve('artifacts', 'virtual-journal', 'bin', 'CompanionFiles.exe'));
  }
  override async run<T>(request: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new Error('aborted');
    if (request.command === 'root')
      return { path: this.root.path, identity: this.root.identity } as T;
    const name = request.from as string,
      identity = this.files.get(name);
    if (!identity) throw new Error('missing file');
    if (request.command === 'stat') return { ...identity, hash: undefined } as T;
    if (request.command === 'inspect') return structuredClone(identity) as T;
    assert.equal(request.command, 'move');
    await this.gate;
    assert.deepEqual(request.expected, identity);
    assert.equal(this.files.has(request.to as string), false);
    this.files.delete(name);
    this.files.set(request.to as string, identity);
    this.mutations.push(name);
    return structuredClone(identity) as T;
  }
}
function fixture() {
  const store = new MemoryStore();
  const root: Root = {
    id: randomUUID(),
    path: path.resolve('artifacts', 'virtual-journal', randomUUID(), 'files'),
    identity: 'ROOT',
    revoked: false,
  };
  store.put('roots', root.id, root);
  const native = new MemoryNative(root);
  const createOrganizer = () =>
    new Organizer(
      store as unknown as Store,
      native,
      () => {},
      () => {},
    );
  const organizer = createOrganizer();
  function plan(names: string[]): Plan {
    const plan: Plan = {
      id: randomUUID(),
      rootId: root.id,
      rootIdentity: root.identity,
      conversationId: randomUUID(),
      revision: 1,
      hash: '',
      expiresAt: Date.now() + 600000,
      createdAt: Date.now(),
      status: 'ready',
      entries: [],
      operations: names.map((name) => {
        const identity: Identity = {
          id: randomUUID(),
          size: 1,
          modified: '1',
          hash: 'a'.repeat(64),
        };
        native.files.set(name, identity);
        return {
          id: randomUUID(),
          kind: 'move',
          from: name,
          to: '文書/' + name,
          identity,
          state: 'pending',
        };
      }),
      totalBytes: names.length,
    };
    plan.hash = planHash(plan);
    store.put('plans', plan.id, plan);
    return plan;
  }
  return { store, root, native, organizer, createOrganizer, plan };
}
const signal = () => new AbortController().signal;

test('lost result and recovery writes block all later mutations until durable reconciliation', async () => {
  const f = fixture(),
    first = f.plan(['first.txt']),
    second = f.plan(['second.txt']);
  f.store.fail = (bucket, id, value) =>
    bucket === 'plans' &&
    id === first.id &&
    ['done', 'unresolved'].includes((value as Plan).operations[0].state);
  await assert.rejects(
    () => f.organizer.execute(first.id, first.revision, first.hash),
    /journal write failure/,
  );
  assert.equal(f.organizer.get(first.id).status, 'executing');
  assert.equal(f.organizer.get(first.id).operations[0].state, 'intent');
  assert.deepEqual(f.native.mutations, ['first.txt']);
  assert.ok(f.organizer.journalFault);
  f.store.fail = undefined;
  await assert.rejects(() => f.organizer.execute(second.id, second.revision, second.hash), /復旧/);
  // A restart loses the memory latch, so durable executing/intent must also block.
  await assert.rejects(
    () => f.createOrganizer().execute(second.id, second.revision, second.hash),
    /未確定/,
  );
  assert.deepEqual(f.native.mutations, ['first.txt']);
  await f.organizer.recover(signal());
  assert.equal(f.organizer.get(first.id).status, 'completed');
  assert.equal(f.organizer.journalFault, undefined);
  assert.equal(
    (await f.organizer.execute(second.id, second.revision, second.hash)).status,
    'completed',
  );
  assert.deepEqual(f.native.mutations, ['first.txt', 'second.txt']);
});

test('intent or unresolved operations block changes even if a job status says completed', async () => {
  for (const state of ['intent', 'unresolved'] as const) {
    const f = fixture(),
      old = f.plan(['old.txt']),
      next = f.plan(['next.txt']);
    old.status = 'completed';
    old.operations[0].state = state;
    f.store.put('plans', old.id, old);
    await assert.rejects(() => f.organizer.execute(next.id, next.revision, next.hash), /未確定/);
    assert.deepEqual(f.native.mutations, []);
    await f.organizer.recover(signal());
    assert.equal(f.organizer.get(old.id).status, 'failed');
    assert.equal(
      (await f.organizer.execute(next.id, next.revision, next.hash)).status,
      'completed',
    );
  }
});

test('write failure before intent never starts a move; failed or canceled recovery keeps the latch', async () => {
  const f = fixture(),
    p = f.plan(['a.txt']);
  f.store.fail = () => true;
  await assert.rejects(
    () => f.organizer.execute(p.id, p.revision, p.hash),
    /journal write failure/,
  );
  assert.deepEqual(f.native.mutations, []);
  assert.ok(f.organizer.journalFault);
  f.store.fail = undefined;
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(() => f.organizer.recover(abort.signal));
  assert.ok(f.organizer.journalFault);
  f.store.fail = (bucket) => bucket === 'journal';
  await assert.rejects(() => f.organizer.recover(signal()), /journal write failure/);
  assert.ok(f.organizer.journalFault);
  f.store.fail = undefined;
  await f.organizer.recover(signal());
  assert.equal(f.organizer.journalFault, undefined);
  assert.equal((await f.organizer.execute(p.id, p.revision, p.hash)).status, 'completed');
});

test('unresolved identity changes retain the journal fault after recovery attempts', async () => {
  const f = fixture(),
    p = f.plan(['a.txt']);
  f.store.fail = () => true;
  await assert.rejects(() => f.organizer.execute(p.id, p.revision, p.hash));
  f.store.fail = undefined;
  p.status = 'executing';
  p.operations[0].state = 'intent';
  f.store.put('plans', p.id, p);
  f.native.files.set('a.txt', { ...p.operations[0].identity!, hash: 'b'.repeat(64) });
  await f.organizer.recover(signal());
  assert.equal(f.organizer.get(p.id).status, 'recovery');
  assert.ok(f.organizer.journalFault);
  assert.deepEqual(f.native.mutations, []);
});

test('revocation survives a failed save and lets only the already active move finish', async () => {
  const f = fixture(),
    p = f.plan(['a.txt', 'b.txt']);
  let release!: () => void;
  f.native.gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const execution = f.organizer.execute(p.id, p.revision, p.hash);
  f.store.fail = (bucket) => bucket === 'roots';
  assert.throws(() => f.organizer.revoke(f.root.id), /journal write failure/);
  assert.equal(f.store.get<Root>('roots', f.root.id)?.revoked, false);
  assert.equal(f.organizer.isRevoked(f.root.id), true);
  assert.throws(() => f.organizer.root(f.root.id), /許可/);
  f.store.fail = undefined;
  release();
  const result = await execution;
  assert.equal(result.status, 'canceled');
  assert.deepEqual(f.native.mutations, ['a.txt']);
  assert.ok(f.native.files.has('b.txt'));
  assert.ok(f.organizer.journalFault);
  await f.organizer.recover(signal());
  assert.equal(f.store.get<Root>('roots', f.root.id)?.revoked, true);
  assert.equal(f.organizer.journalFault, undefined);
  assert.throws(() => f.organizer.root(f.root.id), /許可/);
});

test('reauthorizing after a failed revoke invalidates approvals left on disk', async (t) => {
  const f = fixture(),
    p = f.plan(['a.txt']);
  await fs.mkdir(f.root.path, { recursive: true });
  t.after(async () => {
    const dir = path.dirname(f.root.path),
      base = path.resolve('artifacts', 'virtual-journal');
    assert.equal(path.dirname(dir), base);
    await fs.rm(dir, { recursive: true, force: true });
  });
  f.store.fail = (bucket) => bucket === 'roots';
  assert.throws(() => f.organizer.revoke(f.root.id));
  assert.equal(f.organizer.get(p.id).status, 'ready');
  f.store.fail = undefined;
  await f.organizer.register(f.root.path);
  assert.equal(f.organizer.isRevoked(f.root.id), false);
  assert.equal(f.organizer.get(p.id).status, 'stale');
  assert.equal(f.organizer.get(p.id).hash, '');
  assert.ok(f.organizer.journalFault);
  await f.organizer.recover(signal());
  await assert.rejects(() => f.organizer.execute(p.id, p.revision, p.hash), /失効/);
  assert.deepEqual(f.native.mutations, []);
});
