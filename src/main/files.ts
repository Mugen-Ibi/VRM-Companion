import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import {
  CATEGORIES,
  type Category,
  type Entry,
  type Identity,
  type Plan,
  type Root,
} from '../shared/types';
import { Store } from './store';
export const MAX_FILE = 512 * 1024 ** 2,
  MAX_BYTES = 2 * 1024 ** 3,
  MAX_COUNT = 200;
type HashBudget = { bytes: number; files: number };
class HashBudgetError extends Error {}
const rules: Record<string, Category> = {};
for (const [category, extensions] of Object.entries({
  画像: 'png jpg jpeg gif webp bmp tiff tif avif heic svg',
  文書: 'pdf txt md csv json doc docx xls xlsx ppt pptx odt ods rtf',
  動画: 'mp4 mkv mov avi webm m4v',
  音声: 'mp3 wav flac ogg m4a aac opus',
  圧縮ファイル: 'zip 7z rar tar gz bz2 xz',
}))
  for (const ext of extensions.split(' ')) rules[ext] = category as Category;
export function classify(name: string): Category {
  return rules[path.extname(name).slice(1).toLowerCase()] ?? '変更なし';
}
export function validName(name: string) {
  return (
    name.length > 0 &&
    name !== '.' &&
    name !== '..' &&
    !/[<>:"/\\|?*\x00-\x1f]/.test(name) &&
    !/[. ]$/.test(name) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)
  );
}
export function planHash(plan: Plan) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        id: plan.id,
        revision: plan.revision,
        rootId: plan.rootId,
        rootIdentity: plan.rootIdentity,
        operations: plan.operations,
        totalBytes: plan.totalBytes,
        undoOf: plan.undoOf,
        ruleVersion: 1,
      }),
    )
    .digest('hex');
}
export class NativeFiles {
  constructor(readonly executable: string) {}
  run<T>(
    request: Record<string, unknown>,
    signal?: AbortSignal,
    progress?: (done: number, total: number) => void,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('中断しました。'));
      const child = spawn(this.executable, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let result: { ok: boolean; value: T; error?: string } | undefined,
        settled = false;
      const abort = () => child.kill();
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(() => child.kill(), 180_000);
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        error ? reject(error) : resolve(result!.value);
      };
      createInterface({ input: child.stdout }).on('line', (line) => {
        try {
          const data = JSON.parse(line.replace(/^\uFEFF/, ''));
          if (data.progress) progress?.(data.done, data.total);
          else result = data;
        } catch {
          child.kill();
        }
      });
      child.stderr.resume();
      child.on('error', () =>
        finish(new Error('Windowsファイルアダプターを起動できません。ビルドを確認してください。')),
      );
      child.on('close', () =>
        finish(
          signal?.aborted
            ? new Error('中断しました。')
            : !result?.ok
              ? new Error(
                  result?.error || 'ファイル処理が中断されました。記録から復旧してください。',
                )
              : undefined,
        ),
      );
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(request) + '\n');
    });
  }
}
export class Organizer {
  canceled = false;
  private fault: string | undefined;
  private executing = false;
  private revokedRoots = new Set<string>();
  constructor(
    private store: Store,
    private native: NativeFiles,
    private progress: (text: string, done: number, total: number) => void,
    private changed: () => void,
    private protectedPaths: readonly string[] = [],
  ) {}
  get journalFault() {
    return this.fault;
  }
  isRevoked(id: string) {
    return this.revokedRoots.has(id) || !!this.store.get<Root>('roots', id)?.revoked;
  }
  private write(bucket: string, id: string, value: unknown) {
    try {
      this.store.put(bucket, id, value);
    } catch (error) {
      this.canceled = true;
      this.fault = '作業記録を保存できません。復旧が完了するまでファイルの変更を停止します。';
      throw error;
    }
  }
  private unconfirmed(plan: Plan) {
    return (
      ['executing', 'recovery'].includes(plan.status) ||
      plan.operations.some((op) => ['intent', 'unresolved'].includes(op.state))
    );
  }
  private assertUnprotected(
    folder: string,
    protectedPaths = [
      this.store.directory,
      path.dirname(this.native.executable),
      ...this.protectedPaths,
    ],
  ) {
    const candidate = path.resolve(folder).toLowerCase();
    for (const blocked of protectedPaths) {
      const relative = path.relative(path.resolve(blocked).toLowerCase(), candidate);
      if (
        !relative ||
        (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
      )
        throw new Error('アプリ管理領域は選択できません。');
    }
  }
  root(id: string) {
    const root = this.store.get<Root>('roots', id);
    if (!root || root.revoked || this.revokedRoots.has(id))
      throw new Error('対象フォルダの許可がありません。');
    this.assertUnprotected(root.path);
    return root;
  }
  private invalidatePlans(rootId: string) {
    for (const plan of this.store.list<Plan>('plans'))
      if (plan.rootId === rootId && ['draft', 'ready', 'stale'].includes(plan.status)) {
        plan.status = 'stale';
        plan.hash = '';
        this.save(plan);
      }
  }
  private persistRevocation(id: string) {
    const root = this.store.get<Root>('roots', id);
    if (!root) throw new Error('対象フォルダが見つかりません。');
    root.revoked = true;
    this.write('roots', id, root);
    this.invalidatePlans(id);
  }
  revoke(id: string) {
    // Stop and remove in-process authority before any fallible persistence work.
    this.canceled = true;
    this.revokedRoots.add(id);
    this.persistRevocation(id);
    this.changed();
  }
  private request(root: Root, command: string, extra: Record<string, unknown> = {}) {
    return { command, root: root.path, rootIdentity: root.identity, ...extra };
  }
  private async inspectWithinBudget(
    root: Root,
    from: string,
    expected: Identity | undefined,
    budget: HashBudget,
    signal: AbortSignal,
    label: string,
  ) {
    const metadata = await this.native.run<Identity>(this.request(root, 'stat', { from }), signal);
    if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > MAX_FILE)
      throw new HashBudgetError('1ファイル512MiBの読取り上限を超えています。');
    // A changed identity/size/time cannot match the approved file, so do not read its contents.
    if (
      !expected?.hash ||
      metadata.id !== expected.id ||
      metadata.size !== expected.size ||
      metadata.modified !== expected.modified
    )
      return { ...metadata, hash: undefined };
    if (budget.files >= MAX_COUNT || budget.bytes + metadata.size > MAX_BYTES)
      throw new HashBudgetError('今回の照合の読取り上限（合計2GiB・200ファイル）に達しました。');
    const before = budget.bytes;
    budget.bytes += metadata.size;
    budget.files++;
    // Reserve before starting the child and never refund failed/partial reads.
    const identity = await this.native.run<Identity>(
      this.request(root, 'inspect', { from, maxBytes: metadata.size }),
      signal,
      (done) => this.progress(label, before + done, budget.bytes),
    );
    this.progress(label, budget.bytes, budget.bytes);
    return identity;
  }
  async register(folder: string): Promise<Root> {
    // Application-owned state and source directories are never organization targets.
    this.assertUnprotected(folder);
    // Check the original spelling before resolving it, so aliases through reparse points stay forbidden.
    const checked = await this.native.run<{ path: string; identity: string }>({
      command: 'root',
      root: folder,
    });
    const canonical = await fs.realpath(checked.path);
    const confirmed = await this.native.run<{ path: string; identity: string }>({
      command: 'root',
      root: canonical,
      rootIdentity: checked.identity,
    });
    if (confirmed.identity !== checked.identity)
      throw new Error('確認中に対象フォルダが変わりました。もう一度選択してください。');
    const protectedPaths = await Promise.all(
      [this.store.directory, path.dirname(this.native.executable), ...this.protectedPaths].map(
        async (blocked) => {
          try {
            return await fs.realpath(blocked);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            return path.resolve(blocked);
          }
        },
      ),
    );
    this.assertUnprotected(canonical, protectedPaths);
    const existing = this.store.list<Root>('roots').find((r) => r.identity === checked.identity);
    const root = existing ?? {
      id: randomUUID(),
      path: canonical,
      identity: checked.identity,
      revoked: false,
    };
    // Reauthorization never revives a plan whose revocation failed to reach disk.
    if (root.revoked || this.revokedRoots.has(root.id)) this.invalidatePlans(root.id);
    root.path = canonical;
    root.revoked = false;
    this.write('roots', root.id, root);
    this.revokedRoots.delete(root.id);
    return root;
  }
  save(plan: Plan) {
    this.write('plans', plan.id, plan);
    this.changed();
  }
  get(id: string) {
    const plan = this.store.get<Plan>('plans', id);
    if (!plan) throw new Error('計画が見つかりません。');
    return plan;
  }
  async propose(rootId: string, conversationId: string, signal: AbortSignal) {
    const root = this.root(rootId);
    this.progress('直下のファイルを確認しています', 0, 0);
    const scanned = await this.native.run<
      { name: string; size: number; identity?: Identity; excluded?: string }[]
    >(this.request(root, 'scan'), signal);
    const plan: Plan = {
      id: randomUUID(),
      rootId,
      rootIdentity: root.identity,
      conversationId,
      revision: 1,
      hash: '',
      expiresAt: 0,
      createdAt: Date.now(),
      status: 'draft',
      entries: scanned.map((e) => ({
        ...e,
        id: randomUUID(),
        category: e.excluded ? '変更なし' : classify(e.name),
        reason:
          e.excluded ||
          (classify(e.name) === '変更なし'
            ? '未対応の拡張子'
            : `拡張子 ${path.extname(e.name).toLowerCase()}`),
      })),
      operations: [],
      totalBytes: 0,
    };
    this.save(plan);
    return plan;
  }
  edit(id: string, revision: number, choices: Record<string, Category>) {
    const p = this.get(id);
    if (!['draft', 'ready', 'stale'].includes(p.status) || p.revision !== revision || p.undoOf)
      throw new Error('計画が更新されています。再表示してください。');
    for (const [id, category] of Object.entries(choices)) {
      const entry = p.entries.find((e) => e.id === id);
      if (!entry || !CATEGORIES.includes(category) || entry.excluded)
        throw new Error('無効な変更です。');
      entry.category = category;
    }
    p.revision++;
    p.status = 'draft';
    p.hash = '';
    p.operations = [];
    p.error = undefined;
    this.save(p);
  }
  async prepare(id: string, signal: AbortSignal) {
    const p = this.get(id),
      root = this.root(p.rootId);
    if (!['draft', 'ready', 'stale'].includes(p.status) || p.undoOf)
      throw new Error('この計画は再検証できません。');
    p.status = 'draft';
    p.hash = '';
    p.operations = [];
    p.error = undefined;
    const chosen = p.entries.filter((e) => !e.excluded && e.category !== '変更なし');
    p.totalBytes = chosen.reduce((n, e) => n + e.size, 0);
    this.save(p);
    if (!chosen.length) throw new Error('移動対象がありません。カテゴリを選択してください。');
    if (
      chosen.length > MAX_COUNT ||
      p.totalBytes > MAX_BYTES ||
      chosen.some((e) => e.size > MAX_FILE)
    )
      throw new Error('上限は200件・合計2GiB・1ファイル512MiBです。対象を減らしてください。');
    const folders = new Set<string>();
    let bytes = 0;
    try {
      for (const e of chosen) {
        if (signal.aborted) throw new Error('中断しました。');
        const dest = `${e.category}/${e.name}`;
        if (!validName(e.name)) throw new Error('非対応の名前です。');
        const occupied = await fs.lstat(path.join(root.path, dest)).then(
          () => true,
          (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return false;
            throw error;
          },
        );
        if (occupied) {
          e.reason = e.excluded = '移動先に同名があるため対象外';
          e.category = '変更なし';
          p.totalBytes -= e.size;
          continue;
        }
        if (!folders.has(e.category)) {
          try {
            await this.native.run(this.request(root, 'directory', { to: e.category }), signal);
          } catch (error) {
            const exists = await fs.lstat(path.join(root.path, e.category)).then(
              () => true,
              (err: NodeJS.ErrnoException) => {
                if (err.code === 'ENOENT') return false;
                throw err;
              },
            );
            if (exists) throw error;
            p.operations.push({
              id: randomUUID(),
              kind: 'mkdir',
              to: e.category,
              state: 'pending',
            });
          }
          folders.add(e.category);
        }
        const identity = await this.native.run<Identity>(
          this.request(root, 'inspect', { from: e.name, maxBytes: e.size }),
          signal,
          (done) => this.progress('変更前の状態を検証しています', bytes + done, p.totalBytes),
        );
        if (
          identity.id !== e.identity?.id ||
          identity.size !== e.size ||
          identity.modified !== e.identity.modified
        )
          throw new Error('一覧取得後にファイルが変わりました。再走査してください。');
        e.identity = identity;
        p.operations.push({
          id: randomUUID(),
          kind: 'move',
          from: e.name,
          to: dest,
          identity,
          state: 'pending',
        });
        bytes += identity.size;
        this.progress('変更前の状態を検証しています', bytes, p.totalBytes);
      }
      if (!p.operations.some((op) => op.kind === 'move'))
        throw new Error('競合のない移動対象がありません。既存ファイルを保持しました。');
      p.status = 'ready';
      p.revision++;
      p.expiresAt = Date.now() + 600_000;
      p.hash = planHash(p);
      this.save(p);
    } catch (error) {
      p.error = (error as Error).message;
      p.operations = [];
      this.save(p);
      throw error;
    }
  }
  async execute(id: string, revision: number, hash: string) {
    if (this.fault) throw new Error(this.fault);
    if (this.executing || this.store.list<Plan>('plans').some((p) => this.unconfirmed(p)))
      throw new Error('先に未確定の作業を復旧してください。');
    const p = this.get(id),
      root = this.root(p.rootId);
    if (
      p.status !== 'ready' ||
      p.revision !== revision ||
      p.hash !== hash ||
      planHash(p) !== hash ||
      p.expiresAt < Date.now()
    )
      throw new Error('承認対象が変更・失効しています。再検証してください。');
    this.executing = true;
    try {
      this.canceled = false;
      p.status = 'executing';
      this.write('approvals', p.id, { revision, hash, consumedAt: Date.now() });
      this.save(p);
      for (const op of p.operations) {
        if (this.canceled) {
          p.status = 'canceled';
          break;
        }
        try {
          this.root(root.id);
          op.state = 'intent';
          this.save(p); // Durable write-ahead record, before every mutation.
          this.progress(
            op.kind === 'move'
              ? '承認されたファイルを移動しています'
              : '分類フォルダを作成しています',
            p.operations.filter((o) => o.state === 'done').length,
            p.operations.length,
          );
          if (op.kind === 'mkdir')
            await this.native.run(this.request(root, 'mkdir', { to: op.to }));
          else
            await this.native.run(
              this.request(root, 'move', {
                from: op.from,
                to: op.to,
                expected: op.identity,
                maxBytes: op.identity?.size,
              }),
            );
          op.state = 'done';
          this.save(p);
        } catch (error) {
          // The operation may have reached the kernel before the child/DB failed. Never assume failure.
          op.state = 'unresolved';
          op.error = (error as Error).message;
          p.status = 'recovery';
          p.error = '操作結果の照合が必要です。';
          this.save(p);
          break;
        }
      }
      if (p.status === 'executing') p.status = 'completed';
      this.save(p);
      return p;
    } finally {
      this.executing = false;
    }
  }
  async recover(signal: AbortSignal) {
    if (this.executing) throw new Error('実行中の操作が終わってから復旧してください。');
    if (signal.aborted) throw new Error('中断しました。');
    for (const id of this.revokedRoots) this.persistRevocation(id);
    const budget: HashBudget = { bytes: 0, files: 0 };
    for (const p of this.store.list<Plan>('plans').filter((p) => this.unconfirmed(p))) {
      const root = this.root(p.rootId);
      let unresolved = false;
      for (const op of p.operations.filter((o) => ['intent', 'unresolved'].includes(o.state))) {
        if (signal.aborted) throw new Error('中断しました。');
        if (op.kind === 'mkdir') {
          // Creation provenance cannot be recovered from a directory that already existed.
          try {
            await this.native.run(this.request(root, 'directory', { to: op.to }), signal);
            op.state = 'done';
            op.error = 'フォルダの存在を確認（作成元は未確定・削除対象外）';
          } catch (error) {
            if (signal.aborted) throw error;
            const exists = await fs.lstat(path.join(root.path, op.to)).then(
              () => true,
              (e: NodeJS.ErrnoException) => e.code !== 'ENOENT',
            );
            op.state = exists ? 'unresolved' : 'failed';
            unresolved ||= exists;
          }
          continue;
        }
        const inspect = async (rel: string) => {
          try {
            return {
              value: await this.inspectWithinBudget(
                root,
                rel,
                op.identity,
                budget,
                signal,
                '復旧の状態を検証しています',
              ),
              missing: false,
              error: undefined,
            };
          } catch (error) {
            if (signal.aborted) throw error;
            return {
              value: undefined,
              missing:
                error instanceof HashBudgetError
                  ? false
                  : await fs.lstat(path.join(root.path, rel)).then(
                      () => false,
                      (e: NodeJS.ErrnoException) => e.code === 'ENOENT',
                    ),
              error: (error as Error).message,
            };
          }
        };
        const a = await inspect(op.from!);
        const match = (v?: Identity) =>
          !!v &&
          !!op.identity?.hash &&
          v.id === op.identity.id &&
          v.hash === op.identity.hash &&
          v.size === op.identity.size &&
          v.modified === op.identity.modified;
        // inspect accepts only a regular file with one link. A matching source
        // proves non-execution without reading a possibly unrelated destination.
        if (match(a.value)) {
          op.state = 'failed';
          op.error = '移動は行われていません';
          continue;
        }
        // A present but changed/unreadable source cannot establish completion.
        const b = a.missing ? await inspect(op.to) : undefined;
        if (a.missing && match(b?.value)) {
          op.state = 'done';
          op.error = undefined;
        } else {
          op.state = 'unresolved';
          op.error =
            b?.error || a.error || '元・先の状態が特定できません。実ファイルを確認してください。';
          unresolved = true;
        }
      }
      p.status = unresolved
        ? 'recovery'
        : p.operations.every((o) => o.state === 'done')
          ? 'completed'
          : p.operations.some((o) => o.state === 'done')
            ? 'partial'
            : 'failed';
      p.error = unresolved ? '未確定項目があります。自動再実行はしません。' : undefined;
      this.save(p);
    }
    if (signal.aborted) throw new Error('中断しました。');
    if (!this.store.list<Plan>('plans').some((p) => this.unconfirmed(p))) {
      // Even a failure before the first intent must pass an actual durable write.
      this.write('journal', 'recovery', { checkedAt: Date.now() });
      this.fault = undefined;
      this.changed();
    }
  }
  acknowledge(id: string, revision: number) {
    const p = this.get(id);
    if (this.executing || p.status !== 'recovery' || p.revision !== revision)
      throw new Error('確認対象が変わりました。再表示してください。');
    for (const op of p.operations)
      if (['intent', 'unresolved'].includes(op.state)) {
        op.state = 'unverified';
        op.error = '成否は未確定です。ユーザーが実ファイルを手動確認して照合を終了しました。';
      }
    p.status = 'reviewed';
    p.revision++;
    p.hash = '';
    p.expiresAt = 0;
    p.manualReviewedAt = Date.now();
    p.error =
      '手動確認済み。未確定だった操作は成功・失敗のいずれにも数えず、復元対象に含めません。';
    this.save(p);
  }
  async undo(id: string, signal: AbortSignal) {
    const original = this.get(id),
      root = this.root(original.rootId);
    if (['executing', 'recovery', 'draft', 'ready'].includes(original.status) || original.undoOf)
      throw new Error('この作業は復元対象にできません。');
    const previous = this.store.list<Plan>('plans').filter((p) => p.undoOf === id);
    if (previous.some((p) => ['ready', 'executing', 'recovery'].includes(p.status)))
      throw new Error('既存の復元計画を確認してください。');
    const reverted = new Set(
      previous.flatMap((p) => p.operations.filter((o) => o.state === 'done').map((o) => o.from)),
    );
    const plan: Plan = {
      id: randomUUID(),
      rootId: root.id,
      rootIdentity: root.identity,
      conversationId: original.conversationId,
      revision: 1,
      hash: '',
      expiresAt: Date.now() + 600000,
      createdAt: Date.now(),
      status: 'ready',
      entries: [],
      operations: [],
      totalBytes: 0,
      undoOf: id,
    };
    const budget: HashBudget = { bytes: 0, files: 0 };
    for (const op of [...original.operations]
      .reverse()
      .filter((o) => o.kind === 'move' && o.state === 'done' && !reverted.has(o.to))) {
      let reason = '';
      try {
        const exists = await fs.lstat(path.join(root.path, op.from!)).then(
          () => true,
          (e: NodeJS.ErrnoException) => {
            if (e.code === 'ENOENT') return false;
            throw e;
          },
        );
        if (exists) throw new Error('元のパスが使用されています');
        const identity = await this.inspectWithinBudget(
          root,
          op.to,
          op.identity,
          budget,
          signal,
          '復元対象の状態を検証しています',
        );
        if (
          !op.identity?.hash ||
          identity.id !== op.identity.id ||
          identity.hash !== op.identity.hash ||
          identity.size !== op.identity.size ||
          identity.modified !== op.identity.modified
        )
          throw new Error('移動後にファイルが変更されています');
        plan.totalBytes += identity.size;
        plan.operations.push({
          id: randomUUID(),
          kind: 'move',
          from: op.to,
          to: op.from!,
          identity,
          state: 'pending',
        });
      } catch (error) {
        if (signal.aborted) throw error;
        reason = (error as Error).message;
      }
      plan.entries.push({
        id: randomUUID(),
        name: op.to,
        size: op.identity!.size,
        category: '変更なし',
        reason: reason || '元の場所へ復元',
        excluded: reason || undefined,
      });
    }
    if (!plan.operations.length)
      throw new Error(
        '復元できる項目がありません。変更・競合・復元済み・読取り上限の項目は保持します。' +
          (plan.entries.find((e) => e.excluded)?.reason ?? ''),
      );
    if (plan.totalBytes > MAX_BYTES || plan.operations.length > MAX_COUNT)
      throw new Error('復元計画が上限を超えています。');
    plan.hash = planHash(plan);
    this.save(plan);
    return plan;
  }
}
