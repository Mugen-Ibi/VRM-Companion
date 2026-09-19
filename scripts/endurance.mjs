import { _electron as electron } from 'playwright';
import { panelWindow } from './electron-test.mjs';
import { mkdir, writeFile, appendFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { createFixtures } from './fixtures.mjs';

const duration = Number(process.env.COMPANION_ENDURANCE_MS || 7200000);
if (!Number.isFinite(duration) || duration < 1000) throw new Error('Invalid endurance duration');
const directory = path.resolve('artifacts/endurance-' + Date.now());
await mkdir(directory, { recursive: true });
await createFixtures(path.join(directory, 'models'));
const data = path.join(directory, 'state'),
  env = { ...process.env, COMPANION_TEST_DATA: data };
delete env.ELECTRON_RUN_AS_NODE;
const packaged = process.env.COMPANION_PACKAGE;
const codeRoot = packaged ? path.join(path.dirname(packaged), 'resources/app') : '.';
const bundles = {};
for (const file of ['dist/main/index.cjs', 'dist/renderer/avatar.js', 'dist/renderer/panel.js']) {
  bundles[file] = createHash('sha256')
    .update(await readFile(path.join(codeRoot, file)))
    .digest('hex');
}
const report = {
  started: Date.now(),
  duration,
  bundles,
  packaged: !!packaged,
  samples: [],
  turns: [],
  errors: [],
  events: [],
  completed: false,
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Evaluate has no Playwright operation timeout; a host deadline must detect a hung app.
async function deadline(label, promise, ms = 30000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' exceeded ' + ms + ' ms')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
let writeQueue = Promise.resolve();
function save() {
  const snapshot = JSON.stringify(report, null, 2);
  writeQueue = writeQueue.then(() => writeFile(path.join(directory, 'progress.json'), snapshot));
  return writeQueue;
}
let app,
  panel,
  watch,
  appPid,
  monitor,
  stopping = false,
  monitorFailure;
const main = (fn, arg) => deadline('main evaluate', app.evaluate(fn, arg));
const page = (fn, arg, ms) => deadline('panel evaluate', panel.evaluate(fn, arg), ms);
try {
  app = await electron.launch({
    ...(packaged ? { executablePath: path.resolve(packaged) } : {}),
    args: [...(packaged ? [] : ['.']), '--user-data-dir=' + data],
    env,
    timeout: 30000,
  });
  app.process().on('exit', (code, signal) => {
    report.events.push({
      at: Date.now(),
      event: 'launcher-exit',
      code,
      signal,
      expected: stopping,
    });
  });
  app.process().stderr.on('data', (bytes) => {
    void appendFile(path.join(directory, 'electron-stderr.log'), bytes).catch(() => {});
  });
  appPid = await main(({ app, BrowserWindow }) => {
    globalThis.__enduranceEvents = [];
    const event = (event, details) =>
      globalThis.__enduranceEvents.push({ at: Date.now(), event, details });
    for (const win of BrowserWindow.getAllWindows()) {
      win.on('unresponsive', () => event('unresponsive', { id: win.id }));
      win.on('responsive', () => event('responsive', { id: win.id }));
      win.webContents.on('render-process-gone', (_event, details) =>
        event('renderer-exit', details),
      );
    }
    app.on('child-process-gone', (_event, details) => event('child-exit', details));
    return process.pid;
  });
  report.appPid = appPid;
  report.runtime = await main(() => process.versions);
  panel = await panelWindow(app);
  panel.setDefaultTimeout(20000);
  for (const window of await app.windows())
    window.on('pageerror', (error) =>
      report.errors.push({ type: 'pageerror', url: window.url(), message: error.message }),
    );
  await panel.getByRole('heading', { name: '会話', exact: true }).waitFor();
  await page(async () => {
    const s = await window.companion.state();
    s.settings.outputTokens = 128;
    await window.companion.settings(s.settings);
    await window.companion.connect();
  });
  const selected = [];
  for (const version of [1, 0]) {
    const file =
      version === 1 && process.env.COMPANION_ENDURANCE_VRM
        ? path.resolve(process.env.COMPANION_ENDURANCE_VRM)
        : path.join(directory, 'models', 'fixture-' + version + '.vrm');
    await main(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      dialog.showMessageBox = async () => ({ response: 0 });
    }, file);
    await page(() => window.companion.importAvatar());
    const until = Date.now() + 35000;
    while (true) {
      const state = await page(() => window.companion.state());
      if (
        state.avatars.length === selected.length + 1 &&
        state.settings.avatarId &&
        !selected.includes(state.settings.avatarId)
      ) {
        selected.push(state.settings.avatarId);
        break;
      }
      if (Date.now() > until) throw new Error('VRM loading did not settle');
      await sleep(100);
    }
  }
  async function sample() {
    const value = await main(({ app }) => ({
      metrics: app.getAppMetrics().map((m) => ({
        pid: m.pid,
        type: m.type,
        cpu: m.cpu.percentCPUUsage,
        workingSetKiB: m.memory.workingSetSize,
        peakWorkingSetKiB: m.memory.peakWorkingSetSize,
      })),
      events: globalThis.__enduranceEvents.splice(0),
    }));
    report.events.push(...value.events);
    report.samples.push({
      elapsedMs: Date.now() - report.workloadStarted,
      ...value,
      totalWorkingSetMiB: value.metrics.reduce((sum, m) => sum + m.workingSetKiB, 0) / 1024,
    });
    await save();
  }
  // Keep the avatar visible while avoiding a large test panel over the user's work.
  await main(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().endsWith('/index.html'))
      ?.hide();
  });
  report.panelHidden = true;
  report.workloadStarted = Date.now();
  await sample();
  watch = setInterval(() => {
    if (monitor) return;
    monitor = sample()
      .catch((error) => {
        monitorFailure = error;
        report.errors.push({ type: 'monitor', message: String(error) });
      })
      .finally(() => {
        monitor = undefined;
      });
  }, 10000);
  let iteration = 0;
  while (Date.now() - report.workloadStarted < duration) {
    if (monitorFailure) throw monitorFailure;
    const visibility = await page(() => window.companion.state());
    if (!visibility.avatarVisible || !visibility.settings.avatarVisible) {
      report.interrupted = 'Avatar was hidden. The test did not show it again.';
      throw new Error(report.interrupted);
    }
    const began = Date.now(),
      turn = ++iteration,
      requestedId = selected[turn % 2];
    await page((id) => window.companion.selectAvatar(id), requestedId);
    const until = Date.now() + 35000;
    while ((await page(() => window.companion.state())).settings.avatarId !== requestedId) {
      if (Date.now() > until) throw new Error('Avatar switch did not settle');
      await sleep(100);
    }
    await page(
      async () => {
        const id = await window.companion.newConversation();
        await window.companion.send(id, '日本語で一文だけ、短く挨拶してください。');
      },
      undefined,
      180000,
    );
    const state = await page(() => window.companion.state());
    const answer = state.conversations.at(-1)?.messages.at(-1);
    if (
      state.phase !== 'success' ||
      !answer ||
      answer.role !== 'assistant' ||
      !answer.content.trim()
    )
      throw new Error('Chat turn did not complete successfully');
    report.turns.push({
      iteration: turn,
      elapsedMs: Date.now() - report.workloadStarted,
      requestMs: Date.now() - began,
      phase: state.phase,
      requestedId,
      avatarId: state.settings.avatarId,
    });
    await save();
    console.log(
      JSON.stringify({
        iteration: turn,
        elapsedSeconds: Math.round((Date.now() - report.workloadStarted) / 1000),
        phase: state.phase,
        memoryMiB: Math.round(report.samples.at(-1)?.totalWorkingSetMiB ?? 0),
      }),
    );
    for (
      let wait = Math.min(60000, duration - (Date.now() - report.workloadStarted));
      wait > 0;
      wait -= Math.min(1000, wait)
    ) {
      if (monitorFailure) throw monitorFailure;
      await sleep(Math.min(1000, wait));
    }
  }
  clearInterval(watch);
  if (monitor) await monitor;
  await sample();
  report.workloadElapsedMs = Date.now() - report.workloadStarted;
  const abnormal = report.events.some(
    (event) =>
      event.event === 'unresponsive' ||
      event.event === 'renderer-exit' ||
      (event.event === 'child-exit' && !['clean-exit', 'killed'].includes(event.details?.reason)) ||
      (event.event === 'launcher-exit' && !event.expected),
  );
  report.completed =
    report.workloadElapsedMs >= duration &&
    report.turns.length > 0 &&
    report.errors.length === 0 &&
    !abnormal;
  if (!report.completed) throw new Error('Endurance run contains an abnormal event');
} catch (error) {
  report.completed = false;
  report.errors.push({ type: 'endurance', message: String(error) });
  process.exitCode = 1;
  console.error(error);
} finally {
  clearInterval(watch);
  stopping = true;
  if (app) {
    try {
      await deadline('close owned test application', app.close(), 15000);
    } catch (error) {
      report.completed = false;
      report.errors.push({ type: 'shutdown', message: String(error) });
      process.exitCode = 1;
      if (appPid && app.process().exitCode === null)
        await new Promise((resolve) =>
          execFile(
            'taskkill',
            ['/PID', String(appPid), '/T', '/F'],
            { windowsHide: true, timeout: 15000 },
            (error, stdout, stderr) => {
              report.events.push({
                at: Date.now(),
                event: 'forced-cleanup',
                ok: !error,
                stdout,
                stderr,
              });
              resolve();
            },
          ),
        );
    }
  }
  if (monitor) await monitor;
  report.elapsedMs = Date.now() - report.started;
  await save();
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log('Endurance result: ' + directory);
}
