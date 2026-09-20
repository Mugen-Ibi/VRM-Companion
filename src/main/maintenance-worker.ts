import { parentPort, workerData } from 'node:worker_threads';
import { imageSize, disableTypes } from 'image-size';
import { inspectVRM } from './vrm';
import { Store } from './store';
import type { MaintenanceRequest } from './maintenance';

try {
  const request = workerData as MaintenanceRequest;
  let value: unknown;
  if (request.kind === 'vrm') {
    // Embedded raster formats accepted by the GLTF renderer. Read headers before decoding.
    disableTypes([
      'bmp',
      'cur',
      'dds',
      'gif',
      'heif',
      'icns',
      'ico',
      'j2c',
      'jp2',
      'jxl',
      'ktx',
      'pnm',
      'psd',
      'svg',
      'tga',
      'tiff',
    ]);
    value = inspectVRM(Buffer.from(request.bytes), (image) => imageSize(image));
  } else {
    const store = new Store(
      request.directory,
      request.dataKey ? { dataKey: request.dataKey } : undefined,
    );
    try {
      if (request.kind === 'backup') value = store.backup();
      else if (request.kind === 'deleteBackupHistory') store.removeBackupHistory(request.id);
      else throw new Error('Unknown maintenance request');
    } finally {
      store.close();
    }
  }
  parentPort!.postMessage({ ok: true, value });
} catch (error) {
  parentPort!.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
