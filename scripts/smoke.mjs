import { _electron as electron } from 'playwright';
import { panelWindow } from './electron-test.mjs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFixtures } from './fixtures.mjs';
const dir = path.resolve('artifacts/ui-' + Date.now());
await mkdir(dir, { recursive: true });
await createFixtures(path.join(dir, 'models'));
const files = path.resolve('..', 'VRM-Companion-test-artifacts', path.basename(dir), 'files');
await mkdir(files, { recursive: true });
await writeFile(path.join(files, 'hello.txt'), 'keep this content');
await writeFile(path.join(files, 'image.png'), 'sample');
const server = createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":"ok"}');
    return;
  }
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"data":[{"id":"local-test-model"}]}');
    return;
  }
  if (req.url === '/apply-template' || req.url === '/tokenize') {
    res.writeHead(404);
    res.end();
    return;
  }
  let body = '';
  for await (const chunk of req) body += chunk;
  const data = JSON.parse(body);
  if (data.response_format) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify(
                data.messages.at(-1).content.includes('整理')
                  ? { intent: 'organize', method: 'by_extension', target: 'selected' }
                  : { intent: 'chat', method: null, target: 'unspecified' },
              ),
            },
          },
        ],
      }),
    );
  } else {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    for (const content of ['こんにちは。', 'ローカルで会話できます。'])
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content } }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let application;
const errors = [];
try {
  const launchEnv = { ...process.env, COMPANION_TEST_DATA: path.join(dir, 'state') };
  delete launchEnv.ELECTRON_RUN_AS_NODE;
  application = await electron.launch({ args: ['.'], env: launchEnv, timeout: 30000 });
  application.process().stderr.on('data', (b) => {
    const t = b.toString();
    if (!/ExperimentalWarning|security warning/i.test(t)) process.stderr.write(t);
  });
  const window = await panelWindow(application);
  window.on('pageerror', (e) => errors.push(e.message));
  await window.getByRole('heading', { name: '会話', exact: true }).waitFor();
  await window.screenshot({ path: path.join(dir, '01-welcome.png') });
  await window.getByRole('button', { name: '設定', exact: false }).first().click();
  await window
    .getByLabel('接続先', { exact: true })
    .fill(`http://127.0.0.1:${server.address().port}`);
  await window.getByRole('button', { name: '接続を確認', exact: true }).click();
  await window.getByText('llama-serverに接続しました。', { exact: true }).waitFor();
  await window.getByRole('button', { name: '会話', exact: false }).first().click();
  await window.getByLabel('メッセージ', { exact: true }).fill('こんにちは');
  await window.getByRole('button', { name: '送信 ↗' }).click();
  await window.getByText('こんにちは。ローカルで会話できます。', { exact: true }).waitFor();
  await application.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, files);
  await window.getByRole('button', { name: 'フォルダを選択', exact: true }).click();
  await window.getByText(files, { exact: true }).waitFor();
  await window.getByLabel('メッセージ', { exact: true }).fill('このフォルダを種類別に整理して');
  await window.getByRole('button', { name: '送信 ↗' }).click();
  await window
    .getByText(
      '選択中のフォルダ直下を確認し、種類別の整理案を作ります。実行前に一覧を確認できます。',
      { exact: true },
    )
    .waitFor();
  await window.getByRole('button', { name: 'フォルダ整理', exact: false }).first().click();
  await window.getByRole('button', { name: '内容を検証する', exact: true }).first().click();
  await window.getByRole('button', { name: 'この内容で整理する', exact: true }).click();
  await window.getByRole('button', { name: '復元案を確認', exact: true }).waitFor();
  assert.equal(await readFile(path.join(files, '文書', 'hello.txt'), 'utf8'), 'keep this content');
  await window.screenshot({ path: path.join(dir, '02-organized.png') });
  await window.getByRole('button', { name: '復元案を確認', exact: true }).click();
  await window.getByRole('button', { name: 'この内容で戻す', exact: true }).click();
  await window.waitForFunction(() => document.querySelector('.pill')?.textContent === '完了');
  assert.equal(await readFile(path.join(files, 'hello.txt'), 'utf8'), 'keep this content');
  await window.getByRole('button', { name: 'アバター', exact: false }).first().click();
  for (const version of [1, 0]) {
    await application.evaluate(
      ({ dialog }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
        dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
      },
      path.join(dir, 'models', `fixture-${version}.vrm`),
    );
    await window.getByRole('button', { name: '＋ VRMをインポート', exact: true }).click();
    await window
      .getByText(`Synthetic VRM ${version === 1 ? '1.0' : '0.x'} test ✓`, { exact: true })
      .waitFor({ timeout: 30000 });
    const avatar = (await application.windows()).find((w) => w.url().endsWith('avatar.html'));
    await avatar.screenshot({ path: path.join(dir, `03-avatar-${version}.png`) });
  }
  await window.screenshot({ path: path.join(dir, '04-avatars.png') });
  assert.deepEqual(errors, []);
  console.log(
    'UI smoke passed: settings, SSE chat, conversation → plan → approval → move → undo, VRM 1.0 and 0.x imports.',
  );
  console.log('Artifacts: ' + dir);
} catch (error) {
  if (application) {
    for (const [i, w] of (await application.windows()).entries()) {
      await w.screenshot({ path: path.join(dir, `failure-${i}.png`) }).catch(() => {});
      console.log((await w.locator('body').innerText()).slice(-5000));
    }
  }
  throw error;
} finally {
  if (application) await application.close();
  server.close();
}
