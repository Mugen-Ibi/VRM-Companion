import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import type { Settings, LocalModel, LlmState } from '../shared/types';

// Only direct, regular GGUF files are catalogued. Split models are represented once.
export async function scanModels(directory: string): Promise<LocalModel[]> {
  if (!directory) return [];
  const root = await fs.realpath(directory);
  const entries = await fs.readdir(root, { withFileTypes: true });
  const models: LocalModel[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !/\.gguf$/i.test(entry.name) || /^mmproj[-_.]/i.test(entry.name))
      continue;
    const split = entry.name.match(/^(.*)-(\d{5})-of-(\d{5})\.gguf$/i);
    if (split && split[2] !== '00001') continue;
    const names = split
      ? Array.from(
          { length: Math.min(Number(split[3]), 1000) },
          (_, i) => `${split[1]}-${String(i + 1).padStart(5, '0')}-of-${split[3]}.gguf`,
        )
      : [entry.name];
    if (split && (Number(split[3]) < 1 || Number(split[3]) > 1000)) continue;
    let size = 0;
    try {
      for (const name of names) {
        const stat = await fs.lstat(path.join(root, name));
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file');
        size += stat.size;
      }
      const handle = await fs.open(path.join(root, entry.name), 'r');
      try {
        const magic = Buffer.alloc(4);
        await handle.read(magic, 0, 4, 0);
        if (magic.toString() !== 'GGUF') continue;
      } finally {
        await handle.close();
      }
      models.push({
        id: createHash('sha256')
          .update(root + '\0' + entry.name)
          .digest('hex'),
        name: entry.name,
        size,
      });
    } catch {
      /* Incomplete downloads and inaccessible files are omitted. */
    }
  }
  return models.sort((a, b) => a.name.localeCompare(b.name));
}

export function launchArguments(model: string, port: number, context: number) {
  return [
    '--model',
    model,
    '--alias',
    'companion-local',
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
    '--ctx-size',
    String(context),
    '--parallel',
    '1',
    '--batch-size',
    '512',
    '--ubatch-size',
    '128',
    '--cache-ram',
    '0',
    '--flash-attn',
    'auto',
    '--fit',
    'on',
    '--fit-target',
    '1024',
    '--jinja',
  ];
}
async function availablePort(): Promise<number> {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class ModelRuntime {
  state: LlmState = { models: [], status: 'unloaded', loadedModel: '' };
  private child?: ChildProcess;
  private closed?: Promise<void>;
  private idle?: ReturnType<typeof setTimeout>;
  private connection?: { endpoint: string; key: string; signature: string };
  private stopping?: Promise<void>;
  constructor(
    private changed: () => void,
    private isBusy: () => boolean,
    private launch: typeof spawn = spawn,
  ) {}
  private update(value: Partial<LlmState>) {
    this.state = { ...this.state, ...value };
    this.changed();
  }
  async refresh(directory: string) {
    const models = await scanModels(directory);
    this.update({ models });
    return models;
  }
  credentials() {
    if (this.state.status !== 'ready' || !this.connection)
      throw new Error('モデルが読み込まれていません。');
    return this.connection;
  }
  async ensure(settings: Settings, signal: AbortSignal) {
    this.cancelIdle();
    signal.throwIfAborted();
    const models = await this.refresh(settings.modelDirectory);
    signal.throwIfAborted();
    const selected = models.find((m) => m.id === settings.managedModel);
    if (!selected)
      throw new Error('設定でGGUFフォルダーを選び、会話画面でモデルを選択してください。');
    if (!settings.serverPath) throw new Error('設定でllama-server.exeを選択してください。');
    const root = await fs.realpath(settings.modelDirectory);
    const file = await fs.realpath(path.join(root, selected.name));
    if (path.dirname(file).toLowerCase() !== root.toLowerCase())
      throw new Error('モデルの場所が変更されています。再読込してください。');
    const stat = await fs.stat(file);
    const signature = JSON.stringify([
      file,
      stat.size,
      stat.mtimeMs,
      settings.context,
      settings.serverPath,
    ]);
    if (this.connection?.signature === signature && this.state.status === 'ready') return;
    await this.stop();
    signal.throwIfAborted();
    const executable = await fs.realpath(settings.serverPath);
    if (path.basename(executable).toLowerCase() !== 'llama-server.exe')
      throw new Error('llama-server.exeを選択してください。');
    const port = await availablePort(),
      key = randomBytes(32).toString('hex');
    signal.throwIfAborted();
    this.update({ status: 'loading', loadedModel: selected.id, error: undefined });
    let tail = '',
      failure = '';
    const child = this.launch(executable, launchArguments(file, port, settings.context), {
      cwd: path.dirname(executable),
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LLAMA_API_KEY: key },
    });
    this.child = child;
    this.closed = new Promise((resolve) => {
      child.once('error', (error) => {
        failure = error.message;
      });
      child.once('close', (code) => {
        failure ||= `llama-serverが終了しました（${code}）。${tail.slice(-1600)}`;
        if (this.child === child) {
          this.child = undefined;
          this.connection = undefined;
          if (this.state.status !== 'stopping')
            this.update({ status: 'error', loadedModel: '', error: failure });
        }
        resolve();
      });
    });
    const collect = (data: Buffer) => {
      tail = (tail + data.toString()).split(key).join('[key]').slice(-4000);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const url = `http://127.0.0.1:${port}`;
    try {
      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline) {
        signal.throwIfAborted();
        if (failure || this.child !== child)
          throw new Error(failure || 'モデルの起動が中断されました。');
        try {
          const response = await fetch(url + '/v1/models', {
            headers: { Authorization: `Bearer ${key}` },
            signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
            redirect: 'error',
          });
          if (response.ok) {
            const data = (await response.json()) as { data?: { id: string }[] };
            if (data.data?.some((m) => m.id === 'companion-local')) {
              signal.throwIfAborted();
              this.connection = { endpoint: url, key, signature };
              this.update({ status: 'ready' });
              return;
            }
          } else await response.body?.cancel();
        } catch {
          signal.throwIfAborted();
        }
        await pause(150);
      }
      throw new Error(
        'モデルの起動が3分以内に完了しませんでした。小さいモデルまたは短いコンテキストをお試しください。',
      );
    } catch (error) {
      await this.stop();
      this.update({
        status: signal.aborted ? 'unloaded' : 'error',
        error: signal.aborted ? undefined : (error as Error).message,
      });
      throw error;
    }
  }
  cancelIdle() {
    clearTimeout(this.idle);
    this.idle = undefined;
  }
  scheduleIdle(minutes: number) {
    this.cancelIdle();
    if (!minutes || !this.child) return;
    this.idle = setTimeout(() => {
      if (this.isBusy()) this.scheduleIdle(minutes);
      else
        void this.stop().catch((error) => this.update({ status: 'error', error: String(error) }));
    }, minutes * 60_000);
    this.idle.unref();
  }
  stop(): Promise<void> {
    if (!this.stopping)
      this.stopping = this.stopChild().finally(() => {
        this.stopping = undefined;
      });
    return this.stopping;
  }
  private async stopChild() {
    this.cancelIdle();
    const child = this.child,
      closed = this.closed;
    this.connection = undefined;
    if (child) {
      this.update({ status: 'stopping' });
      child.kill();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          closed,
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error('モデルプロセスを停止できませんでした。')),
              8000,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    this.update({ status: 'unloaded', loadedModel: '', error: undefined });
  }
  get running() {
    return !!this.child;
  }
}
