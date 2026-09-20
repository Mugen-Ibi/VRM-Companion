import { createHash, randomUUID } from 'node:crypto';
import type { Avatar } from '../shared/types';
type Gltf = {
  extensions?: Record<string, any>;
  buffers?: any[];
  images?: any[];
  bufferViews?: any[];
  meshes?: any[];
  accessors?: any[];
  nodes?: any[];
};
export function inspectVRM(
  bytes: Buffer,
  dimensions: (image: Buffer) => { width: number; height: number },
): Avatar {
  if (
    bytes.length > 100 * 1024 ** 2 ||
    bytes.length < 20 ||
    bytes.readUInt32LE(0) !== 0x46546c67 ||
    bytes.readUInt32LE(4) !== 2 ||
    bytes.readUInt32LE(8) !== bytes.length
  )
    throw new Error('有効な100MiB以下のVRM/GLBファイルを選択してください。');
  let offset = 12,
    json: Gltf | undefined,
    bin: Buffer | undefined;
  while (offset + 8 <= bytes.length) {
    const size = bytes.readUInt32LE(offset),
      kind = bytes.readUInt32LE(offset + 4);
    offset += 8;
    if (size % 4 !== 0 || offset + size > bytes.length) throw new Error('GLBチャンクが不正です。');
    if (kind === 0x4e4f534a) {
      if (json || size > 8 * 1024 ** 2) throw new Error('GLBメタデータが不正です。');
      json = JSON.parse(bytes.subarray(offset, offset + size).toString('utf8'));
    }
    if (kind === 0x004e4942) bin = bytes.subarray(offset, offset + size);
    offset += size;
  }
  if (offset !== bytes.length || !json) throw new Error('GLB構造が不正です。');
  for (const field of ['buffers', 'images', 'bufferViews', 'meshes', 'accessors', 'nodes'] as const)
    if (
      json[field] !== undefined &&
      (!Array.isArray(json[field]) ||
        json[field]!.some((entry) => !entry || typeof entry !== 'object' || Array.isArray(entry)))
    )
      throw new Error('GLBメタデータの配列が不正です。');
  for (const accessor of json.accessors ?? [])
    if (!Number.isSafeInteger(accessor.count) || accessor.count < 0)
      throw new Error('頂点・インデックス数が不正です。');
  const vrm1 = json.extensions?.VRMC_vrm,
    vrm0 = json.extensions?.VRM;
  if (!vrm1 && !vrm0) throw new Error('VRM 0.x / 1.0の拡張がありません。');
  if ((json.buffers ?? []).some((b) => b.uri) || (json.images ?? []).some((i) => i.uri))
    throw new Error('外部参照やURI画像を含むVRMは未対応です。画像埋め込みで書き出してください。');
  if ((json.nodes?.length ?? 0) > 10000) throw new Error('ノード数が上限を超えています。');
  let triangles = 0;
  for (const mesh of json.meshes ?? []) {
    if (!Array.isArray(mesh.primitives)) throw new Error('メッシュ構造が不正です。');
    for (const primitive of mesh.primitives) {
      if (!primitive || typeof primitive !== 'object') throw new Error('メッシュ構造が不正です。');
      if (primitive.extensions?.KHR_draco_mesh_compression)
        throw new Error('圧縮メッシュは未対応です。');
      const index = primitive.indices ?? primitive.attributes?.POSITION;
      const mode = primitive.mode ?? 4;
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        !json.accessors?.[index] ||
        !Number.isInteger(mode) ||
        mode < 0 ||
        mode > 6
      )
        throw new Error('メッシュの参照・描画形式が不正です。');
      const n = json.accessors[index].count;
      triangles += mode === 4 ? Math.ceil(n / 3) : n;
      if (triangles > 200000) throw new Error('三角形数20万の上限を超えています。');
    }
  }
  if (triangles > 200000) throw new Error('三角形数20万の上限を超えています。');
  let decoded = 0;
  for (const img of json.images ?? []) {
    const view = json.bufferViews?.[img.bufferView];
    if (
      !bin ||
      !view ||
      view.buffer !== 0 ||
      !Number.isSafeInteger(view.byteLength) ||
      view.byteLength <= 0 ||
      view.byteOffset < 0 ||
      (view.byteOffset ?? 0) + view.byteLength > bin.length
    )
      throw new Error('画像データが不正です。');
    const size = dimensions(
      bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength),
    );
    if (size.width <= 0 || size.height <= 0 || size.width > 4096 || size.height > 4096)
      throw new Error('画像は4096px以下の対応形式にしてください。');
    decoded += size.width * size.height * 4;
    if (decoded > 256 * 1024 ** 2) throw new Error('展開画像の合計256MiBを超えています。');
  }
  const meta = (vrm1 || vrm0).meta ?? {};
  const clean = (x: unknown) => String(x ?? '').slice(0, 2000);
  return {
    id: randomUUID(),
    name: clean(meta.name || meta.title || '名前のないVRM'),
    version: vrm1 ? '1' : '0',
    authors: clean(meta.authors?.join(', ') || meta.author || '情報なし'),
    license: clean(
      vrm1
        ? `${meta.licenseUrl || ''}\n${meta.otherLicenseUrl || ''}\n利用者: ${meta.avatarPermission || '未記載'} / 商用: ${meta.commercialUsage || '未記載'}`
        : `${meta.licenseName || ''}\n${meta.otherLicenseUrl || ''}\n利用者: ${meta.allowedUserName || '未記載'}`,
    ),
    hash: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
  };
}
