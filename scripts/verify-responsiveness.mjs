import { _electron as electron } from 'playwright';
import { panelWindow } from './electron-test.mjs';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createFixtures } from './fixtures.mjs';

const directory = path.resolve('artifacts/responsiveness-' + Date.now());
const data = path.join(directory, 'state');
await mkdir(directory, { recursive: true });
await createFixtures(path.join(directory, 'models'));
const bundleHashes = {};
for (const file of ['dist/main/index.cjs', 'dist/renderer/panel.js', 'dist/renderer/avatar.js'])
  bundleHashes[file] = createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
const report = {
  startedAt: new Date().toISOString(),
  completed: false,
  directory,
  config: { rounds: 5, measuredOperations: 25, streamIntervalMs: 30, thresholdMs: 200 },
  methodology: {
    latency:
      't0 = performance.now() in a capture listener for the actual trusted input/click event delivered to the target DOM element. t1 = performance.now() in requestAnimationFrame after the expected DOM condition has been observed and rechecked. Host Playwright/CDP action dispatch time before DOM event delivery is excluded.',
    limitations:
      'This is DOM-event-to-DOM-and-rAF latency, not physical-input latency, GPU completion, compositor presentation, or screen click-to-paint latency. Each fill replaces a short string in one trusted input event; it does not simulate IME composition. Five stop samples and ten samples per other category are a limited sample, not long-duration certification.',
    load: 'Isolated real Electron app with a tiny untextured VRM 1 fixture. A private loopback mock SSE server emits a short text delta every 30 ms and keeps the stream open until the measured stop click cancels it. This exercises busy-state IPC and streamed DOM updates, not actual model inference or llama.cpp CPU/GPU load. No requests are sent to the existing server or endurance app.',
    percentile: 'Nearest-rank p95 = sorted[ceil(n * 0.95) - 1].',
  },
  bundleHashes,
  samples: [],
  streams: [],
  errors: [],
  processExit: null,
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function bounded(promise, label, timeoutMs = 10000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' timed out')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function until(predicate, label, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await sleep(20);
  }
  throw new Error(label + ' timed out');
}
const activeStreams = new Set();
const server = createServer(async (req, res) => {
  try {
    if (req.url === '/health' || req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify(
          req.url === '/health' ? { status: 'ok' } : { data: [{ id: 'held-stream-ui-test' }] },
        ),
      );
      return;
    }
    if (req.url === '/apply-template' || req.url === '/tokenize') {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    const request = JSON.parse(body);
    if (request.response_format) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({ intent: 'chat', method: null, target: 'unspecified' }),
              },
            },
          ],
        }),
      );
      return;
    }
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(request.stream, true);
    const stream = {
      id: report.streams.length + 1,
      startedAt: new Date().toISOString(),
      closedAt: null,
      chunks: 0,
    };
    report.streams.push(stream);
    activeStreams.add(stream.id);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    const emit = () => {
      stream.chunks++;
      res.write(
        'data: ' + JSON.stringify({ choices: [{ delta: { content: '応答中 ' } }] }) + '\n\n',
      );
    };
    emit();
    const timer = setInterval(emit, report.config.streamIntervalMs);
    res.on('close', () => {
      clearInterval(timer);
      activeStreams.delete(stream.id);
      stream.closedAt = new Date().toISOString();
    });
  } catch (error) {
    report.errors.push({ source: 'mock-server', error: String(error) });
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
report.mockEndpoint = `http://127.0.0.1:${server.address().port}`;

// This observer runs in the real renderer, without changing the application bundle.
function installProbe() {
  let busy = false,
    armed = null;
  const results = [];
  window.companion.onEvent((event) => {
    if (event.type === 'state' || event.type === 'update') busy = event.state.busy;
  });
  void window.companion.state().then((state) => {
    busy = state.busy;
  });
  window.__responseProbe = {
    results,
    arm(definition) {
      if (armed) throw new Error('Previous operation is still armed');
      armed = definition;
    },
  };
  const matches = (definition) => {
    if (definition.kind === 'input')
      return document.querySelector(definition.selector)?.value === definition.expected;
    if (definition.kind === 'tab')
      return (
        document.querySelector('h1')?.textContent === definition.expected &&
        document.querySelector(definition.selector)?.classList.contains('active')
      );
    return (
      document.querySelector('.pill')?.textContent === '停止' &&
      !!document.querySelector('[data-action="send"]') &&
      !document.querySelector('[data-action="cancel"]') &&
      !busy
    );
  };
  const listen = (event) => {
    if (
      !armed ||
      armed.event !== event.type ||
      !(event.target instanceof Element) ||
      !event.target.closest(armed.selector)
    )
      return;
    const definition = armed;
    armed = null;
    const sample = {
      id: definition.id,
      kind: definition.kind,
      round: definition.round,
      trusted: event.isTrusted,
      eventType: event.type,
      inputType: event.inputType ?? null,
      busyAtEvent: busy,
      phaseAtEvent: document.querySelector('.pill')?.textContent,
      t0Ms: performance.now(),
      timeOriginMs: performance.timeOrigin,
      observedAtMs: null,
      t1Ms: null,
      latencyMs: null,
      error: null,
    };
    let finished = false,
      pendingFrame = false,
      fallbackFrame = null;
    const cleanup = () => {
      finished = true;
      observer.disconnect();
      clearTimeout(timer);
      if (fallbackFrame !== null) cancelAnimationFrame(fallbackFrame);
    };
    const inspect = () => {
      if (finished || pendingFrame || !matches(definition)) return;
      sample.observedAtMs ??= performance.now();
      pendingFrame = true;
      requestAnimationFrame(() => {
        pendingFrame = false;
        if (finished) return;
        if (!matches(definition)) return;
        sample.t1Ms = performance.now();
        sample.latencyMs = sample.t1Ms - sample.t0Ms;
        cleanup();
        results.push(sample);
      });
    };
    const observer = new MutationObserver(inspect);
    observer.observe(document.querySelector('#app'), {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    const timer = setTimeout(() => {
      if (!finished) {
        sample.error = 'Expected DOM condition/rAF timed out';
        cleanup();
        results.push(sample);
      }
    }, 5000);
    const checkFrame = () => {
      inspect();
      if (!finished) fallbackFrame = requestAnimationFrame(checkFrame);
    };
    queueMicrotask(inspect);
    fallbackFrame = requestAnimationFrame(checkFrame);
  };
  document.addEventListener('input', listen, true);
  document.addEventListener('click', listen, true);
}
let application,
  panel,
  closing = false;
try {
  const env = { ...process.env, COMPANION_TEST_DATA: data };
  delete env.ELECTRON_RUN_AS_NODE;
  report.appLaunchStartedAt = new Date().toISOString();
  application = await electron.launch({
    args: ['.', '--user-data-dir=' + data],
    env,
    timeout: 30000,
  });
  report.testLauncherPid = application.process().pid;
  application.process().on('exit', (code, signal) => {
    report.processExit = { at: new Date().toISOString(), code, signal, expected: closing };
  });
  panel = await panelWindow(application);
  for (const page of await application.windows()) {
    page.on('pageerror', (error) =>
      report.errors.push({ source: page.url(), error: error.message }),
    );
    page.on('crash', () => report.errors.push({ source: page.url(), error: 'renderer crash' }));
  }
  await panel.locator('#message-input').waitFor();
  await panel.evaluate(async (endpoint) => {
    const state = await window.companion.state();
    await window.companion.settings({
      ...state.settings,
      endpoint,
      model: '',
      context: 8192,
      saveHistory: false,
    });
    await window.companion.connect();
  }, report.mockEndpoint);
  await application.evaluate(
    ({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      dialog.showMessageBox = async () => ({ response: 0 });
    },
    path.join(directory, 'models', 'fixture-1.vrm'),
  );
  await panel.evaluate(() => window.companion.importAvatar());
  await until(
    async () => !!(await panel.evaluate(() => window.companion.state())).settings.avatarId,
    'VRM selection',
  );
  await panel.evaluate(installProbe);
  await sleep(1000);
  const metrics = () =>
    application.evaluate(({ app }) =>
      app.getAppMetrics().map((metric) => ({
        pid: metric.pid,
        type: metric.type,
        workingSetKiB: metric.memory.workingSetSize,
      })),
    );
  report.processesBefore = await metrics();
  report.measurementStartedAt = new Date().toISOString();
  console.log(
    JSON.stringify({
      event: 'started',
      directory,
      startedAt: report.measurementStartedAt,
      operations: report.config.measuredOperations,
    }),
  );
  async function measure(definition, action) {
    assert.equal(activeStreams.size, 1, 'Mock SSE must be open before every measured operation');
    const streamId = [...activeStreams][0];
    definition.id = report.samples.length + 1;
    await panel.evaluate((value) => window.__responseProbe.arm(value), definition);
    await action();
    await panel.waitForFunction(
      (id) => window.__responseProbe.results.some((sample) => sample.id === id),
      definition.id,
      { timeout: 10000 },
    );
    const sample = await panel.evaluate(
      (id) => window.__responseProbe.results.find((sample) => sample.id === id),
      definition.id,
    );
    sample.streamId = streamId;
    sample.t0At = new Date(sample.timeOriginMs + sample.t0Ms).toISOString();
    sample.t1At =
      sample.t1Ms === null ? null : new Date(sample.timeOriginMs + sample.t1Ms).toISOString();
    sample.streamOpenAfter = activeStreams.has(streamId);
    report.samples.push(sample);
    assert.equal(sample.trusted, true, 'Measurement must start at a trusted DOM event');
    assert.equal(sample.busyAtEvent, true, 'Measurement must start while app is busy');
    assert.equal(sample.error, null);
    if (definition.kind !== 'stop') assert.equal(sample.streamOpenAfter, true);
  }
  for (let round = 1; round <= report.config.rounds; round++) {
    await panel.locator('#message-input').fill('応答確認 ' + round);
    await panel.locator('[data-action="send"]').click();
    await until(() => activeStreams.size === 1 && report.streams.at(-1).chunks >= 3, 'Held stream');
    await panel.waitForFunction(
      () =>
        document.querySelector('.pill')?.textContent === '応答中' &&
        document.querySelector('.message.assistant .message-text')?.textContent.includes('応答中'),
    );
    for (let input = 1; input <= 2; input++) {
      const expected = `入力応答確認 ${round}-${input}`;
      await measure(
        { kind: 'input', event: 'input', selector: '#message-input', expected, round },
        () => panel.locator('#message-input').fill(expected),
      );
    }
    for (const [tab, expected] of [
      ['organize', 'フォルダを整える'],
      ['chat', '会話'],
    ]) {
      const selector = `[data-action="tab"][data-tab="${tab}"]`;
      await measure({ kind: 'tab', event: 'click', selector, expected, round }, () =>
        panel.locator(selector).click(),
      );
    }
    await measure({ kind: 'stop', event: 'click', selector: '[data-action="cancel"]', round }, () =>
      panel.locator('[data-action="cancel"]').click(),
    );
    await until(() => activeStreams.size === 0, 'Server stream cancellation');
    console.log(
      JSON.stringify({ event: 'round-complete', round, operations: report.samples.length }),
    );
  }
  report.measurementFinishedAt = new Date().toISOString();
  report.processesAfter = await metrics();
  function summarize(samples) {
    const values = samples.map((sample) => sample.latencyMs).sort((a, b) => a - b);
    return {
      count: values.length,
      minMs: values[0],
      medianMs: values[Math.ceil(values.length * 0.5) - 1],
      p95Ms: values[Math.ceil(values.length * 0.95) - 1],
      maxMs: values.at(-1),
      thresholdPassed: values[Math.ceil(values.length * 0.95) - 1] <= report.config.thresholdMs,
    };
  }
  report.summary = {
    all: summarize(report.samples),
    byKind: Object.fromEntries(
      ['input', 'tab', 'stop'].map((kind) => [
        kind,
        summarize(report.samples.filter((sample) => sample.kind === kind)),
      ]),
    ),
  };
  assert.equal(report.samples.length, report.config.measuredOperations);
  assert.equal(report.errors.length, 0);
  report.completed = true;
  assert.ok(
    report.summary.all.thresholdPassed &&
      Object.values(report.summary.byKind).every((summary) => summary.thresholdPassed),
    'Observed p95 exceeds 200 ms',
  );
} catch (error) {
  report.errors.push({ source: 'responsiveness-test', error: String(error) });
  process.exitCode = 1;
  console.error(error);
} finally {
  if (application) {
    closing = true;
    try {
      await bounded(application.close(), 'Owned app shutdown');
    } catch (error) {
      report.errors.push({ source: 'cleanup', error: String(error) });
      try {
        await promisify(execFile)(
          'taskkill.exe',
          ['/PID', String(application.process().pid), '/T', '/F'],
          { windowsHide: true, timeout: 10000 },
        );
      } catch (cleanupError) {
        report.errors.push({ source: 'cleanup', error: String(cleanupError) });
      }
    }
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log(
    JSON.stringify({
      event: 'finished',
      result: path.join(directory, 'result.json'),
      startedAt: report.startedAt,
      finishedAt: report.finishedAt,
      completed: report.completed,
      errors: report.errors,
      summary: report.summary,
    }),
  );
}
