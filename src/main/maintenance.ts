import { Worker } from 'node:worker_threads';
import path from 'node:path';

export type MaintenanceRequest =
  | { kind: 'vrm'; bytes: Uint8Array }
  | { kind: 'backup'; directory: string }
  | { kind: 'deleteBackupHistory'; directory: string; id?: string };

// One-shot workers keep expensive parsing, hashing and maintenance off the UI host.
export function runMaintenance<T>(base: string, request: MaintenanceRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(path.join(base, 'dist/main/maintenance-worker.cjs'), {
      workerData: request,
    });
    let result: { ok: boolean; value?: T; error?: string } | undefined;
    const timeout = setTimeout(() => {
      void worker.terminate();
    }, 180_000);
    worker.once('message', (message) => {
      result = message;
    });
    worker.once('error', reject);
    worker.once('exit', (code) => {
      clearTimeout(timeout);
      if (code === 0 && result?.ok) resolve(result.value as T);
      else
        reject(
          new Error(
            result?.error || '保存・検査処理が中断されました。データを確認して再試行してください。',
          ),
        );
    });
  });
}
