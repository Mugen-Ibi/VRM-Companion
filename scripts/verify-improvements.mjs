import { _electron as electron } from 'playwright';
import { panelWindow } from './electron-test.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import assert from 'node:assert/strict';

const directory = path.resolve('artifacts/improvements-' + Date.now());
await mkdir(directory, { recursive: true });
const result = { directory, checks: [], models: [], captures: [], errors: [] };
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let application, panel, avatar;
let ownedPids = [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = promisify(execFile);
async function gpu() {
  const { stdout } = await run(
    'nvidia-smi',
    ['--query-gpu=memory.used,utilization.gpu', '--format=csv,noheader,nounits'],
    { windowsHide: true },
  );
  return stdout.trim();
}
async function state() {
  return panel.evaluate(() => window.companion.state());
}
async function waitState(predicate, timeout = 200000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const s = await state();
    if (predicate(s)) return s;
    await sleep(100);
  }
  throw new Error('State timeout: ' + JSON.stringify((await state()).llm));
}
async function choose(method, file) {
  await application.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [selected] });
    dialog.showMessageBox = async () => ({ response: 0 });
  }, file);
  await panel.evaluate((name) => window.companion[name](), method);
}
async function capture(name) {
  const data = await application.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().endsWith('avatar.html'),
    );
    const img = await Promise.race([
      w.webContents.capturePage(undefined, { stayAwake: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('capture timeout')), 10000)),
    ]);
    const bitmap = img.toBitmap();
    let opaque = 0;
    for (let i = 3; i < bitmap.length; i += 4) if (bitmap[i] > 32) opaque++;
    return {
      png: img.toPNG().toString('base64'),
      opaque,
      size: img.getSize(),
      position: w.getPosition(),
      visible: w.isVisible(),
    };
  });
  await writeFile(path.join(directory, name + '.png'), Buffer.from(data.png, 'base64'));
  delete data.png;
  data.renderer = await avatar.evaluate(() => ({ stats: window.__stats, hidden: document.hidden }));
  result.captures.push({ name, ...data });
  assert.ok(data.opaque > 1000, 'avatar must remain visible');
  return data;
}
async function capturePanel(name) {
  const png = await application.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().endsWith('index.html'),
    );
    w.showInactive();
    try {
      // The DOM can be ahead of the last composited frame after a hidden tab change.
      await new Promise((resolve) => setTimeout(resolve, 150));
      const img = await Promise.race([
        w.webContents.capturePage(undefined, { stayAwake: true }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Panel capture timed out')), 10000),
        ),
      ]);
      return img.toPNG().toString('base64');
    } finally {
      w.hide();
    }
  });
  await writeFile(path.join(directory, name + '.png'), Buffer.from(png, 'base64'));
}
try {
  application = await electron.launch({
    ...(process.env.COMPANION_PACKAGE
      ? { executablePath: path.resolve(process.env.COMPANION_PACKAGE) }
      : {}),
    args: [
      ...(process.env.COMPANION_PACKAGE ? [] : ['.']),
      '--user-data-dir=' + path.join(directory, 'state'),
    ],
    env,
  });
  panel = await panelWindow(application);
  panel.on('pageerror', (error) => result.errors.push(error.message));
  await application.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().endsWith('index.html'),
    );
    // Keep trusted UI input stable in this hidden test window; production keeps
    // the panel throttled when hidden. Avatar suspension is tested separately.
    w.webContents.setBackgroundThrottling(false);
    w.hide();
  });
  avatar = application.windows().find((page) => page.url().endsWith('avatar.html'));
  avatar.on('pageerror', (error) => result.errors.push(error.message));
  await avatar.addInitScript(() => {
    window.__stats = { raf: 0, draw: 0 };
    const raf = window.requestAnimationFrame;
    window.requestAnimationFrame = (fn) =>
      raf((time) => {
        window.__stats.raf++;
        fn(time);
      });
    for (const proto of [
      window.WebGLRenderingContext?.prototype,
      window.WebGL2RenderingContext?.prototype,
    ].filter(Boolean))
      for (const name of [
        'drawArrays',
        'drawElements',
        'drawArraysInstanced',
        'drawElementsInstanced',
      ]) {
        const previous = proto[name];
        if (previous)
          proto[name] = function (...args) {
            window.__stats.draw++;
            return previous.apply(this, args);
          };
      }
  });
  await avatar.reload();
  result.gpuBefore = await gpu();
  if (!process.env.COMPANION_AVATAR_ONLY) {
    if (!process.env.COMPANION_MODELS || !process.env.COMPANION_SERVER)
      throw new Error('Set COMPANION_MODELS and COMPANION_SERVER for managed-model verification.');
    await choose('chooseModelDirectory', process.env.COMPANION_MODELS);
    await choose('chooseLlamaServer', process.env.COMPANION_SERVER);
    await panel.evaluate(async () => {
      const s = await window.companion.state();
      await window.companion.settings({
        ...s.settings,
        llmMode: 'managed',
        context: 4096,
        idleUnloadMinutes: 1,
      });
    });
    await panel.locator('[data-tab="settings"]').click();
    assert.equal(await panel.locator('#llmMode').inputValue(), 'managed');
    await capturePanel('settings-models');
    await panel.locator('#motionLevel').selectOption('lively');
    await panel.locator('[data-action="saveSettings"]').first().click();
    await waitState((s) => !s.busy && s.settings.motionLevel === 'lively');
    await panel.locator('[data-tab="chat"]').click();
    const models = (await state()).llm.models;
    assert.ok(models.length >= 2);
    for (const model of [models[0], models.at(-1)]) {
      assert.ok(model, 'local verification model missing');
      const started = Date.now();
      await panel.locator('#chat-model').selectOption(model.id);
      const ready = await waitState((s) => !s.busy && ['ready', 'error'].includes(s.llm.status));
      assert.equal(ready.llm.status, 'ready', ready.llm.error);
      const loadedMs = Date.now() - started;
      await panel.evaluate(async () => {
        const s = await window.companion.state();
        await window.companion.send(
          s.conversations.at(-1).id,
          'こんにちは。日本語の一文で短く挨拶してください。',
        );
      });
      const after = await state(),
        answer = after.conversations.at(-1).messages.at(-1);
      assert.equal(answer.role, 'assistant');
      assert.notEqual(answer.status, 'error', answer.content);
      assert.ok(answer.content.length > 0);
      result.models.push({
        name: model.name,
        loadedMs,
        totalMs: Date.now() - started,
        answer: answer.content,
        gpu: await gpu(),
      });
      console.log(JSON.stringify({ event: 'model-verified', ...result.models.at(-1) }));
    }
    await panel.locator('[data-action="unloadModel"]').click();
    await waitState((s) => !s.busy && s.llm.status === 'unloaded');
    result.gpuAfterUnload = await gpu();
    await capturePanel('chat-models');
    result.checks.push(
      'two real GGUF models selected through the chat UI, each answered; unload completed',
    );
  }
  await choose(
    'importAvatar',
    path.resolve('.local/vrm-fixtures/VRM1_Constraint_Twist_Sample.vrm'),
  );
  await waitState((s) => !!s.settings.avatarId, 30000);
  await sleep(2500);
  await capture('idle');
  for (const gesture of ['wave', 'nod', 'bow', 'stretch']) {
    await panel.evaluate((name) => window.companion.gesture(name), gesture);
    await sleep(gesture === 'stretch' ? 2200 : gesture === 'wave' ? 1600 : 1100);
    await capture(gesture);
  }
  const before = await avatar.evaluate(() => ({ ...window.__stats }));
  // Hold drag state across several compositor captures; release only after all assertions.
  await avatar.evaluate(() => window.avatarHost.dragging(true));
  for (let i = 0; i < 5; i++) {
    await avatar.evaluate(() => window.avatarHost.drag(-10, 0));
    await sleep(80);
    await capture('drag-' + i);
  }
  await avatar.evaluate(() => window.avatarHost.dragging(false));
  const after = await avatar.evaluate(() => ({ ...window.__stats }));
  assert.ok(after.draw > before.draw);
  const moved = result.captures.filter((c) => c.name.startsWith('drag-'));
  assert.ok(moved.every((c) => c.visible));
  assert.equal(moved[0].position[0] - moved.at(-1).position[0], 40);
  result.checks.push(
    'all four gestures render; five captures during held drag keep nontransparent model pixels and continue drawing',
  );
  assert.ok(
    moved.every(
      (c) => c.size.width === moved[0].size.width && c.size.height === moved[0].size.height,
    ),
    'window must not grow while dragging at fractional DPI',
  );
  await avatar.mouse.move(190, 260);
  await sleep(100);
  await avatar.mouse.down();
  const nativeBefore = result.captures.at(-1).position;
  for (let i = 0; i < 4; i++) {
    await avatar.mouse.move(180 - i * 6, 260);
    await sleep(120);
    await capture('pointer-drag-' + i);
  }
  await avatar.mouse.up();
  assert.notDeepEqual(
    result.captures.at(-1).position,
    nativeBefore,
    'pointer drag must move the window',
  );
  result.checks.push('trusted pointer down/move/up keeps the avatar visible before release');
  await panel.evaluate(() => window.companion.hideAvatar());
  await sleep(300);
  const hiddenStart = await avatar.evaluate(() => ({ ...window.__stats }));
  await sleep(2500);
  const hiddenEnd = await avatar.evaluate(() => ({ ...window.__stats }));
  result.hidden = { raf: hiddenEnd.raf - hiddenStart.raf, draw: hiddenEnd.draw - hiddenStart.draw };
  assert.deepEqual(result.hidden, { raf: 0, draw: 0 });
  result.checks.push(
    'hidden avatar: zero animation callbacks and zero WebGL draws over 2.5 seconds',
  );
  if (!process.env.COMPANION_AVATAR_ONLY) {
    const small = (await state()).llm.models.at(0);
    assert.ok(small, 'at least one managed model is required');
    await panel.evaluate((id) => window.companion.selectModel(id), small.id);
    await panel.evaluate(() => window.companion.unloadModel());
    await panel.evaluate(async () => {
      const s = await window.companion.state();
      await window.companion.send(
        s.conversations.at(-1).id,
        'ありがとう。短く返事をしてください。',
      );
    });
    assert.equal(
      (await state()).llm.status,
      'ready',
      'sending after unload must reload the selected model',
    );
    const parent = await application.evaluate(() => process.pid);
    assert.ok(Number.isInteger(parent) && parent > 0);
    const { stdout } = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `@(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${parent}" | Where-Object Name -eq 'llama-server.exe' | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`,
      ],
      { windowsHide: true },
    );
    ownedPids = [].concat(JSON.parse(stdout.trim() || '[]'));
    assert.equal(ownedPids.length, 1);
    result.checks.push(
      'send after unload reloads the selected model; exactly one owned llama-server remains before exit',
    );
  }
  assert.deepEqual(result.errors, []);
  result.completed = true;
} catch (error) {
  result.failure = error.stack;
  process.exitCode = 1;
} finally {
  if (panel && !panel.isClosed())
    await panel.evaluate(() => window.companion.hideAvatar()).catch(() => {});
  await application?.close().catch(() => {});
  if (ownedPids.length) {
    const { stdout } = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `@(Get-Process -Id ${ownedPids.join(',')} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id) | ConvertTo-Json -Compress`,
      ],
      { windowsHide: true },
    );
    result.ownedProcessesAfterExit = [].concat(JSON.parse(stdout.trim() || '[]'));
    if (result.ownedProcessesAfterExit.length) {
      result.completed = false;
      process.exitCode = 1;
    } else result.checks.push('normal app exit stopped its owned llama-server');
  }
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
