import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import type { Settings, Phase } from '../shared/types';
import { AvatarMotion } from './motion';
const api = window.avatarHost,
  canvas = document.querySelector<HTMLCanvasElement>('#avatar-canvas')!;
const renderer = new THREE.WebGLRenderer({
  canvas,
  alpha: true,
  antialias: true,
  powerPreference: 'low-power',
});
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffffff, 0x9ca8a0, 2));
const light = new THREE.DirectionalLight(0xfff6e9, 2);
light.position.set(-1, 2, 3);
scene.add(light);
const normalizedHeight = 1.65,
  frameMargin = 1.35;
const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.01, 100);
let modelDimensions = { width: 1, height: normalizedHeight, depth: 0 };
let vrm: VRM | undefined,
  loadedId: string | null = null,
  loadingId: string | null = null,
  settings: Settings,
  phase: Phase = 'idle',
  visible = false,
  generation = 0,
  motion: AvatarMotion | undefined,
  animation: number | undefined,
  lastHit = 0,
  reportedHit = false,
  last = 0,
  dragged = false,
  down: { x: number; y: number; pointerId: number } | null = null;
const ray = new THREE.Raycaster(),
  mouse = new THREE.Vector2();
function fitDistance(dimensions: typeof modelDimensions) {
  const tangent = Math.tan((camera.fov * Math.PI) / 360);
  const distance =
    dimensions.depth / 2 +
    Math.max(dimensions.height / (2 * tangent), dimensions.width / (2 * tangent * camera.aspect)) *
      frameMargin;
  if (
    !Number.isFinite(distance) ||
    !Number.isFinite((distance + dimensions.depth) * 4) ||
    distance <= 0
  )
    throw new Error('モデルの表示範囲が不正です。');
  return distance;
}
function positionCamera() {
  const distance = fitDistance(modelDimensions);
  camera.position.set(0, normalizedHeight / 2, distance / (settings?.scale ?? 1));
  camera.far = Math.max(100, (distance + modelDimensions.depth) * 4);
  camera.lookAt(0, normalizedHeight / 2, 0);
  camera.updateProjectionMatrix();
}
function endDrag() {
  const pointerId = down?.pointerId;
  if (down) api.dragging(false);
  down = null;
  dragged = false;
  reportedHit = false;
  if (pointerId !== undefined && canvas.hasPointerCapture(pointerId))
    canvas.releasePointerCapture(pointerId);
}
async function update(value: { settings: Settings; phase: Phase; visible: boolean }) {
  const quality = settings?.renderQuality;
  settings = value.settings;
  phase = value.phase;
  visible = value.visible;
  if (!visible) endDrag();
  if (quality !== settings.renderQuality) {
    renderer.setPixelRatio(
      Math.min(
        devicePixelRatio,
        settings.renderQuality === 'high' ? 2 : settings.renderQuality === 'balanced' ? 1.5 : 1,
      ),
    );
    renderer.setSize(innerWidth, innerHeight);
  }
  schedule();
  positionCamera();
  const id = settings.avatarId;
  if (id !== null && id === loadingId) return;
  // Returning to the displayed model (including null) also cancels an older load.
  const gen = ++generation;
  loadingId = null;
  if (id === loadedId) {
    if (id) api.report(id, true);
    return;
  }
  if (!id) {
    if (vrm) {
      scene.remove(vrm.scene);
      VRMUtils.deepDispose(vrm.scene);
      vrm = undefined;
      motion = undefined;
    }
    loadedId = null;
    endDrag();
    api.hit(false);
    renderer.render(scene, camera);
    schedule();
    return;
  }
  loadingId = id;
  let candidateScene: THREE.Object3D | undefined;
  try {
    const bytes = await api.bytes(id);
    if (gen !== generation) return;
    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    loader.manager.setURLModifier((url) => {
      if (!url.startsWith('blob:') && !url.startsWith('data:'))
        throw new Error('外部アセットは読み込めません。');
      return url;
    });
    const gltf = await loader.parseAsync(bytes.buffer as ArrayBuffer, '');
    const candidate = gltf.userData.vrm as VRM | undefined;
    candidateScene = candidate?.scene ?? gltf.scene;
    if (!candidate) throw new Error('VRMの読み込みに失敗しました。');
    if (gen !== generation) return;
    VRMUtils.rotateVRM0(candidate);
    candidate.scene.traverse((obj) => {
      obj.frustumCulled = false;
    });
    candidate.humanoid.getNormalizedBoneNode('leftUpperArm')?.rotation.set(0, 0, -1.25);
    candidate.humanoid.getNormalizedBoneNode('rightUpperArm')?.rotation.set(0, 0, 1.25);
    // Measure the posed, skinned geometry, then center any model around the same
    // floor and X/Z origin. Preserve transforms already present on the GLTF root.
    candidate.update(0);
    candidate.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(candidate.scene, true),
      height = box.max.y - box.min.y;
    if (
      ![box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z, height].every(
        Number.isFinite,
      ) ||
      height <= 0
    )
      throw new Error('モデルのサイズが不正です。');
    const factor = normalizedHeight / height;
    const dimensions = {
      width: (box.max.x - box.min.x) * factor,
      height: normalizedHeight,
      depth: (box.max.z - box.min.z) * factor,
    };
    const offset = {
      x: (box.min.x / 2 + box.max.x / 2) * factor,
      y: box.min.y * factor,
      z: (box.min.z / 2 + box.max.z / 2) * factor,
    };
    if (
      !Number.isFinite(factor) ||
      !Object.values(dimensions).every((value) => Number.isFinite(value) && value >= 0) ||
      !Object.values(offset).every(Number.isFinite)
    )
      throw new Error('モデルの表示範囲が不正です。');
    fitDistance(dimensions);
    candidate.scene.scale.multiplyScalar(factor);
    candidate.scene.position.multiplyScalar(factor);
    candidate.scene.position.x -= offset.x;
    candidate.scene.position.y -= offset.y;
    candidate.scene.position.z -= offset.z;
    if (vrm) {
      scene.remove(vrm.scene);
      VRMUtils.deepDispose(vrm.scene);
    }
    vrm = candidate;
    motion = new AvatarMotion(vrm);
    scene.add(vrm.scene);
    candidateScene = undefined;
    modelDimensions = dimensions;
    positionCamera();
    loadedId = id;
    loadingId = null;
    schedule();
    api.report(id, true);
  } catch (error) {
    if (gen === generation) {
      loadingId = null;
      api.report(id, false, (error as Error).message);
    }
  } finally {
    if (candidateScene) VRMUtils.deepDispose(candidateScene);
  }
}
function hit(e: PointerEvent) {
  mouse.set((e.clientX / innerWidth) * 2 - 1, (-e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(mouse, camera);
  return !!vrm && ray.intersectObject(vrm.scene, true).length > 0;
}
function reportHit(value: boolean) {
  if (reportedHit !== value) {
    reportedHit = value;
    api.hit(value);
  }
}
canvas.addEventListener('pointermove', (e) => {
  if (down) {
    const dx = e.screenX - down.x,
      dy = e.screenY - down.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) dragged = true;
    api.drag(dx, dy);
    down = { x: e.screenX, y: e.screenY, pointerId: down.pointerId };
  } else if (e.timeStamp - lastHit >= 33) {
    lastHit = e.timeStamp;
    reportHit(hit(e));
  }
});
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (hit(e)) {
    api.dragging(true);
    canvas.setPointerCapture(e.pointerId);
    down = { x: e.screenX, y: e.screenY, pointerId: e.pointerId };
    dragged = false;
  }
});
canvas.addEventListener('pointerup', (e) => {
  if (e.button !== 0) return;
  if (down && !dragged) api.openPanel();
  endDrag();
});
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('lostpointercapture', endDrag);
window.addEventListener('blur', endDrag);
canvas.addEventListener('pointerleave', () => {
  if (!down) {
    reportHit(false);
    mouse.set(0, 0);
  }
});
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  endDrag();
  api.openMenu();
});
window.addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  positionCamera();
});
function schedule() {
  const active = settings && visible && (!document.hidden || down) && vrm;
  if (active && animation === undefined) animation = requestAnimationFrame(frame);
  if (!active && animation !== undefined) {
    cancelAnimationFrame(animation);
    animation = undefined;
    last = 0;
  }
}
document.addEventListener('visibilitychange', schedule);
function frame(time: number) {
  animation = undefined;
  schedule();
  if (!settings || !visible || (document.hidden && !down)) {
    last = time;
    return;
  }
  if (time - last < 1000 / settings.fps - 0.8) return;
  const dt = Math.min((time - last) / 1000, 0.05);
  last = time;
  if (vrm) {
    motion?.update(dt, phase, settings.motionLevel, mouse, !!down);
    vrm.update(dt);
  }
  renderer.render(scene, camera);
}
let receivedUpdate = false;
api.onUpdate((value) => {
  receivedUpdate = true;
  void update(value);
});
void api.state().then((value) => {
  if (!receivedUpdate) void update(value);
});
api.onGesture((name) => motion?.play(name));
