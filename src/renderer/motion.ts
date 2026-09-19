import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import type { Gesture, Phase, Settings } from '../shared/types';

const duration: Record<Gesture, number> = { wave: 3.2, nod: 1.8, bow: 2.8, stretch: 4.5 };
const joints = [
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
] as const;
// Normalized humanoid bones let each imported VRM retain its own proportions.
export class AvatarMotion {
  private bones = new Map<
    VRMHumanBoneName,
    {
      node: NonNullable<ReturnType<VRM['humanoid']['getNormalizedBoneNode']>>;
      x: number;
      y: number;
      z: number;
      current: [number, number, number];
    }
  >();
  private time = 0;
  private nextIdle = 8;
  private nextBlink = 2;
  private blinkStart = -1;
  private previousPhase: Phase = 'idle';
  private gesture?: { name: Gesture; start: number };
  private expression = { happy: 0, relaxed: 0 };
  private gaze = { x: 0, y: 0 };
  constructor(
    private vrm: VRM,
    private random = Math.random,
  ) {
    for (const name of joints) {
      const node = vrm.humanoid.getNormalizedBoneNode(name);
      if (node)
        this.bones.set(name, {
          node,
          x: node.rotation.x,
          y: node.rotation.y,
          z: node.rotation.z,
          current: [node.rotation.x, node.rotation.y, node.rotation.z],
        });
    }
  }
  play(name: Gesture) {
    this.gesture = { name, start: this.time };
  }
  private rotate(name: VRMHumanBoneName, x = 0, y = 0, z = 0) {
    const bone = this.bones.get(name);
    if (bone) bone.node.rotation.set(bone.x + x, bone.y + y, bone.z + z);
  }
  update(
    dt: number,
    phase: Phase,
    level: Settings['motionLevel'],
    pointer: { x: number; y: number },
    dragging: boolean,
  ) {
    this.time += Math.min(Math.max(dt, 0), 0.1);
    const t = this.time,
      amount = level === 'off' ? 0 : level === 'lively' ? 1 : 0.55;
    for (const [name] of this.bones) this.rotate(name);
    if (phase !== this.previousPhase) {
      if (phase === 'success') this.play('nod');
      if (phase === 'attention') this.play('bow');
      this.previousPhase = phase;
    }
    if (level === 'off') this.gesture = undefined;
    else if (t >= this.nextIdle && !this.gesture && phase !== 'working' && !dragging) {
      const choices: Gesture[] = ['nod', 'wave', 'stretch', 'bow'];
      this.play(choices[Math.floor(this.random() * choices.length)]);
      this.nextIdle = t + (level === 'lively' ? 10 : 18) + this.random() * 16;
    }
    const ease = 1 - Math.exp(-dt * 3);
    this.gaze.x += (Math.max(-1, Math.min(1, pointer.x)) - this.gaze.x) * ease;
    this.gaze.y += (Math.max(-1, Math.min(1, pointer.y)) - this.gaze.y) * ease;
    this.rotate('spine', 0, 0, Math.sin(t * 0.7) * 0.025 * amount);
    this.rotate('chest', Math.sin(t * 1.7) * 0.018 * amount);
    this.rotate(
      'head',
      -this.gaze.y * 0.07 * amount,
      -this.gaze.x * 0.14 * amount,
      Math.sin(t * 0.43) * 0.04 * amount,
    );
    this.rotate(
      'leftUpperArm',
      Math.sin(t * 0.8) * 0.035 * amount,
      0,
      Math.sin(t * 1.1) * 0.035 * amount,
    );
    this.rotate(
      'rightUpperArm',
      -Math.sin(t * 0.8) * 0.035 * amount,
      0,
      -Math.sin(t * 1.1) * 0.035 * amount,
    );
    if (phase === 'thinking') this.rotate('neck', 0.035 * amount, 0, 0.1 * amount);
    if (phase === 'responding') this.rotate('neck', Math.sin(t * 3.5) * 0.045 * amount);
    if (dragging) this.rotate('chest', -0.08 * amount, 0, Math.sin(t * 5) * 0.035 * amount);
    if (this.gesture) {
      const u = (t - this.gesture.start) / duration[this.gesture.name];
      if (u >= 1) this.gesture = undefined;
      else {
        const w = Math.sin(Math.PI * u) ** 2 * (level === 'gentle' ? 0.85 : amount);
        switch (this.gesture.name) {
          case 'wave':
            this.rotate('leftUpperArm', 0, 0, 1.0 * w);
            this.rotate('leftLowerArm', 0, -0.2 * w, 1.9 * w);
            this.rotate('leftHand', 0, Math.sin(u * Math.PI * 10) * 0.4 * w, 0.1 * w);
            this.rotate('head', 0, 0, -0.08 * w);
            break;
          case 'nod':
            this.rotate('neck', Math.sin(u * Math.PI * 4) * 0.16 * w);
            break;
          case 'bow':
            this.rotate('spine', 0.24 * w);
            this.rotate('head', 0.14 * w);
            break;
          case 'stretch':
            this.rotate('chest', -0.06 * w);
            this.rotate('leftUpperArm', 0, 0, 2.45 * w);
            this.rotate('rightUpperArm', 0, 0, -2.45 * w);
            this.rotate('leftLowerArm', 0, 0, 1.2 * w);
            this.rotate('rightLowerArm', 0, 0, -1.2 * w);
            break;
        }
      }
    }
    if (t >= this.nextBlink) {
      this.blinkStart = t;
      this.nextBlink = t + 3 + this.random() * 4;
    }
    // Blend interruptions (manual gestures, drag and phase changes) without snapping.
    const blend = level === 'off' ? 1 : 1 - Math.exp(-dt * 10);
    for (const bone of this.bones.values()) {
      bone.current[0] += (bone.node.rotation.x - bone.current[0]) * blend;
      bone.current[1] += (bone.node.rotation.y - bone.current[1]) * blend;
      bone.current[2] += (bone.node.rotation.z - bone.current[2]) * blend;
      bone.node.rotation.set(...bone.current);
    }
    const blinkTime = t - this.blinkStart;
    const blink =
      level !== 'off' && blinkTime >= 0 && blinkTime < 0.18
        ? Math.sin((blinkTime / 0.18) * Math.PI)
        : 0;
    this.expression.happy +=
      ((phase === 'success' ? 0.4 : this.gesture?.name === 'wave' ? 0.18 : 0) -
        this.expression.happy) *
      ease;
    this.expression.relaxed +=
      ((phase === 'idle' || phase === 'thinking' ? 0.12 : 0) - this.expression.relaxed) * ease;
    this.vrm.expressionManager?.setValue('blink', blink);
    this.vrm.expressionManager?.setValue('happy', this.expression.happy);
    this.vrm.expressionManager?.setValue('relaxed', this.expression.relaxed);
  }
}
