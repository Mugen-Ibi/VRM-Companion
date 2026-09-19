import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, validName } from '../src/main/files';
import { endpoint, IntentSchema, Llama } from '../src/main/llama';
import { inspectVRM } from '../src/main/vrm';
import { DEFAULTS } from '../src/shared/types';
import { createServer } from 'node:http';

test('classification is deterministic and unknown extensions remain untouched', () => {
  assert.equal(classify('写真.PNG'), '画像');
  assert.equal(classify('invoice.PDF'), '文書');
  assert.equal(classify('private.sqlite'), '変更なし');
  assert.equal(classify('README'), '変更なし');
});
test('paths and Windows aliases cannot enter classification targets', () => {
  for (const value of [
    '..',
    '../a',
    'a/b',
    'a\\b',
    'con.txt',
    'x:ads',
    'a.',
    'a ',
    'NUL',
    'COM1.json',
  ])
    assert.equal(validName(value), false, value);
  assert.equal(validName('日本語と spaces.txt'), true);
});
test('LLM endpoints are strictly loopback without redirects, userinfo or paths', () => {
  assert.equal(endpoint('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080');
  assert.equal(endpoint('http://[::1]:8090'), 'http://[::1]:8090');
  for (const url of [
    'https://example.org',
    'http://127.0.0.1.evil.test',
    'http://user@127.0.0.1',
    'http://127.0.0.1/path',
    'http://localhost:8080',
  ])
    assert.throws(() => endpoint(url));
});
test('intent cannot smuggle execution arguments', () => {
  assert.throws(() =>
    IntentSchema.parse({
      intent: 'organize',
      method: 'by_extension',
      target: 'selected',
      command: 'delete',
    }),
  );
  assert.throws(() =>
    IntentSchema.parse({ intent: 'organize', method: 'delete', target: 'selected' }),
  );
});
function glb(json: unknown) {
  const text = Buffer.from(JSON.stringify(json));
  const padded = Buffer.alloc(Math.ceil(text.length / 4) * 4, 0x20);
  text.copy(padded);
  const result = Buffer.alloc(20 + padded.length);
  result.writeUInt32LE(0x46546c67, 0);
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(padded.length, 12);
  result.writeUInt32LE(0x4e4f534a, 16);
  padded.copy(result, 20);
  return result;
}
test('VRM validation accepts both generations without model-specific metadata and rejects external assets', () => {
  for (const ext of ['VRM', 'VRMC_vrm'])
    assert.ok(
      inspectVRM(glb({ extensions: { [ext]: { meta: { name: 'User avatar' } } } }), () => ({
        width: 0,
        height: 0,
      })).id,
    );
  assert.throws(() =>
    inspectVRM(glb({ extensions: { VRM: {} }, buffers: [{ uri: 'file:///private' }] }), () => ({
      width: 1,
      height: 1,
    })),
  );
  assert.throws(() => inspectVRM(Buffer.from('invalid'), () => ({ width: 1, height: 1 })));
});
test('chat reads fragmented UTF-8 SSE', async () => {
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    if (req.url !== '/v1/chat/completions') {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const bytes = Buffer.from(
      'data: {"choices":[{"delta":{"content":"こんにちは"}}]}\n\ndata: [DONE]\n\n',
    );
    for (let i = 0; i < bytes.length; i += 3) res.write(bytes.subarray(i, i + 3));
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  let text = '';
  try {
    const llama = new Llama(
      () => ({ ...DEFAULTS, endpoint: `http://127.0.0.1:${port}` }),
      () => '',
    );
    await llama.chat(
      [{ id: 'x', role: 'user', content: 'こんにちは', createdAt: 0 }],
      new AbortController().signal,
      (t) => (text += t),
      () => {},
    );
    assert.equal(text, 'こんにちは');
  } finally {
    server.close();
  }
});
