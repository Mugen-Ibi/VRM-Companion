import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import type { Settings, Phase } from '../shared/types';
const api = window.avatarHost,
  canvas = document.querySelector<HTMLCanvasElement>('#avatar-canvas')!;
const renderer = new THREE.WebGLRenderer({
  canvas,
  alpha: true,
  antialias: true,
  powerPreference: 'low-power',
});
renderer.setClearColor(0x000000, 0);
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
const scene = new THREE.Scene();
scene.add(new THREE.HemisphereLight(0xffffff, 0x9ca8a0, 2));
const light = new THREE.DirectionalLight(0xfff6e9, 2);
light.position.set(-1, 2, 3);
scene.add(light);
const normalizedHeight = 1.65,
  frameMargin = 1.12;
const camera = new THREE.PerspectiveCamera(30, innerWidth / innerHeight, 0.01, 100);
let modelDimensions = { width: 1, height: normalizedHeight, depth: 0 };
let vrm: VRM | undefined,
  loadedId: string | null = null,
  loadingId: string | null = null,
  settings: Settings,
  phase: Phase = 'idle',
  visible = false,
  generation = 0,
  elapsed = 0,
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
  down = null;
  dragged = false;
  if (pointerId !== undefined && canvas.hasPointerCapture(pointerId))
    canvas.releasePointerCapture(pointerId);
}
async function update(value: { settings: Settings; phase: Phase; visible: boolean }) {
  settings = value.settings;
  phase = value.phase;
  visible = value.visible;
  if (!visible) endDrag();
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
    }
    loadedId = null;
    endDrag();
    api.hit(false);
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
    candidate.humanoid.getNormalizedBoneNode('leftUpperArm')?.rotation.set(0, 0, -0.9);
    candidate.humanoid.getNormalizedBoneNode('rightUpperArm')?.rotation.set(0, 0, 0.9);
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
    scene.add(vrm.scene);
    candidateScene = undefined;
    modelDimensions = dimensions;
    positionCamera();
    loadedId = id;
    loadingId = null;
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
canvas.addEventListener('pointermove', (e) => {
  if (down) {
    const dx = e.screenX - down.x,
      dy = e.screenY - down.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) dragged = true;
    api.drag(dx, dy);
    down = { x: e.screenX, y: e.screenY, pointerId: down.pointerId };
  } else api.hit(hit(e));
});
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (hit(e)) {
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
canvas.addEventListener('pointerleave', () => {
  if (!down) api.hit(false);
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
function frame(time: number) {
  requestAnimationFrame(frame);
  if (!settings || !visible || document.hidden) {
    last = time;
    return;
  }
  if (time - last < 1000 / settings.fps) return;
  const dt = Math.min((time - last) / 1000, 0.05);
  last = time;
  elapsed += dt;
  if (vrm) {
    const expressions = vrm.expressionManager;
    const blink = Math.sin(elapsed * 1.1) > 0.995 ? 1 : 0;
    expressions?.setValue('blink', blink);
    expressions?.setValue('happy', phase === 'success' ? 0.3 : 0);
    expressions?.setValue('relaxed', phase === 'thinking' ? 0.2 : 0);
    const chest = vrm.humanoid.getNormalizedBoneNode('chest');
    if (chest) chest.rotation.x = Math.sin(elapsed * 1.8) * 0.012;
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
requestAnimationFrame(frame);
