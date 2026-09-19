import { _electron as electron } from 'playwright';
import { panelWindow } from './electron-test.mjs';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createFixtures } from './fixtures.mjs';
const dir = path.resolve('artifacts/acceptance-' + Date.now()),
  data = path.join(dir, 'state');
await mkdir(dir, { recursive: true });
await createFixtures(path.join(dir, 'models'));
let mode = 'normal',
  streamClosed = false,
  rendererProbeCount = 0;
const server = createServer(async (req, res) => {
  if (req.url === '/renderer-probe') {
    rendererProbeCount++;
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.end('unexpected external access');
    return;
  }
  if (req.url === '/health' || req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(req.url === '/health' ? '{}' : '{"data":[{"id":"fixture"}]}');
    return;
  }
  if (req.url !== '/v1/chat/completions') {
    res.writeHead(404);
    res.end();
    return;
  }
  let input = '';
  for await (const chunk of req) input += chunk;
  const body = JSON.parse(input);
  if (body.response_format) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [
          { message: { content: '{"intent":"chat","method":null,"target":"unspecified"}' } },
        ],
      }),
    );
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(
    'data: ' + JSON.stringify({ choices: [{ delta: { content: '検証の返答' } }] }) + '\n\n',
  );
  if (mode === 'hold') {
    req.on('close', () => {
      streamClosed = true;
    });
    res.on('close', () => {
      streamClosed = true;
    });
    return;
  }
  if (mode === 'length')
    res.write(
      'data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }) + '\n\n',
    );
  res.end('data: [DONE]\n\n');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, COMPANION_TEST_DATA: data };
delete env.ELECTRON_RUN_AS_NODE;
const packaged = process.env.COMPANION_PACKAGE;
let app, panel;
const checks = [],
  errors = [];
async function launch() {
  app = await electron.launch({
    ...(packaged ? { executablePath: path.resolve(packaged) } : {}),
    args: [...(packaged ? [] : ['.']), '--user-data-dir=' + data],
    env,
  });
  panel = await panelWindow(app);
  panel.setDefaultTimeout(15000);
  await panel.getByRole('heading', { name: '会話', exact: true }).waitFor();
  panel.on('pageerror', (e) => errors.push(e.message));
  const state = await panel.evaluate(() => window.companion.state());
  assert.equal(path.resolve(state.dataPath), data);
  return state;
}
try {
  await launch();
  const initial = await panel.evaluate(() => window.companion.state());
  assert.equal(await panel.evaluate(() => typeof window.require), 'undefined');
  assert.equal(await panel.evaluate(() => typeof window.process), 'undefined');
  assert.equal(
    await panel.evaluate(async (url) => {
      try {
        await fetch(url, { mode: 'no-cors' });
        return false;
      } catch {
        return true;
      }
    }, `http://127.0.0.1:${server.address().port}/renderer-probe`),
    true,
  );
  assert.equal(rendererProbeCount, 0);
  await assert.rejects(() =>
    panel.evaluate(async () => {
      const s = await window.companion.state();
      s.settings.endpoint = 'https://example.org';
      await window.companion.settings(s.settings);
    }),
  );
  checks.push('sandbox, renderer network denial, non-loopback endpoint rejection');
  await panel.evaluate(async (endpoint) => {
    const state = await window.companion.state();
    state.settings.endpoint = endpoint;
    state.settings.persona = '再起動の検証';
    await window.companion.settings(state.settings);
    await window.companion.connect();
  }, `http://127.0.0.1:${server.address().port}`);
  await panel.getByRole('button', { name: 'こんにちは', exact: true }).click();
  assert.equal(await panel.getByLabel('メッセージ', { exact: true }).inputValue(), 'こんにちは');
  await panel.getByRole('button', { name: '送信 ↗' }).click();
  await panel.getByText('検証の返答', { exact: true }).waitFor();
  mode = 'hold';
  const canceled = panel.evaluate(async () => {
    const s = await window.companion.state();
    try {
      await window.companion.send(s.conversations[0].id, '停止の検証');
      return 'unexpected';
    } catch (error) {
      return error.message;
    }
  });
  await panel.waitForFunction(() => document.querySelector('.pill')?.textContent === '応答中');
  await panel.evaluate(() => window.companion.cancel());
  assert.match(await canceled, /中断/);
  assert.equal((await panel.evaluate(() => window.companion.state())).phase, 'canceled');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(streamClosed, true);
  checks.push('SSE cancellation reaches server and reports canceled');
  mode = 'length';
  const lengthError = await panel.evaluate(async () => {
    const id = await window.companion.newConversation();
    try {
      await window.companion.send(id, '長さの検証');
    } catch (error) {
      return error.message;
    }
  });
  assert.match(lengthError, /上限/);
  assert.equal((await panel.evaluate(() => window.companion.state())).phase, 'error');
  checks.push('length truncation preserves partial response and reports error');
  mode = 'normal';
  let lastId;
  for (const version of [1, 0]) {
    await app.evaluate(
      ({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
        dialog.showMessageBox = async () => ({ response: 0 });
      },
      path.join(dir, 'models', `fixture-${version}.vrm`),
    );
    await panel.evaluate(() => window.companion.importAvatar());
    for (let attempt = 0; attempt < 150; attempt++) {
      const current = await panel.evaluate(() => window.companion.state());
      if (current.settings.avatarId && current.avatars.length === (version === 1 ? 1 : 2)) break;
      if (attempt === 149) throw new Error('Avatar import did not settle');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const state = await panel.evaluate(() => window.companion.state());
    lastId = state.settings.avatarId;
    await panel.evaluate((id) => window.companion.selectAvatar(id), lastId);
  }
  assert.equal((await panel.evaluate(() => window.companion.state())).avatars.length, 2);
  checks.push('reselecting current avatar does not block next import');
  const snapshot = await panel.evaluate(() => window.companion.backupData());
  assert.ok((await readFile(snapshot)).length > 0);
  checks.push('backup through UI API');
  await panel.getByRole('button', { name: 'アバターを隠す', exact: true }).click();
  let visibility = await panel.evaluate(() => window.companion.state());
  assert.equal(visibility.avatarVisible, false);
  assert.equal(visibility.settings.avatarVisible, false);
  assert.equal(visibility.settings.avatarId, lastId);
  await panel.getByRole('button', { name: 'アバターを表示', exact: true }).click();
  assert.equal((await panel.evaluate(() => window.companion.state())).avatarVisible, true);
  await panel.getByRole('button', { name: 'アバターを隠す', exact: true }).click();
  checks.push('header hides and shows the avatar without ending the application');
  await app.close();
  app = undefined;
  const restored = await launch();
  assert.equal(restored.settings.persona, '再起動の検証');
  assert.equal(restored.settings.avatarId, lastId);
  assert.equal(restored.settings.avatarVisible, false);
  assert.equal(restored.avatarVisible, false);
  assert.equal(restored.avatars.length, 2);
  assert.ok(restored.conversations.some((c) => c.messages.length));
  checks.push('restart persists settings, avatars, selection and conversations');
  await panel.getByRole('button', { name: 'アバターを表示', exact: true }).click();
  assert.equal((await panel.evaluate(() => window.companion.state())).avatarVisible, true);
  checks.push('hidden avatar stays hidden after restart and can be shown again');
  await panel.evaluate(async () => {
    const s = await window.companion.state();
    await window.companion.deleteConversation(s.conversations[0].id);
  });
  await panel.evaluate(() => window.companion.clearHistory());
  assert.ok(
    (await panel.evaluate(() => window.companion.state())).conversations.every(
      (c) => c.messages.length === 0,
    ),
  );
  checks.push('individual and all conversation deletion');
  await panel.screenshot({ path: path.join(dir, 'final.png') });
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(dir, 'result.json'),
    JSON.stringify({ passed: true, packaged: !!packaged, checks, errors }, null, 2),
  );
  console.log(
    JSON.stringify({ passed: true, packaged: !!packaged, checks, directory: dir }, null, 2),
  );
} catch (error) {
  await writeFile(
    path.join(dir, 'result.json'),
    JSON.stringify({ passed: false, error: String(error), checks, errors }, null, 2),
  );
  if (panel) await panel.screenshot({ path: path.join(dir, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  if (app) await app.close();
  server.closeAllConnections();
  server.close();
}
