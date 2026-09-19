import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { DEFAULTS } from '../src/shared/types';
import { ModelRuntime, launchArguments, scanModels } from '../src/main/model-runtime';

test('GGUF catalog excludes projections, incomplete splits, links and invalid headers', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-models-'));
  try {
    for (const name of [
      'a.gguf',
      'mmproj-test.gguf',
      'split-00001-of-00002.gguf',
      'split-00002-of-00002.gguf',
      'missing-00001-of-00002.gguf',
    ])
      await fs.writeFile(path.join(root, name), 'GGUF1234');
    await fs.writeFile(path.join(root, 'invalid.gguf'), 'nope');
    await fs.mkdir(path.join(root, 'nested'));
    await fs.writeFile(path.join(root, 'nested', 'hidden.gguf'), 'GGUF');
    const models = await scanModels(root);
    assert.deepEqual(
      models.map((m) => [m.name, m.size]),
      [
        ['a.gguf', 8],
        ['split-00001-of-00002.gguf', 16],
      ],
    );
    assert.equal((await scanModels(root))[0].id, models[0].id);
    assert.equal(models[0].id.length, 64);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('managed lifecycle authenticates, reuses one model, stops on switch and cancels startup', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'companion-runtime-'));
  const children: ChildProcess[] = [];
  let waitForReady = false;
  const runtime = new ModelRuntime(
    () => {},
    () => false,
    ((_exe: string, args: string[], options: any) => {
      assert.equal(
        children.filter((child) => child.exitCode === null && child.signalCode === null).length,
        0,
        'previous child must exit first',
      );
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      const port = args[args.indexOf('--port') + 1];
      const program = `const http=require('http');http.createServer((q,r)=>{if(q.headers.authorization!=='Bearer '+process.env.LLAMA_API_KEY){r.writeHead(401);return r.end();}r.writeHead(${waitForReady ? 503 : 200},{'Content-Type':'application/json'});r.end(JSON.stringify({data:[{id:'companion-local'}]}));}).listen(${port},'127.0.0.1');`;
      const child = spawn(process.execPath, ['-e', program], options);
      children.push(child);
      return child;
    }) as typeof spawn,
  );
  try {
    await fs.writeFile(path.join(root, 'llama-server.exe'), 'test launcher');
    await fs.writeFile(path.join(root, 'one.gguf'), 'GGUF');
    await fs.writeFile(path.join(root, 'two.gguf'), 'GGUF');
    const models = await scanModels(root);
    const s = {
      ...DEFAULTS,
      modelDirectory: root,
      serverPath: path.join(root, 'llama-server.exe'),
      managedModel: models[0].id,
    };
    const signal = new AbortController().signal;
    await runtime.ensure(s, signal);
    assert.equal(runtime.state.status, 'ready');
    const firstKey = runtime.credentials().key;
    await runtime.ensure(s, signal);
    assert.equal(children.length, 1);
    await runtime.ensure({ ...s, managedModel: models[1].id }, signal);
    assert.equal(children.length, 2);
    assert.notEqual(runtime.credentials().key, firstKey);
    runtime.scheduleIdle(0.001);
    const idleDeadline = Date.now() + 3000;
    while (runtime.running && Date.now() < idleDeadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(runtime.running, false, 'idle timer must stop the owned model');
    await Promise.all([runtime.stop(), runtime.stop()]);
    assert.equal(runtime.running, false);
    assert.throws(() => runtime.credentials(), /読み込まれていません/);
    waitForReady = true;
    const controller = new AbortController();
    const loading = runtime.ensure(s, controller.signal);
    const timer = setTimeout(() => controller.abort(), 400);
    await assert.rejects(loading);
    clearTimeout(timer);
    assert.equal(runtime.state.status, 'unloaded');
    assert.equal(runtime.running, false);
    await assert.rejects(
      runtime.ensure({ ...s, managedModel: '../escape' }, signal),
      /モデルを選択/,
    );
    assert.equal(children.length, 3);
  } finally {
    await runtime.stop();
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('managed arguments bound parallelism and prompt cache and leave GPU fitting enabled', () => {
  const args = launchArguments('D:\\models\\space name.gguf', 12345, 4096);
  const value = (key: string) => args[args.indexOf(key) + 1];
  assert.equal(value('--parallel'), '1');
  assert.equal(value('--cache-ram'), '0');
  assert.equal(value('--ctx-size'), '4096');
  assert.equal(value('--fit'), 'on');
  assert.equal(value('--model'), 'D:\\models\\space name.gguf');
});
