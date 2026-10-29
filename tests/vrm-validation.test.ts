import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectVRM } from '../src/main/vrm';

function fixture(overrides: Record<string, unknown> = {}) {
  const metadata = {
    extensions: { VRMC_vrm: { meta: { name: 'bounded fixture' } } },
    buffers: [{ byteLength: 8 }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 8 }],
    images: [{ bufferView: 0 }],
    ...overrides,
  };
  const json = Buffer.from(JSON.stringify(metadata));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32);
  json.copy(padded);
  return glb([
    { kind: 0x4e4f534a, bytes: padded },
    { kind: 0x004e4942, bytes: Buffer.alloc(8) },
  ]);
}
function glb(chunks: { kind: number; bytes: Buffer }[]) {
  const result = Buffer.alloc(
    12 + chunks.reduce((length, chunk) => length + 8 + chunk.bytes.length, 0),
  );
  result.writeUInt32LE(0x46546c67);
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(result.length, 8);
  let offset = 12;
  for (const chunk of chunks) {
    result.writeUInt32LE(chunk.bytes.length, offset);
    result.writeUInt32LE(chunk.kind, offset + 4);
    chunk.bytes.copy(result, offset + 8);
    offset += 8 + chunk.bytes.length;
  }
  return result;
}
const dimensions = () => ({ width: 1, height: 1 });

test('VRM image offsets and references must be non-negative safe integers before decoding', () => {
  for (const byteOffset of [-1, 0.5, '0', null, 2 ** 53]) {
    let calls = 0;
    assert.throws(
      () =>
        inspectVRM(fixture({ bufferViews: [{ buffer: 0, byteOffset, byteLength: 4 }] }), () => {
          calls++;
          return dimensions();
        }),
      /画像データ/,
      `offset ${String(byteOffset)}`,
    );
    assert.equal(calls, 0);
  }
  for (const bufferView of [-1, 0.5, '0', null])
    assert.throws(
      () => inspectVRM(fixture({ images: [{ bufferView }] }), dimensions),
      /画像データ/,
    );
  assert.equal(
    inspectVRM(fixture({ bufferViews: [{ buffer: 0, byteLength: 8 }] }), dimensions).name,
    'bounded fixture',
  );
});

test('VRM decoded dimensions cannot bypass pixel budgets with NaN, infinity or fractional values', () => {
  for (const size of [NaN, Infinity, -1, 0, 1.5])
    for (const axis of ['width', 'height'] as const)
      assert.throws(
        () => inspectVRM(fixture(), () => ({ ...dimensions(), [axis]: size })),
        /4096px/,
      );
});

test('VRM GLB requires a JSON-first layout with one optional BIN chunk', () => {
  const json = { kind: 0x4e4f534a, bytes: Buffer.from('{"extensions":{"VRM":{}}}   ') };
  // Explicitly align the JSON chunk so only ordering/duplication is under test.
  json.bytes = Buffer.concat([json.bytes, Buffer.alloc((4 - (json.bytes.length % 4)) % 4, 32)]);
  const bin = { kind: 0x004e4942, bytes: Buffer.alloc(4) };
  assert.throws(() => inspectVRM(glb([bin, json]), dimensions), /GLB/);
  assert.throws(() => inspectVRM(glb([json, bin, bin]), dimensions), /GLB/);
  assert.equal(inspectVRM(glb([json, bin]), dimensions).version, '0');
  for (const invalid of ['null', '[]  ', '0   '])
    assert.throws(
      () => inspectVRM(glb([{ kind: json.kind, bytes: Buffer.from(invalid) }, json]), dimensions),
      /GLB/,
    );
});

test('VRM triangle budget includes repeated node instances of the same mesh', () => {
  const mesh = { primitives: [{ indices: 0 }] };
  const scene = {
    meshes: [mesh],
    accessors: [{ count: 300000 }], // 100,000 triangles for each visible instance.
  };
  assert.equal(
    inspectVRM(fixture({ ...scene, nodes: [{ mesh: 0 }, { mesh: 0 }] }), dimensions).version,
    '1',
  );
  assert.throws(
    () =>
      inspectVRM(fixture({ ...scene, nodes: [{ mesh: 0 }, { mesh: 0 }, { mesh: 0 }] }), dimensions),
    /三角形数/,
  );
  for (const mesh of [-1, 0.5, '0', null, 1])
    assert.throws(
      () => inspectVRM(fixture({ ...scene, nodes: [{ mesh }] }), dimensions),
      /メッシュ参照/,
    );
  // Preserve the previous conservative budget for unused meshes, too.
  assert.throws(
    () => inspectVRM(fixture({ ...scene, meshes: [mesh, mesh, mesh], nodes: [] }), dimensions),
    /三角形数/,
  );
});
