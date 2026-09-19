// Procedural test models only. These fixtures are not shipped as user avatars.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
export async function createFixtures(directory) {
  await mkdir(directory, { recursive: true });
  const positions = new Float32Array([
    -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1,
  ]);
  const indices = new Uint16Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 0, 4, 7, 0, 7, 3, 1, 2,
    6, 1, 6, 5,
  ]);
  const binary = Buffer.concat([Buffer.from(positions.buffer), Buffer.from(indices.buffer)]);
  const nodes = [
    { name: 'FixtureRoot', children: [1] },
    { name: 'hips', translation: [0, 0.9, 0], children: [] },
  ];
  const boneMap = { hips: 1 };
  const bone = (name, parent, translation, size, material = 0) => {
    const index = nodes.length;
    boneMap[name] = index;
    nodes.push({ name, translation, children: [] });
    nodes[parent].children.push(index);
    if (size) {
      const visual = nodes.length;
      nodes.push({ name: name + '_visual', mesh: material, scale: size });
      nodes[index].children.push(visual);
    }
    return index;
  };
  const spine = bone('spine', 1, [0, 0.18, 0], [0.16, 0.2, 0.09]);
  const chest = bone('chest', spine, [0, 0.22, 0], [0.21, 0.12, 0.1]);
  const neck = bone('neck', chest, [0, 0.18, 0], [0.04, 0.05, 0.04]);
  bone('head', neck, [0, 0.18, 0], [0.13, 0.15, 0.12], 1);
  for (const [side, sign] of [
    ['left', 1],
    ['right', -1],
  ]) {
    const arm = bone(side + 'UpperArm', chest, [sign * 0.24, 0.04, 0], [0.13, 0.045, 0.045]);
    const fore = bone(side + 'LowerArm', arm, [sign * 0.26, 0, 0], [0.12, 0.035, 0.04]);
    bone(side + 'Hand', fore, [sign * 0.23, 0, 0], [0.07, 0.04, 0.06], 1);
    const leg = bone(side + 'UpperLeg', 1, [sign * 0.1, -0.2, 0], [0.065, 0.2, 0.07]);
    const lower = bone(side + 'LowerLeg', leg, [0, -0.38, 0], [0.055, 0.17, 0.055]);
    bone(side + 'Foot', lower, [0, -0.25, 0.055], [0.055, 0.04, 0.11]);
  }
  const base = {
    asset: { version: '2.0', generator: 'VRM Companion synthetic test fixture' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes,
    buffers: [{ byteLength: binary.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 },
      {
        buffer: 0,
        byteOffset: positions.byteLength,
        byteLength: indices.byteLength,
        target: 34963,
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 8,
        type: 'VEC3',
        min: [-1, -1, -1],
        max: [1, 1, 1],
      },
      { bufferView: 1, componentType: 5123, count: indices.length, type: 'SCALAR' },
    ],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorFactor: [0.25, 0.48, 0.4, 1],
          metallicFactor: 0,
          roughnessFactor: 0.8,
        },
        doubleSided: true,
      },
      {
        pbrMetallicRoughness: {
          baseColorFactor: [0.8, 0.7, 0.5, 1],
          metallicFactor: 0,
          roughnessFactor: 0.8,
        },
        doubleSided: true,
      },
    ],
    meshes: [0, 1].map((material) => ({
      primitives: [{ attributes: { POSITION: 0 }, indices: 1, material }],
    })),
  };
  for (const version of [0, 1]) {
    const json = structuredClone(base);
    if (version === 1) {
      json.extensionsUsed = ['VRMC_vrm'];
      json.extensions = {
        VRMC_vrm: {
          specVersion: '1.0',
          meta: {
            name: 'Synthetic VRM 1.0 test',
            version: '1',
            authors: ['VRM Companion tests'],
            licenseUrl: 'https://vrm.dev/licenses/1.0/',
            avatarPermission: 'onlyAuthor',
            commercialUsage: 'personalNonProfit',
            creditNotation: 'unnecessary',
            modification: 'allowModification',
            allowRedistribution: false,
          },
          humanoid: {
            humanBones: Object.fromEntries(
              Object.entries(boneMap).map(([name, node]) => [name, { node }]),
            ),
          },
        },
      };
    } else {
      json.extensionsUsed = ['VRM'];
      json.extensions = {
        VRM: {
          specVersion: '0.0',
          meta: {
            title: 'Synthetic VRM 0.x test',
            version: '1',
            author: 'VRM Companion tests',
            allowedUserName: 'OnlyAuthor',
            licenseName: 'Other',
            otherLicenseUrl: 'https://unlicense.org',
          },
          humanoid: {
            humanBones: Object.entries(boneMap).map(([bone, node]) => ({
              bone,
              node,
              useDefaultValues: true,
            })),
          },
          firstPerson: { firstPersonBone: boneMap.head },
          blendShapeMaster: { blendShapeGroups: [] },
          secondaryAnimation: { boneGroups: [], colliderGroups: [] },
          materialProperties: [],
        },
      };
    }
    const text = Buffer.from(JSON.stringify(json)),
      padded = Buffer.alloc(Math.ceil(text.length / 4) * 4, 32);
    text.copy(padded);
    const result = Buffer.alloc(12 + 8 + padded.length + 8 + binary.length);
    result.writeUInt32LE(0x46546c67, 0);
    result.writeUInt32LE(2, 4);
    result.writeUInt32LE(result.length, 8);
    result.writeUInt32LE(padded.length, 12);
    result.writeUInt32LE(0x4e4f534a, 16);
    padded.copy(result, 20);
    const off = 20 + padded.length;
    result.writeUInt32LE(binary.length, off);
    result.writeUInt32LE(0x004e4942, off + 4);
    binary.copy(result, off + 8);
    await writeFile(path.join(directory, `fixture-${version}.vrm`), result);
  }
}
