import { _electron as electron } from 'playwright';
import { panelWindow } from './electron-test.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

const directory = path.resolve('artifacts/input-investigation-' + Date.now());
await mkdir(directory, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const server = createServer((_request, response) => {
  response.writeHead(503, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: { message: 'Input diagnostic mock server' } }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const packaged = process.env.COMPANION_PACKAGE;
let application;
const results = [];
try {
  application = await electron.launch({
    ...(packaged ? { executablePath: path.resolve(packaged) } : {}),
    args: [...(packaged ? [] : ['.']), '--user-data-dir=' + path.join(directory, 'state')],
    env,
  });
  const page = await panelWindow(application);
  await page.locator('#message-input').waitFor();
  await page.evaluate(() => {
    window.inputEvents = [];
    for (const name of [
      'keydown',
      'beforeinput',
      'input',
      'compositionstart',
      'compositionend',
      'focusin',
      'focusout',
    ]) {
      document.addEventListener(
        name,
        (event) =>
          window.inputEvents.push({
            type: event.type,
            target: event.target.id,
            key: event.key,
            composing: event.isComposing,
            data: event.data,
          }),
        true,
      );
    }
  });
  const update = () =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          const unsubscribe = window.companion.onEvent((event) => {
            if (event.type === 'update') {
              unsubscribe();
              setTimeout(resolve, 20);
            }
          });
          void window.companion.hideAvatar();
        }),
    );
  const sample = async (name) => {
    const value = await page.evaluate(() => ({
      value: document.querySelector('#message-input')?.value,
      focused: document.activeElement?.id,
      documentFocused: document.hasFocus(),
      selection: [
        document.querySelector('#message-input')?.selectionStart,
        document.querySelector('#message-input')?.selectionEnd,
      ],
      sameNode: window.originalInput === document.querySelector('#message-input'),
    }));
    results.push({ name, ...value });
  };
  await sample('startup before clicking input');
  await page.evaluate(async (endpoint) => {
    const state = await window.companion.state();
    await window.companion.settings({ ...state.settings, llmMode: 'external', endpoint });
  }, `http://127.0.0.1:${server.address().port}`);
  await update();
  await page.locator('#message-input').click();
  await page.keyboard.type('before');
  await page.evaluate(() => {
    window.originalInput = document.querySelector('#message-input');
  });
  await sample('initial typing');
  await update();
  await page.keyboard.type('-after');
  await sample('state update then typing');
  await page.keyboard.press('Control+z');
  await sample('undo after state update');
  await page.keyboard.press('Control+z');
  await sample('second undo after state update');

  for (const accept of [false, true]) {
    const handled = new Promise((resolve) =>
      page.once('dialog', async (dialog) => {
        if (accept) await dialog.accept();
        else await dialog.dismiss();
        resolve();
      }),
    );
    await page.locator('[data-action="deleteConversation"]').click();
    await handled;
    await page.locator('#message-input').click();
    await page.keyboard.type(accept ? '-accepted' : '-canceled');
    await sample('typing after delete confirmation ' + accept);
  }

  await page.locator('#message-input').fill('');
  await page.locator('#message-input').focus();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.imeSetComposition', { text: 'にほん', selectionStart: 3, selectionEnd: 3 });
  await page.evaluate(() => {
    window.originalInput = document.querySelector('#message-input');
  });
  await update();
  await sample('composition during state update');
  await cdp.send('Input.insertText', { text: '日本' });
  await page.keyboard.type('-next');
  await sample('composition committed then typing');
  await page.keyboard.press('Control+z');
  await sample('undo after IME commit');
  await page.keyboard.press('Control+z');
  await sample('second undo after IME commit');
  await page.locator('#message-input').fill('変換確認');
  await page.evaluate(() =>
    document
      .querySelector('#message-input')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true })),
  );
  await sample('IME keyCode 229 Enter');
  await page.waitForFunction(() => !document.querySelector('[data-action="cancel"]'));
  for (const [width, height] of [
    [820, 600],
    [1120, 810],
  ]) {
    await application.evaluate(
      ({ BrowserWindow }, size) => {
        const panel = BrowserWindow.getAllWindows().find((window) =>
          window.webContents.getURL().endsWith('/index.html'),
        );
        panel.setSize(...size);
      },
      [width, height],
    );
    await page.locator('#message-input').click();
    await page.keyboard.type('size-check');
    await sample(`typing at window size ${width}x${height}`);
    results.push({
      name: `hit target at ${width}x${height}`,
      ...(await page.evaluate(() => {
        const input = document.querySelector('#message-input');
        const rect = input.getBoundingClientRect();
        return {
          rect: rect.toJSON(),
          hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.id,
          disabled: input.disabled,
          readOnly: input.readOnly,
        };
      })),
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 10000));
  await page.locator('#message-input').click();
  await page.keyboard.type('-idle');
  await sample('typing after 10 seconds idle');
  await application.evaluate(({ BrowserWindow }) => {
    const panel = BrowserWindow.getAllWindows().find((window) =>
      window.webContents.getURL().endsWith('/index.html'),
    );
    panel.webContents.send('companion:event', {
      type: 'error',
      message:
        '保存済みモデルを表示できません。アバター画面から別のVRMを選択してください。 ' +
        'モデルの読み込みに失敗しました。'.repeat(15),
    });
  });
  await page.locator('#toast').waitFor({ state: 'visible' });
  results.push({
    name: 'input hit target under a long startup error',
    ...(await page.evaluate(() => {
      const rect = document.querySelector('#message-input').getBoundingClientRect();
      return {
        hit: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.id,
        input: rect.toJSON(),
        toast: document.querySelector('#toast').getBoundingClientRect().toJSON(),
      };
    })),
  });
  await page.screenshot({ path: path.join(directory, 'startup-error-overlap.png') });
  const point = await page.evaluate(() => {
    document.querySelector('[data-action="sendMode"]').focus();
    const rect = document.querySelector('#message-input').getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  });
  await page.mouse.click(point.x, point.y);
  await page.keyboard.type('blocked-click');
  await sample('coordinate click and typing while toast overlaps');
  await page.locator('#toast').waitFor({ state: 'hidden' });
  await page.mouse.click(point.x, point.y);
  await page.keyboard.type('-recovered');
  await sample('coordinate click and typing after toast disappears');
  if (process.argv.includes('--verify')) {
    const result = (name) => results.find((item) => item.name === name);
    assert.equal(result('state update then typing').sameNode, true);
    assert.equal(result('second undo after state update').value, '');
    assert.equal(result('composition committed then typing').sameNode, true);
    assert.equal(result('composition committed then typing').value, '日本-next');
    assert.notEqual(result('second undo after IME commit').value, '日本');
    assert.equal(result('IME keyCode 229 Enter').value, '変換確認');
    assert.equal(result('input hit target under a long startup error').hit, 'message-input');
    assert.equal(
      result('coordinate click and typing while toast overlaps').focused,
      'message-input',
    );
    assert.match(result('coordinate click and typing while toast overlaps').value, /blocked-click/);
  }
  await page.locator('#message-input').fill('normal-send');
  await page.keyboard.press('Shift+Enter');
  assert.equal(await page.locator('#message-input').inputValue(), 'normal-send\n');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('.message.user .message-text')].some(
      (node) => node.textContent.trim() === 'normal-send',
    ),
  );
  assert.equal(
    await page.locator('.message.user .message-text').filter({ hasText: 'normal-send' }).count(),
    1,
  );
  await page.waitForFunction(() => !document.querySelector('[data-action="cancel"]'));
  await page.locator('[data-action="tab"][data-tab="settings"]').click();
  await page.locator('#persona').click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('-edit');
  await page.evaluate(() => {
    window.settingsInput = document.querySelector('#persona');
  });
  await update();
  assert.equal(
    await page.evaluate(() => window.settingsInput === document.querySelector('#persona')),
    true,
  );
  await page.keyboard.press('Control+z');
  assert.equal(await page.locator('#persona').inputValue(), 'Companion');
  results.push({
    name: 'normal Enter, Shift+Enter, settings node identity and Undo',
    passed: true,
  });
  results.push({ events: await page.evaluate(() => window.inputEvents) });
  await cdp.detach();
} catch (error) {
  results.push({ error: String(error) });
  process.exitCode = 1;
} finally {
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(results, null, 2));
  console.log(
    JSON.stringify({ directory, results: results.filter((result) => !result.events) }, null, 2),
  );
  await application?.close();
  await new Promise((resolve) => server.close(resolve));
}
