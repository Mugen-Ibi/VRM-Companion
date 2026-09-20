import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { build } from 'esbuild';
import { Store } from '../src/main/store';
import { runMaintenance } from '../src/main/maintenance';
import type { Avatar } from '../src/shared/types';

function texturedVRM(width = 1) {
  const image = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jH9kAAAAASUVORK5CYII=',
    'base64',
  );
  image.writeUInt32BE(width, 16);
  const json = Buffer.from(
    JSON.stringify({
      extensions: { VRMC_vrm: { meta: { name: 'worker fixture' } } },
      buffers: [{ byteLength: image.length }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: image.length }],
      images: [{ bufferView: 0, mimeType: 'image/png' }],
    }),
  );
  const text = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32);
  json.copy(text);
  const bin = Buffer.alloc(Math.ceil(image.length / 4) * 4);
  image.copy(bin);
  const glb = Buffer.alloc(28 + text.length + bin.length);
  glb.writeUInt32LE(0x46546c67, 0);
  glb.writeUInt32LE(2, 4);
  glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(text.length, 12);
  glb.writeUInt32LE(0x4e4f534a, 16);
  text.copy(glb, 20);
  glb.writeUInt32LE(bin.length, 20 + text.length);
  glb.writeUInt32LE(0x004e4942, 24 + text.length);
  bin.copy(glb, 28 + text.length);
  return glb;
}

test('maintenance workers keep the host responsive and preserve backup/deletion and VRM limits', async () => {
  const base = path.resolve('artifacts/maintenance-tests', randomUUID()),
    directory = path.join(base, 'state');
  await build({
    entryPoints: ['src/main/maintenance-worker.ts'],
    outfile: path.join(base, 'dist/main/maintenance-worker.cjs'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
  });
  const store = new Store(directory);
  try {
    store.put('conversations', 'fixture', { content: 'retained' });
    let responsive = false;
    const snapshotPromise = runMaintenance<string>(base, { kind: 'backup', directory });
    setImmediate(() => {
      responsive = true;
    });
    const snapshot = await snapshotPromise;
    assert.equal(responsive, true);
    assert.ok(fs.existsSync(snapshot));
    await runMaintenance(base, { kind: 'deleteBackupHistory', directory, id: 'fixture' });
    assert.deepEqual(
      store.get('conversations', 'fixture'),
      { content: 'retained' },
      'main record is committed only by the coordinator',
    );
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(snapshot, { readOnly: true });
    assert.equal(
      db.prepare("SELECT count(*) n FROM records WHERE bucket='conversations'").get()!.n,
      0,
    );
    db.close();
    const model = await runMaintenance<Avatar>(base, { kind: 'vrm', bytes: texturedVRM() });
    assert.equal(model.name, 'worker fixture');
    await assert.rejects(runMaintenance(base, { kind: 'vrm', bytes: texturedVRM(8192) }), /4096px/);
    await assert.rejects(
      runMaintenance(base, { kind: 'vrm', bytes: Buffer.from('invalid') }),
      /VRM/,
    );
  } finally {
    store.close();
  }
});
