import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectVRM } from '../src/main/vrm';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import type { InstancedMesh } from 'three';

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

test('VRM triangle budget includes GPU instance accessor counts and ordinary mesh references', () => {
  const node = (countAccessor: number) => ({
    mesh: 0,
    extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: countAccessor } } },
  });
  const scene = {
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ count: 9 }, { count: 66666 }, { count: 66667 }],
  };
  assert.equal(inspectVRM(fixture({ ...scene, nodes: [node(1)] }), dimensions).version, '1');
  assert.throws(() => inspectVRM(fixture({ ...scene, nodes: [node(2)] }), dimensions), /三角形数/);
  assert.throws(
    () => inspectVRM(fixture({ ...scene, nodes: [node(1), { mesh: 0 }] }), dimensions),
    /三角形数/,
  );
  assert.throws(
    () => inspectVRM(fixture({ ...scene, nodes: [{ mesh: 0 }, node(1)] }), dimensions),
    /三角形数/,
  );
  assert.equal(
    inspectVRM(
      fixture({
        ...scene,
        accessors: [{ count: 6 }, { count: 100000 }],
        nodes: [node(1)],
      }),
      dimensions,
    ).version,
    '1',
  );
});

test('VRM GPU instance attributes require valid equally sized bounded accessor references', () => {
  const scene = {
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ count: 3 }, { count: 2 }, { count: 3 }, { count: 0 }, { count: 200001 }],
  };
  for (const attributes of [
    null,
    [],
    {},
    { TRANSLATION: -1 },
    { TRANSLATION: 0.5 },
    { TRANSLATION: '1' },
    { TRANSLATION: null },
    { TRANSLATION: 5 },
    { TRANSLATION: 1, SCALE: 2 },
    { TRANSLATION: 3 },
    { TRANSLATION: 4 },
  ])
    assert.throws(
      () =>
        inspectVRM(
          fixture({
            ...scene,
            nodes: [{ mesh: 0, extensions: { EXT_mesh_gpu_instancing: { attributes } } }],
          }),
          dimensions,
        ),
      /インスタンス/,
      JSON.stringify(attributes),
    );
  assert.equal(
    inspectVRM(
      fixture({
        ...scene,
        nodes: [
          {
            mesh: 0,
            extensions: {
              EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 1, SCALE: 1, _ID: 1 } },
            },
          },
        ],
      }),
      dimensions,
    ).version,
    '1',
  );
});

test('VRM GPU instance budget agrees with the installed CPU-only Three.js loader', async () => {
  const metadata = {
    asset: { version: '2.0' },
    buffers: undefined,
    bufferViews: undefined,
    images: undefined,
    extensionsUsed: ['EXT_mesh_gpu_instancing'],
    accessors: [
      { componentType: 5126, count: 6, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { componentType: 5126, count: 100000, type: 'VEC3' },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    nodes: [
      { mesh: 0, extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 1 } } } },
    ],
    scenes: [{ nodes: [0] }],
    scene: 0,
  };
  const bytes = fixture(metadata);
  assert.equal(inspectVRM(bytes, dimensions).version, '1');
  const model = await new GLTFLoader().parseAsync(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    '',
  );
  let triangles = 0;
  model.scene.traverse((object) => {
    const mesh = object as InstancedMesh;
    if (mesh.isInstancedMesh) {
      triangles += (mesh.count * mesh.geometry.attributes.position.count) / 3;
      mesh.geometry.dispose();
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material])
        material.dispose();
    }
  });
  assert.equal(triangles, 200000);
  assert.throws(
    () =>
      inspectVRM(
        fixture({
          ...metadata,
          accessors: [
            { ...metadata.accessors[0], count: 9 },
            { ...metadata.accessors[1], count: 66667 },
          ],
        }),
        dimensions,
      ),
    /三角形数/,
  );
});
