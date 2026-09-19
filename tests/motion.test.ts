import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Object3D } from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { AvatarMotion } from '../src/renderer/motion';

test('normalized motions vary over time and restore rest pose when disabled without drift', () => {
  const names = [
    'spine',
    'chest',
    'neck',
    'head',
    'leftUpperArm',
    'rightUpperArm',
    'leftLowerArm',
    'rightLowerArm',
    'leftHand',
    'rightHand',
  ];
  const bones = new Map(names.map((name) => [name, new Object3D()]));
  bones.get('leftUpperArm')!.rotation.z = -1.25;
  bones.get('rightUpperArm')!.rotation.z = 1.25;
  const expressions = new Map<string, number>();
  const vrm = {
    humanoid: { getNormalizedBoneNode: (name: string) => bones.get(name) },
    expressionManager: { setValue: (name: string, value: number) => expressions.set(name, value) },
  } as unknown as VRM;
  const motion = new AvatarMotion(vrm, () => 0.25);
  let blinks = 0;
  for (let i = 0; i < 6000; i++) {
    motion.update(1 / 30, i < 500 ? 'thinking' : 'idle', 'lively', { x: 20, y: -20 }, false);
    if (expressions.get('blink')! > 0.5) blinks++;
    for (const node of bones.values())
      for (const angle of [node.rotation.x, node.rotation.y, node.rotation.z])
        assert.ok(Number.isFinite(angle) && Math.abs(angle) < 2.1);
  }
  assert.ok(blinks > 20);
  for (const name of ['wave', 'nod', 'bow', 'stretch'] as const) {
    motion.play(name);
    for (let i = 0; i < 20; i++) motion.update(1 / 30, 'idle', 'lively', { x: 0, y: 0 }, false);
    assert.ok(
      [...bones.values()].some(
        (node) =>
          Math.abs(node.rotation.x) + Math.abs(node.rotation.y) + Math.abs(node.rotation.z) > 0,
      ),
    );
    motion.update(1 / 30, 'idle', 'off', { x: 1, y: 1 }, false);
    for (const [boneName, node] of bones) {
      assert.equal(Math.abs(node.rotation.x), 0);
      assert.equal(Math.abs(node.rotation.y), 0);
      assert.equal(
        node.rotation.z || 0,
        boneName === 'leftUpperArm' ? -1.25 : boneName === 'rightUpperArm' ? 1.25 : 0,
      );
    }
  }
});
test('models without optional bones or expressions can still animate', () => {
  const motion = new AvatarMotion({
    humanoid: { getNormalizedBoneNode: () => null },
  } as unknown as VRM);
  motion.play('wave');
  assert.doesNotThrow(() => motion.update(0.03, 'success', 'gentle', { x: 0, y: 0 }, true));
});
