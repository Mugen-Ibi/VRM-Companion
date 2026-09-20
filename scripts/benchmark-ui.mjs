import { _electron as electron } from 'playwright';
import { panelWindow } from './electron-test.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import os from 'node:os';
import path from 'node:path';
import { createFixtures } from './fixtures.mjs';

const number = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid ${name}`);
  return value;
};
const config = {
  warmupMs: number('COMPANION_BENCH_WARMUP_MS', 30000),
  idleMs: number('COMPANION_BENCH_IDLE_MS', 300000),
  inferenceMs: number('COMPANION_BENCH_INFERENCE_MS', 300000),
  inferenceRequests: Math.min(20, number('COMPANION_BENCH_REQUESTS', 15)),
  endpoint: 'http://127.0.0.1:8080',
  fps: 30,
  outputTokens: 128,
  sampleIntervalMs: 1000,
  memoryIntervalMs: 10000,
  screenshots: process.env.COMPANION_BENCH_SCREENSHOTS === '1',
};
const directory = path.resolve('artifacts/benchmark-ui-' + Date.now());
await mkdir(directory, { recursive: true });
await createFixtures(path.join(directory, 'models'));
const bundles = {};
for (const file of ['dist/main/index.cjs', 'dist/renderer/avatar.js', 'dist/renderer/panel.js'])
  bundles[file] = createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
const report = {
  startedAt: new Date().toISOString(),
  completed: false,
  directory,
  config,
  environment: {
    platform: process.platform,
    release: os.release(),
    cpu: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length,
    systemMemoryGiB: os.totalmem() / 1024 ** 3,
    bundles,
  },
  methodology: {
    model:
      'Procedural fixture-1.vrm only: low-poly untextured humanoid. Results do not represent a complex user VRM.',
    drawing:
      'Color-buffer WebGL clear calls approximate renderer.render frames for this fixture, which uses the default framebuffer and no shadows. Draw calls and requestAnimationFrame callbacks are counted separately. Frame intervals are CPU-side submission spacing, not GPU completion or screen presentation timing.',
    ui: 'Host Playwright evaluate round-trip with a synchronous DOM event dispatch in the panel. Includes host/CDP/renderer scheduling; does not claim click-to-paint latency.',
    memory:
      'Electron app.getAppMetrics workingSetSize per owned process and summed working set. Excludes the externally owned llama-server and does not measure GPU VRAM.',
    inference:
      'At most 15 requests by default, no concurrent requests from this script. Each goes through the application direct chat route (v0.0.0.3+). A separate endurance run may also use the same server. Busy-only samples are reported separately from the full inference stage.',
    hidden:
      'Hide only the benchmark avatar BrowserWindow; verify visible:false from avatarHost and no subsequent WebGL color clears/draw calls.',
  },
  stages: [],
  requests: [],
  errors: [],
  consoleErrors: [],
  hiddenCheck: null,
  connection: null,
};
const save = () =>
  writeFile(path.join(directory, 'progress.json'), JSON.stringify(report, null, 2));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const summary = (values) => {
  if (!values.length) return { count: 0 };
  const sorted = [...values].sort((a, b) => a - b),
    at = (q) => sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)];
  return {
    count: values.length,
    min: sorted[0],
    median: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: sorted.at(-1),
    mean: values.reduce((a, b) => a + b, 0) / values.length,
  };
};
function installGLProbe() {
  let clearCount = 0,
    drawCount = 0,
    rafCount = 0,
    lastClear = null,
    frameIntervals = [],
    visiblePayload = null;
  const prototypes = [
    globalThis.WebGLRenderingContext?.prototype,
    globalThis.WebGL2RenderingContext?.prototype,
  ].filter(Boolean);
  for (const prototype of prototypes) {
    const clear = prototype.clear;
    prototype.clear = function (mask) {
      if (mask & this.COLOR_BUFFER_BIT) {
        const now = performance.now();
        if (lastClear !== null) frameIntervals.push(now - lastClear);
        lastClear = now;
        clearCount++;
      }
      return clear.apply(this, arguments);
    };
    for (const name of [
      'drawArrays',
      'drawElements',
      'drawArraysInstanced',
      'drawElementsInstanced',
    ]) {
      const draw = prototype[name];
      if (typeof draw === 'function')
        prototype[name] = function () {
          drawCount++;
          return draw.apply(this, arguments);
        };
    }
  }
  const raf = globalThis.requestAnimationFrame.bind(globalThis);
  globalThis.requestAnimationFrame = (callback) =>
    raf((time) => {
      rafCount++;
      callback(time);
    });
  globalThis.__companionGLProbe = {
    snapshot(drain = false) {
      const result = {
        clearCount,
        drawCount,
        rafCount,
        frameIntervals: [...frameIntervals],
        visiblePayload,
        documentHidden: document.hidden,
      };
      if (drain) frameIntervals = [];
      return result;
    },
    reset() {
      clearCount = 0;
      drawCount = 0;
      rafCount = 0;
      lastClear = null;
      frameIntervals = [];
    },
    visibility(value) {
      visiblePayload = value;
    },
  };
}
const env = { ...process.env, COMPANION_TEST_DATA: path.join(directory, 'state') };
delete env.ELECTRON_RUN_AS_NODE;
let application, panel, avatar;
await save();
console.log(JSON.stringify({ event: 'launching', directory }));
try {
  application = await electron.launch({ args: ['.'], env, timeout: 30000 });
  console.log(JSON.stringify({ event: 'launched', pid: application.process().pid }));
  panel = await panelWindow(application);
  await panel.waitForFunction(() => !!window.companion);
  avatar = (await application.windows()).find((window) => window.url().endsWith('avatar.html'));
  if (!avatar) throw new Error('Avatar window not found');
  for (const [name, page] of [
    ['panel', panel],
    ['avatar', avatar],
  ]) {
    page.on('pageerror', (error) =>
      report.errors.push({ at: new Date().toISOString(), source: name, message: error.message }),
    );
    page.on('console', (message) => {
      if (message.type() === 'error')
        report.consoleErrors.push({ source: name, message: message.text().slice(0, 1000) });
    });
  }
  await avatar.addInitScript(installGLProbe);
  await avatar.reload();
  await avatar.waitForFunction(() => !!window.avatarHost && !!window.__companionGLProbe);
  await avatar.evaluate(async () => {
    window.avatarHost.onUpdate((value) => window.__companionGLProbe.visibility(value.visible));
    window.__companionGLProbe.visibility((await window.avatarHost.state()).visible);
  });
  await panel.evaluate(async () => {
    window.__companionBenchmarkBusy = false;
    window.companion.onEvent((event) => {
      if (event.type === 'state' || event.type === 'update')
        window.__companionBenchmarkBusy = event.state.busy;
    });
  });
  await panel.evaluate(async (settings) => {
    const state = await window.companion.state();
    await window.companion.settings({
      ...state.settings,
      endpoint: settings.endpoint,
      model: '',
      fps: settings.fps,
      outputTokens: settings.outputTokens,
      saveHistory: false,
    });
  }, config);
  try {
    const result = await panel.evaluate(() => window.companion.connect());
    report.connection = { ok: true, ...result };
  } catch (error) {
    report.connection = { ok: false, error: String(error) };
    report.errors.push({ source: 'connection', message: String(error) });
  }
  await application.evaluate(
    ({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    },
    path.join(directory, 'models', 'fixture-1.vrm'),
  );
  await panel.evaluate(() => window.companion.importAvatar());
  await panel.waitForFunction(async () => !!(await window.companion.state()).settings.avatarId);
  await avatar.waitForFunction(() => window.__companionGLProbe.snapshot().drawCount > 0);
  console.log(
    JSON.stringify({ event: 'started', directory, pid: application.process().pid, config }),
  );
  await save();
  for (let remaining = config.warmupMs; remaining > 0; remaining -= Math.min(remaining, 1000))
    await sleep(Math.min(remaining, 1000));

  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().endsWith('avatar.html'))
      .hide(),
  );
  await avatar.waitForFunction(
    () => window.__companionGLProbe.snapshot().visiblePayload === false,
    {},
    { timeout: 10000 },
  );
  await sleep(250);
  const hiddenBefore = await avatar.evaluate(() => window.__companionGLProbe.snapshot());
  await sleep(3000);
  const hiddenAfter = await avatar.evaluate(() => window.__companionGLProbe.snapshot());
  report.hiddenCheck = {
    durationMs: 3000,
    visiblePayload: hiddenAfter.visiblePayload,
    documentHidden: hiddenAfter.documentHidden,
    clearDelta: hiddenAfter.clearCount - hiddenBefore.clearCount,
    drawDelta: hiddenAfter.drawCount - hiddenBefore.drawCount,
    rafDelta: hiddenAfter.rafCount - hiddenBefore.rafCount,
    passed:
      hiddenAfter.visiblePayload === false &&
      hiddenAfter.clearCount === hiddenBefore.clearCount &&
      hiddenAfter.drawCount === hiddenBefore.drawCount,
  };
  if (!report.hiddenCheck.passed)
    report.errors.push({
      source: 'hidden-check',
      message: 'Hidden avatar continued WebGL drawing or visible:false was not observed.',
    });
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()
      .find((window) => window.webContents.getURL().endsWith('avatar.html'))
      .showInactive(),
  );
  await avatar.waitForFunction(() => window.__companionGLProbe.snapshot().visiblePayload === true);
  await sleep(1000);

  async function runStage(name, durationMs, withInference) {
    await avatar.evaluate(() => window.__companionGLProbe.reset());
    const stage = {
      name,
      startedAt: new Date().toISOString(),
      requestedDurationMs: durationMs,
      samples: [],
      memory: [],
      summary: null,
    };
    report.stages.push(stage);
    const started = performance.now(),
      deadline = started + durationMs;
    let stop = false,
      nextMemory = started,
      nextProgress = started,
      activeRequest = false;
    const inference = withInference
      ? (async () => {
          const spacing = durationMs / Math.max(config.inferenceRequests, 1);
          for (let index = 0; index < config.inferenceRequests && !stop; index++) {
            while (!stop && performance.now() < started + index * spacing)
              await sleep(Math.min(1000, started + index * spacing - performance.now()));
            if (stop || performance.now() >= deadline) break;
            const request = {
              index: index + 1,
              startedAt: new Date().toISOString(),
              elapsedInStageMs: performance.now() - started,
              ok: false,
            };
            const requestStart = performance.now();
            activeRequest = true;
            try {
              const result = await panel.evaluate(async () => {
                const id = await window.companion.newConversation();
                await window.companion.send(
                  id,
                  '日本語で「今日もよろしくお願いします。」と一文だけ答えてください。説明は不要です。',
                );
                const state = await window.companion.state();
                const conversation = state.conversations.find((item) => item.id === id);
                return {
                  phase: state.phase,
                  response: conversation.messages
                    .filter((message) => message.role === 'assistant')
                    .map((message) => ({ content: message.content, status: message.status })),
                };
              });
              request.ok = true;
              request.result = result;
            } catch (error) {
              request.error = String(error);
              request.canceledAtMeasurementEnd = stop;
              if (!stop)
                report.errors.push({
                  source: 'inference',
                  index: index + 1,
                  message: String(error),
                });
            } finally {
              activeRequest = false;
              request.elapsedMs = performance.now() - requestStart;
              report.requests.push(request);
            }
          }
        })()
      : Promise.resolve();
    let previousClears = 0,
      previousDraws = 0,
      previousRaf = 0;
    while (performance.now() < deadline) {
      const tick = performance.now();
      const uiStart = performance.now();
      const ui = await panel.evaluate(() => {
        document.dispatchEvent(new Event('companion-benchmark-probe'));
        return {
          busy: window.__companionBenchmarkBusy,
          phase: document.querySelector('.pill')?.textContent,
        };
      });
      const uiRoundTripMs = performance.now() - uiStart,
        gl = await avatar.evaluate(() => window.__companionGLProbe.snapshot(true));
      stage.samples.push({
        elapsedMs: performance.now() - started,
        uiRoundTripMs,
        busy: ui.busy,
        phase: ui.phase,
        clearDelta: gl.clearCount - previousClears,
        drawDelta: gl.drawCount - previousDraws,
        rafDelta: gl.rafCount - previousRaf,
        frameIntervalsMs: gl.frameIntervals,
      });
      previousClears = gl.clearCount;
      previousDraws = gl.drawCount;
      previousRaf = gl.rafCount;
      if (performance.now() >= nextMemory) {
        const processes = await application.evaluate(({ app }) =>
          app.getAppMetrics().map((metric) => ({
            pid: metric.pid,
            type: metric.type,
            cpuPercent: metric.cpu.percentCPUUsage,
            workingSetKiB: metric.memory.workingSetSize,
            peakWorkingSetKiB: metric.memory.peakWorkingSetSize,
          })),
        );
        stage.memory.push({
          elapsedMs: performance.now() - started,
          totalWorkingSetMiB: processes.reduce((sum, item) => sum + item.workingSetKiB, 0) / 1024,
          processes,
        });
        nextMemory = performance.now() + config.memoryIntervalMs;
      }
      if (performance.now() >= nextProgress) {
        console.log(
          JSON.stringify({
            event: 'progress',
            stage: name,
            elapsedSeconds: Math.round((performance.now() - started) / 1000),
            completedRequests: report.requests.length,
            memoryMiB: Math.round(stage.memory.at(-1)?.totalWorkingSetMiB ?? 0),
          }),
        );
        await save();
        nextProgress = performance.now() + 30000;
      }
      await sleep(
        Math.max(
          0,
          Math.min(
            config.sampleIntervalMs - (performance.now() - tick),
            deadline - performance.now(),
          ),
        ),
      );
    }
    stop = true;
    if (activeRequest) await panel.evaluate(() => window.companion.cancel());
    await inference;
    const gl = await avatar.evaluate(() => window.__companionGLProbe.snapshot(true)),
      actualDurationMs = performance.now() - started;
    stage.tailFrameIntervalsMs = gl.frameIntervals;
    const allFrames = [
        ...stage.samples.flatMap((sample) => sample.frameIntervalsMs),
        ...gl.frameIntervals,
      ],
      busySamples = stage.samples.filter((sample) => sample.busy);
    stage.summary = {
      actualDurationMs,
      colorBufferClearCount: gl.clearCount,
      drawCallCount: gl.drawCount,
      rafCallbackCount: gl.rafCount,
      observedColorClearFps: gl.clearCount / (actualDurationMs / 1000),
      frameIntervalMs: summary(allFrames),
      uiRoundTripMs: summary(stage.samples.map((sample) => sample.uiRoundTripMs)),
      busyOnlyUiRoundTripMs: summary(busySamples.map((sample) => sample.uiRoundTripMs)),
      busyOnlyFrameIntervalMs: summary(busySamples.flatMap((sample) => sample.frameIntervalsMs)),
      totalWorkingSetMiB: summary(stage.memory.map((sample) => sample.totalWorkingSetMiB)),
    };
    await save();
    console.log(JSON.stringify({ event: 'stage-complete', stage: name, summary: stage.summary }));
  }
  await runStage('idle', config.idleMs, false);
  await runStage('real-llm-inference', config.inferenceMs, true);
  report.completed = true;
  report.measurementFinishedAt = new Date().toISOString();
  report.screenshotResults = [];
  // Screenshots are optional diagnostics; compositor capture failures must not
  // invalidate a completed measurement or erase its numerical results.
  if (config.screenshots)
    for (const [name, page] of [
      ['panel', panel],
      ['avatar', avatar],
    ]) {
      try {
        await page.screenshot({ path: path.join(directory, name + '-final.png'), timeout: 10000 });
        report.screenshotResults.push({ window: name, ok: true });
      } catch (error) {
        report.screenshotResults.push({ window: name, ok: false, error: String(error) });
      }
    }
  report.finishedAt = new Date().toISOString();
} catch (error) {
  report.errors.push({ source: 'benchmark', message: String(error) });
  report.finishedAt = new Date().toISOString();
  process.exitCode = 1;
  console.error(error);
} finally {
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log('Benchmark result: ' + path.join(directory, 'result.json'));
  if (application) await application.close();
}
