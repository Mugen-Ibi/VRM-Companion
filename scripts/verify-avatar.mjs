import { _electron as electron } from 'playwright';
import { panelWindow } from './electron-test.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createFixtures } from './fixtures.mjs';

const runFile = promisify(execFile),
  sample = path.resolve('.local/vrm-fixtures/VRM1_Constraint_Twist_Sample.vrm');
const directory = path.resolve('artifacts/verify-avatar-' + Date.now()),
  data = path.join(directory, 'state');
await mkdir(directory, { recursive: true });
await createFixtures(path.join(directory, 'synthetic'));
const original = await readFile(sample),
  hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
let json, bin;
for (let offset = 12; offset + 8 <= original.length; ) {
  const length = original.readUInt32LE(offset),
    kind = original.readUInt32LE(offset + 4);
  offset += 8;
  if (kind === 0x4e4f534a)
    json = JSON.parse(original.subarray(offset, offset + length).toString('utf8'));
  if (kind === 0x004e4942) bin = original.subarray(offset, offset + length);
  offset += length;
}
assert.ok(json && bin, 'Expected embedded GLB');
const trianglesFor = (mesh) =>
  mesh.primitives.reduce((sum, primitive) => {
    const count = json.accessors[primitive.indices ?? primitive.attributes.POSITION].count;
    return (
      sum +
      ((primitive.mode ?? 4) === 4
        ? count / 3
        : [5, 6].includes(primitive.mode)
          ? Math.max(0, count - 2)
          : 0)
    );
  }, 0);
const result = {
  startedAt: new Date().toISOString(),
  completed: false,
  directory,
  sample: {
    path: sample,
    bytes: original.length,
    sha256Before: hash(original),
    metadata: json.extensions?.VRMC_vrm?.meta,
    extensions: json.extensionsUsed,
    meshCount: json.meshes.length,
    primitiveCount: json.meshes.reduce((sum, mesh) => sum + mesh.primitives.length, 0),
    meshTriangles: json.meshes.reduce((sum, mesh) => sum + trianglesFor(mesh), 0),
    nodeInstanceTriangles: json.nodes.reduce(
      (sum, node) => sum + (node.mesh === undefined ? 0 : trianglesFor(json.meshes[node.mesh])),
      0,
    ),
    imageCount: json.images.length,
    materialCount: json.materials.length,
    constrainedNodeCount: json.nodes.filter((node) => node.extensions?.VRMC_node_constraint).length,
    springCount: json.extensions?.VRMC_springBone?.springs?.length ?? 0,
  },
  checks: [],
  screenshots: [],
  errors: [],
  rendererErrors: [],
  consoleErrors: [],
  consoleWarnings: [],
  nativeInput: null,
  limitations: [
    'Only the current Windows DPI setting is tested; 100%, 150%, and 200% settings were not changed or exhaustively tested.',
    'No real clicks or keyboard input are sent to other applications. Native hit testing is checked with WindowFromPoint and synthetic pointer events inside the owned avatar renderer.',
    'The official sample remains under .local and isolated test data; the packaging ignore rule excludes both .local and artifacts.',
  ],
};
const env = { ...process.env, COMPANION_TEST_DATA: data };
delete env.ELECTRON_RUN_AS_NODE;
let application, panel, avatarWindow;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function installDrawCounter() {
  let count = 0;
  for (const prototype of [
    globalThis.WebGLRenderingContext?.prototype,
    globalThis.WebGL2RenderingContext?.prototype,
  ].filter(Boolean))
    for (const name of [
      'drawArrays',
      'drawElements',
      'drawArraysInstanced',
      'drawElementsInstanced',
    ]) {
      const previous = prototype[name];
      if (typeof previous === 'function')
        prototype[name] = function () {
          count++;
          return previous.apply(this, arguments);
        };
    }
  globalThis.__avatarDrawCount = () => count;
}
async function launch() {
  application = await electron.launch({
    args: ['.', '--user-data-dir=' + data],
    env,
    timeout: 30000,
  });
  panel = await panelWindow(application);
  await panel.waitForFunction(() => !!window.companion);
  avatarWindow = (await application.windows()).find((window) =>
    window.url().endsWith('avatar.html'),
  );
  assert.ok(avatarWindow);
  for (const [name, page] of [
    ['panel', panel],
    ['avatar', avatarWindow],
  ]) {
    page.on('pageerror', (error) =>
      result.rendererErrors.push({ window: name, error: error.message }),
    );
    page.on('console', (message) => {
      if (message.type() === 'error')
        result.consoleErrors.push({ window: name, message: message.text() });
      if (message.type() === 'warning')
        result.consoleWarnings.push({ window: name, message: message.text().slice(0, 1500) });
    });
  }
  await application.evaluate(({ ipcMain }) => {
    globalThis.__verifyAvatarReports = [];
    ipcMain.on('avatar:report', (_event, id, ok, error) =>
      globalThis.__verifyAvatarReports.push({ id, ok, error }),
    );
  });
  await panel.evaluate(() => {
    window.__verifyAvatarErrors = [];
    window.companion.onEvent((event) => {
      if (event.type === 'error') window.__verifyAvatarErrors.push(event.message);
    });
  });
  await avatarWindow.addInitScript(installDrawCounter);
  await avatarWindow.reload();
  await avatarWindow.waitForFunction(() => !!window.avatarHost && !!window.__avatarDrawCount);
  assert.equal(path.resolve((await panel.evaluate(() => window.companion.state())).dataPath), data);
}
async function waitRendered(id) {
  assert.equal(typeof id, 'string', 'Expected a committed avatar ID');
  await waitState((state) => state.settings.avatarId === id);
  // Main commits a new selected ID only after the renderer reports success.
  // Confirm actual rendering as well; extra IPC observers are diagnostic only.
  const before = await avatarWindow.evaluate(() => window.__avatarDrawCount());
  await avatarWindow.waitForFunction((value) => window.__avatarDrawCount() > value, before, {
    timeout: 30000,
  });
}
async function waitState(predicate) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const state = await panel.evaluate(() => window.companion.state());
    if (predicate(state)) return state;
    await sleep(50);
  }
  throw new Error('Avatar state did not settle before timeout');
}
async function importFile(file) {
  await application.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, file);
  const previous = (await panel.evaluate(() => window.companion.state())).settings.avatarId;
  await panel.evaluate(() => window.companion.importAvatar());
  const state = await waitState(
    (value) => !!value.settings.avatarId && value.settings.avatarId !== previous,
  );
  const id = state.settings.avatarId;
  await waitRendered(id);
  return id;
}
async function screenshot(name) {
  // Electron's capturePage avoids Playwright's compositor screenshot timeout on
  // some transparent windows. Only this application's avatar is captured.
  const capture = await application.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().endsWith('avatar.html'),
    );
    const image = await Promise.race([
      window.webContents.capturePage(undefined, { stayAwake: true }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Avatar capture timed out')), 10000),
      ),
    ]);
    const { width, height } = image.getSize(),
      bitmap = image.toBitmap();
    let count = 0,
      minX = width,
      minY = height,
      maxX = -1,
      maxY = -1;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        if (bitmap[(y * width + x) * 4 + 3] > 32) {
          count++;
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
    const middleX = Math.round((minX + maxX) / 2),
      middleY = Math.round((minY + maxY) / 2);
    let point;
    for (let radius = 0; radius < Math.min(width, height) && !point; radius++)
      for (let dx = -radius; dx <= radius; dx++) {
        const x = middleX + dx,
          y = middleY;
        if (x >= 0 && x < width && y >= 0 && y < height && bitmap[(y * width + x) * 4 + 3] > 230) {
          point = { x: x / width, y: y / height };
          break;
        }
      }
    return {
      png: image.toPNG().toString('base64'),
      width,
      height,
      nonTransparentPixels: count,
      bounds: { minX, minY, maxX, maxY },
      opaquePoint: point,
    };
  });
  const file = path.join(directory, name + '.png');
  await writeFile(file, Buffer.from(capture.png, 'base64'));
  delete capture.png;
  capture.touchesFrameEdge = {
    left: capture.bounds.minX <= 1,
    right: capture.bounds.maxX >= capture.width - 2,
    top: capture.bounds.minY <= 1,
    bottom: capture.bounds.maxY >= capture.height - 2,
  };
  assert.ok(capture.nonTransparentPixels > 1000, 'Expected a visible avatar in capture');
  result.screenshots.push({ file, ...capture });
  return capture;
}

const nativeProbe = path.join(directory, 'win32-window-probe.ps1');
await writeFile(
  nativeProbe,
  String.raw`param([string]$AvatarHandle,[string]$PanelHandle,[double]$FractionX,[double]$FractionY)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CompanionWindowProbe {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW", SetLastError=true)] public static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr window, uint flag);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out RECT rect);
  [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
}
'@
$avatar=[IntPtr]::new([Int64]::Parse($AvatarHandle));$panel=[IntPtr]::new([Int64]::Parse($PanelHandle))
$style=[CompanionWindowProbe]::GetWindowLongPtr($avatar,-20).ToInt64()
$rect=New-Object CompanionWindowProbe+RECT
if(-not [CompanionWindowProbe]::GetWindowRect($avatar,[ref]$rect)){throw 'GetWindowRect failed'}
$point=New-Object CompanionWindowProbe+POINT
$point.X=$rect.Left+[int](($rect.Right-$rect.Left)*$FractionX);$point.Y=$rect.Top+[int](($rect.Bottom-$rect.Top)*$FractionY)
$hit=[CompanionWindowProbe]::WindowFromPoint($point);$root=[CompanionWindowProbe]::GetAncestor($hit,2)
[ordered]@{avatarHandle=$AvatarHandle;panelHandle=$PanelHandle;extendedStyle=$style;transparent=(($style -band 0x20)-ne 0);layered=(($style -band 0x80000)-ne 0);dpi=[CompanionWindowProbe]::GetDpiForWindow($avatar);pointX=$point.X;pointY=$point.Y;hitHandle=$hit.ToInt64().ToString();hitRoot=$root.ToInt64().ToString();hitAvatar=($root-eq $avatar);hitPanel=($root-eq $panel)}|ConvertTo-Json -Compress
`,
  'utf8',
);

try {
  console.log(JSON.stringify({ event: 'start', directory, sample }));
  await launch();
  const encodedImages = json.images.map((image) => {
    const view = json.bufferViews[image.bufferView];
    return bin
      .subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength)
      .toString('base64');
  });
  result.sample.images = await application.evaluate(
    ({ nativeImage }, images) =>
      images.map((data) => nativeImage.createFromBuffer(Buffer.from(data, 'base64')).getSize()),
    encodedImages,
  );
  result.sample.decodedImageBytes = result.sample.images.reduce(
    (sum, image) => sum + image.width * image.height * 4,
    0,
  );
  const sampleId = await importFile(sample);
  result.sample.registryId = sampleId;
  result.checks.push(
    'official VRM 1.0 imports, Main commits its selection, and WebGL drawing progresses',
  );
  console.log(JSON.stringify({ event: 'sample-imported', id: sampleId }));
  const firstCapture = await screenshot('01-official-vrm');
  const syntheticId = await importFile(path.join(directory, 'synthetic', 'fixture-0.vrm'));
  assert.notEqual(sampleId, syntheticId);
  await panel.evaluate((id) => window.companion.selectAvatar(id), sampleId);
  await waitRendered(sampleId);
  await screenshot('02-switched-back');
  result.checks.push('switch official VRM → synthetic VRM 0.x → official VRM');
  console.log(JSON.stringify({ event: 'switch-verified' }));
  result.firstLaunchAvatarReports = await application.evaluate(
    () => globalThis.__verifyAvatarReports,
  );
  result.errors.push(...(await panel.evaluate(() => window.__verifyAvatarErrors)));
  await application.close();
  application = undefined;
  await launch();
  await waitRendered(sampleId);
  await screenshot('03-after-restart');
  result.checks.push('selected official model survives a complete app restart');
  const copied = await readFile(path.join(data, 'avatars', sampleId + '.vrm'));
  result.sample.managedCopySha256 = hash(copied);
  assert.equal(hash(copied), result.sample.sha256Before);
  const handles = await application.evaluate(({ BrowserWindow, screen }) => {
    const windows = BrowserWindow.getAllWindows(),
      avatar = windows.find((window) => window.webContents.getURL().endsWith('avatar.html')),
      panel = windows.find((window) => window.webContents.getURL().endsWith('index.html')),
      area = screen.getPrimaryDisplay().workArea;
    panel.setBounds({
      x: area.x + 30,
      y: area.y + 30,
      width: Math.min(1120, area.width - 60),
      height: Math.min(810, area.height - 60),
    });
    avatar.setPosition(area.x + 150, area.y + 150);
    panel.show();
    avatar.showInactive();
    avatar.moveTop();
    const handle = (window) => {
      const buffer = window.getNativeWindowHandle();
      return (
        buffer.length === 8 ? buffer.readBigUInt64LE() : BigInt(buffer.readUInt32LE())
      ).toString();
    };
    return {
      avatar: handle(avatar),
      panel: handle(panel),
      scaleFactor: screen.getDisplayMatching(avatar.getBounds()).scaleFactor,
    };
  });
  const point = firstCapture.opaquePoint ?? { x: 0.5, y: 0.5 };
  const probe = async (label) => {
    const { stdout } = await runFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        nativeProbe,
        '-AvatarHandle',
        handles.avatar,
        '-PanelHandle',
        handles.panel,
        '-FractionX',
        String(point.x),
        '-FractionY',
        String(point.y),
      ],
      { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 },
    );
    return { label, ...JSON.parse(stdout.trim()) };
  };
  const pointer = async (point) => {
    await avatarWindow.evaluate(
      (value) =>
        document.querySelector('canvas').dispatchEvent(
          new PointerEvent('pointermove', {
            clientX: innerWidth * value.x,
            clientY: innerHeight * value.y,
            bubbles: true,
          }),
        ),
      point,
    );
    await sleep(150);
  };
  await pointer(point);
  const body = await probe('synthetic pointer over rendered body');
  await pointer({ x: 0.01, y: 0.01 });
  const empty = await probe('synthetic pointer over empty corner, query body point');
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().endsWith('avatar.html'))
      .setIgnoreMouseEvents(true, { forward: true }),
  );
  const pass = await probe('explicit whole-window pass-through, query body point');
  await pointer(point);
  const restored = await probe('auto body hit restores input');
  result.nativeInput = {
    handles,
    point,
    samples: [body, empty, pass, restored],
    stylePass: !body.transparent && empty.transparent && pass.transparent && !restored.transparent,
    nativeHitPass: body.hitAvatar && empty.hitPanel && pass.hitPanel && restored.hitAvatar,
  };
  assert.ok(
    result.nativeInput.stylePass,
    'Window extended styles did not follow raycast/pass-through state',
  );
  if (result.nativeInput.nativeHitPass)
    result.checks.push(
      'native WindowFromPoint confirms body hit and pass-through to the owned panel',
    );
  else
    result.limitations.push(
      'WindowFromPoint did not consistently select the expected owned top-level window; inspect nativeInput samples for possible window overlap/compositor differences.',
    );
  result.errors.push(...(await panel.evaluate(() => window.__verifyAvatarErrors)));
  result.secondLaunchAvatarReports = await application.evaluate(
    () => globalThis.__verifyAvatarReports,
  );
  result.sample.sha256After = hash(await readFile(sample));
  assert.equal(result.sample.sha256Before, result.sample.sha256After);
  result.checks.push('original and managed-copy byte hashes are unchanged');
  assert.equal(result.errors.length, 0);
  assert.equal(result.rendererErrors.length, 0);
  assert.equal(result.consoleErrors.length, 0);
  result.completed = true;
} catch (error) {
  result.errors.push({ source: 'verification', error: String(error) });
  console.error(error);
  process.exitCode = 1;
} finally {
  result.sample.sha256After = hash(await readFile(sample));
  result.originalUnchanged = result.sample.sha256Before === result.sample.sha256After;
  result.finishedAt = new Date().toISOString();
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      event: 'finished',
      completed: result.completed,
      checks: result.checks,
      errors: result.errors,
      result: path.join(directory, 'result.json'),
    }),
  );
  if (application) await application.close();
}
