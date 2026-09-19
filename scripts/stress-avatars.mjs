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
  directory = path.resolve('artifacts/stress-avatars-' + Date.now()),
  data = path.join(directory, 'state');
await mkdir(directory, { recursive: true });
await createFixtures(path.join(directory, 'models'));
const official = path.resolve('.local/vrm-fixtures/VRM1_Constraint_Twist_Sample.vrm'),
  tiny = path.join(directory, 'models', 'fixture-0.vrm');
const hash = (buffer) => createHash('sha256').update(buffer).digest('hex'),
  sourceHashes = { official: hash(await readFile(official)), tiny: hash(await readFile(tiny)) };
const report = {
  startedAt: new Date().toISOString(),
  completed: false,
  directory,
  config: { switches: 100, dwellMs: 400, maxRunMs: 240000, modelLoadTimeoutMs: 10000 },
  methodology:
    '100 alternating model switches (50 round trips), waiting for committed selection and continued WebGL draws, then 400ms dwell. No forced garbage collection. WebGL resource counts track explicit create/delete calls; ImageBitmap create/close counts do not count garbage-collected images and must not be treated as exact live memory. All process working sets belong to this isolated Electron app; no LLM requests are made.',
  sourceHashes,
  samples: [],
  events: [],
  errors: [],
  consoleWarnings: [],
  processExit: null,
  summary: null,
};
const env = { ...process.env, COMPANION_TEST_DATA: data };
delete env.ELECTRON_RUN_AS_NODE;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function bounded(promise, label, ms = 10000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' timed out')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function resourceProbe() {
  const counters = {
    draws: 0,
    texturesCreated: 0,
    texturesDeleted: 0,
    buffersCreated: 0,
    buffersDeleted: 0,
    programsCreated: 0,
    programsDeleted: 0,
    imageBitmapsCreated: 0,
    imageBitmapsExplicitlyClosed: 0,
  };
  for (const prototype of [
    globalThis.WebGLRenderingContext?.prototype,
    globalThis.WebGL2RenderingContext?.prototype,
  ].filter(Boolean)) {
    for (const name of [
      'drawArrays',
      'drawElements',
      'drawArraysInstanced',
      'drawElementsInstanced',
    ]) {
      const original = prototype[name];
      if (typeof original === 'function')
        prototype[name] = function () {
          counters.draws++;
          return original.apply(this, arguments);
        };
    }
    for (const [kind, label] of [
      ['Texture', 'textures'],
      ['Buffer', 'buffers'],
      ['Program', 'programs'],
    ]) {
      const created = new WeakSet(),
        deleted = new WeakSet(),
        make = prototype['create' + kind],
        remove = prototype['delete' + kind];
      prototype['create' + kind] = function () {
        const object = make.apply(this, arguments);
        if (object) {
          created.add(object);
          counters[label + 'Created']++;
        }
        return object;
      };
      prototype['delete' + kind] = function (object) {
        if (object && created.has(object) && !deleted.has(object)) {
          deleted.add(object);
          counters[label + 'Deleted']++;
        }
        return remove.apply(this, arguments);
      };
    }
  }
  const create = globalThis.createImageBitmap.bind(globalThis);
  globalThis.createImageBitmap = async (...args) => {
    const image = await create(...args);
    counters.imageBitmapsCreated++;
    return image;
  };
  const close = ImageBitmap.prototype.close,
    closed = new WeakSet();
  ImageBitmap.prototype.close = function () {
    if (!closed.has(this)) {
      closed.add(this);
      counters.imageBitmapsExplicitlyClosed++;
    }
    return close.apply(this, arguments);
  };
  globalThis.__avatarStressProbe = () => ({
    ...counters,
    usedJSHeapBytes: performance.memory?.usedJSHeapSize,
    totalJSHeapBytes: performance.memory?.totalJSHeapSize,
  });
}
let application,
  panel,
  avatar,
  closing = false;
const started = Date.now();
async function state() {
  return bounded(
    panel.evaluate(() => window.companion.state()),
    'panel state',
  );
}
async function waitForSelection(predicate) {
  const deadline = Date.now() + report.config.modelLoadTimeoutMs;
  while (Date.now() < deadline) {
    const current = await state();
    if (predicate(current)) return current;
    await sleep(25);
  }
  throw new Error('Model load did not commit before timeout');
}
async function snapshot(iteration, model, loadMs) {
  const [resources, processes, events] = await Promise.all([
    bounded(
      avatar.evaluate(() => window.__avatarStressProbe()),
      'avatar resource probe',
    ),
    bounded(
      application.evaluate(({ app }) =>
        app.getAppMetrics().map((metric) => ({
          pid: metric.pid,
          type: metric.type,
          cpuPercent: metric.cpu.percentCPUUsage,
          workingSetKiB: metric.memory.workingSetSize,
          peakWorkingSetKiB: metric.memory.peakWorkingSetSize,
        })),
      ),
      'process metrics',
    ),
    bounded(
      application.evaluate(() => globalThis.__avatarStressEvents),
      'process events',
    ),
  ]);
  const sample = {
    iteration,
    model,
    loadMs,
    elapsedMs: Date.now() - started,
    resources,
    totalWorkingSetMiB: processes.reduce((sum, metric) => sum + metric.workingSetKiB, 0) / 1024,
    processes,
  };
  report.samples.push(sample);
  report.events = events;
  return sample;
}
async function importModel(file) {
  const old = (await state()).settings.avatarId;
  await application.evaluate(({ dialog }, target) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [target] });
    dialog.showMessageBox = async () => ({ response: 0 });
  }, file);
  await bounded(
    panel.evaluate(() => window.companion.importAvatar()),
    'import dialog',
  );
  return (
    await waitForSelection(
      (current) => !!current.settings.avatarId && current.settings.avatarId !== old,
    )
  ).settings.avatarId;
}
try {
  application = await electron.launch({
    args: ['.', '--user-data-dir=' + data],
    env,
    timeout: 30000,
  });
  application.process().on('exit', (code, signal) => {
    report.processExit = { at: new Date().toISOString(), code, signal, expected: closing };
  });
  panel = await panelWindow(application);
  await panel.waitForFunction(() => !!window.companion);
  avatar = (await application.windows()).find((window) => window.url().endsWith('avatar.html'));
  assert.ok(avatar);
  for (const [name, page] of [
    ['panel', panel],
    ['avatar', avatar],
  ]) {
    page.on('pageerror', (error) => report.errors.push({ source: name, error: error.message }));
    page.on('crash', () => report.errors.push({ source: name, error: 'renderer crash' }));
    page.on('close', () => {
      if (!closing) report.errors.push({ source: name, error: 'unexpected page close' });
    });
    page.on('console', (message) => {
      if (message.type() === 'error') report.errors.push({ source: name, error: message.text() });
      if (message.type() === 'warning' && !report.consoleWarnings.includes(message.text()))
        report.consoleWarnings.push(message.text());
    });
  }
  await application.evaluate(({ app, BrowserWindow }) => {
    globalThis.__avatarStressEvents = [];
    app.on('render-process-gone', (_event, webContents, details) =>
      globalThis.__avatarStressEvents.push({
        type: 'render-process-gone',
        url: webContents.getURL(),
        ...details,
      }),
    );
    app.on('child-process-gone', (_event, details) =>
      globalThis.__avatarStressEvents.push({ type: 'child-process-gone', ...details }),
    );
    for (const window of BrowserWindow.getAllWindows())
      window.on('unresponsive', () =>
        globalThis.__avatarStressEvents.push({
          type: 'unresponsive',
          url: window.webContents.getURL(),
          at: Date.now(),
        }),
      );
  });
  await avatar.addInitScript(resourceProbe);
  await avatar.reload();
  await avatar.waitForFunction(() => !!window.__avatarStressProbe);
  const ids = { tiny: await importModel(tiny), official: await importModel(official) };
  await sleep(1000);
  await snapshot(0, 'official', 0);
  console.log(JSON.stringify({ event: 'started', directory, ids }));
  for (let index = 1; index <= report.config.switches; index++) {
    if (Date.now() - started > report.config.maxRunMs)
      throw new Error('Stress test exceeded its four-minute working budget');
    const model = index % 2 ? 'tiny' : 'official',
      id = ids[model],
      begin = Date.now();
    await bounded(
      panel.evaluate((value) => window.companion.selectAvatar(value), id),
      'select model',
    );
    await waitForSelection((current) => current.settings.avatarId === id);
    const before = await bounded(
      avatar.evaluate(() => window.__avatarStressProbe().draws),
      'draw baseline',
    );
    await avatar.waitForFunction((value) => window.__avatarStressProbe().draws > value, before, {
      timeout: 5000,
    });
    const loadMs = Date.now() - begin;
    await sleep(report.config.dwellMs);
    const sample = await snapshot(index, model, loadMs);
    if (report.events.length || report.errors.length)
      throw new Error('Unexpected renderer/process event; see recorded diagnostics');
    if (index % 10 === 0) {
      await writeFile(path.join(directory, 'progress.json'), JSON.stringify(report, null, 2));
      console.log(
        JSON.stringify({
          event: 'progress',
          iteration: index,
          elapsedSeconds: Math.round(sample.elapsedMs / 1000),
          memoryMiB: Math.round(sample.totalWorkingSetMiB),
          texturesRetained: sample.resources.texturesCreated - sample.resources.texturesDeleted,
          bitmapsCreated: sample.resources.imageBitmapsCreated,
          bitmapsExplicitlyClosed: sample.resources.imageBitmapsExplicitlyClosed,
        }),
      );
    }
  }
  await sleep(10000);
  await snapshot(101, 'official-cooldown', 0);
  const mean = (items) => items.reduce((sum, item) => sum + item, 0) / items.length;
  report.summary = {
    elapsedMs: Date.now() - started,
    switchesCompleted: report.samples.filter(
      (sample) => sample.iteration >= 1 && sample.iteration <= 100,
    ).length,
    maxWorkingSetMiB: Math.max(...report.samples.map((sample) => sample.totalWorkingSetMiB)),
    perModel: Object.fromEntries(
      ['tiny', 'official'].map((model) => {
        const rows = report.samples.filter(
            (sample) => sample.model === model && sample.iteration > 0,
          ),
          first = rows.slice(0, 5),
          last = rows.slice(-5);
        return [
          model,
          {
            firstFiveMeanMiB: mean(first.map((row) => row.totalWorkingSetMiB)),
            lastFiveMeanMiB: mean(last.map((row) => row.totalWorkingSetMiB)),
            growthMiB:
              mean(last.map((row) => row.totalWorkingSetMiB)) -
              mean(first.map((row) => row.totalWorkingSetMiB)),
            firstResources: first[0].resources,
            lastResources: last.at(-1).resources,
          },
        ];
      }),
    ),
    cooldown: report.samples.at(-1),
  };
  assert.equal(hash(await readFile(official)), sourceHashes.official);
  assert.equal(hash(await readFile(tiny)), sourceHashes.tiny);
  report.originalsUnchanged = true;
  report.completed = true;
} catch (error) {
  report.errors.push({ source: 'stress', error: String(error) });
  console.error(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  report.originalsUnchanged =
    hash(await readFile(official)) === sourceHashes.official &&
    hash(await readFile(tiny)) === sourceHashes.tiny;
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
  if (application) {
    closing = true;
    try {
      await bounded(application.close(), 'owned test app shutdown', 10000);
    } catch (error) {
      report.errors.push({ source: 'cleanup', error: String(error) });
      try {
        await runFile('taskkill.exe', ['/PID', String(application.process().pid), '/T', '/F'], {
          windowsHide: true,
          timeout: 10000,
        });
        report.cleanup =
          'terminated only the recorded test launcher subtree after graceful shutdown timeout';
      } catch (cleanupError) {
        report.errors.push({ source: 'cleanup', error: String(cleanupError) });
      }
    }
  }
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      event: 'finished',
      completed: report.completed,
      result: path.join(directory, 'result.json'),
      errors: report.errors,
      summary: report.summary && {
        switches: report.summary.switchesCompleted,
        maxMiB: report.summary.maxWorkingSetMiB,
        elapsedMs: report.summary.elapsedMs,
      },
    }),
  );
}
