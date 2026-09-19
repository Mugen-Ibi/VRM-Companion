import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { Llama } from '../src/main/llama';
import { DEFAULTS, type Message, type Settings } from '../src/shared/types';

type Request = { route: string; body: any; signal: AbortSignal };
type MockOptions = {
  tokens?: (messages: any[]) => number;
  response?: (request: Request) => Response | Promise<Response>;
  templateStatus?: number;
  tokenizeStatus?: number;
};
const user = (content: string): Message => ({ id: content, role: 'user', content, createdAt: 0 });
const delta = (content: string) =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const done = 'data: [DONE]\n\n';
function mockServer(t: TestContext, options: MockOptions = {}) {
  const requests: Request[] = [];
  t.mock.method(
    globalThis,
    'fetch',
    async (input: string | URL | globalThis.Request, init?: RequestInit) => {
      const request: Request = {
        route: new URL(String(input)).pathname,
        body: JSON.parse(String(init?.body || '{}')),
        signal: init!.signal!,
      };
      requests.push(request);
      if (request.route === '/apply-template')
        return options.templateStatus
          ? new Response('', { status: options.templateStatus })
          : Response.json({ prompt: JSON.stringify(request.body.messages) });
      if (request.route === '/tokenize')
        return options.tokenizeStatus
          ? new Response('', { status: options.tokenizeStatus })
          : Response.json({
              tokens: Array(options.tokens?.(JSON.parse(request.body.content)) ?? 20).fill(42),
            });
      assert.equal(request.route, '/v1/chat/completions');
      return options.response?.(request) ?? new Response(delta('こんにちは') + done);
    },
  );
  return requests;
}
function openStream(chunks: Uint8Array[]) {
  let canceled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
      },
      cancel() {
        canceled = true;
      },
    }),
  );
  return { response, canceled: () => canceled };
}
const encode = (text: string) => new TextEncoder().encode(text);
function llama(overrides: Partial<Settings> = {}) {
  return new Llama(
    () => ({ ...DEFAULTS, ...overrides }),
    () => '',
  );
}

test('fragmented UTF-8 SSE completes and releases the reader and generation request', async (t) => {
  const bytes = encode((delta('こんにちは🌸') + done).replaceAll('\n', '\r\n'));
  const stream = openStream(Array.from(bytes, (byte) => new Uint8Array([byte])));
  const requests = mockServer(t, { response: () => stream.response });
  let output = '';
  await llama().chat(
    [user('挨拶して')],
    new AbortController().signal,
    (text) => (output += text),
    () => {},
  );
  assert.equal(output, 'こんにちは🌸');
  assert.equal(stream.canceled(), true);
  assert.equal(requests.at(-1)!.signal.aborted, true);
  assert.equal(requests[0].body.add_generation_prompt, true);
  assert.deepEqual(
    requests[0].body.chat_template_kwargs,
    requests.at(-1)!.body.chat_template_kwargs,
  );
  assert.deepEqual(requests[0].body.messages, requests.at(-1)!.body.messages);
  assert.equal(requests[1].body.add_special, true);
  assert.equal(requests[1].body.parse_special, true);
});

test('malformed events, inference errors and output limits cancel an otherwise open stream', async (t) => {
  for (const [name, event, error] of [
    ['malformed', 'data: {broken}\n\n', /応答形式が不正/],
    ['server error', 'data: {"error":{"message":"failed"}}\n\n', /推論中にエラー/],
    ['oversized line', 'data: ' + 'x'.repeat(1_000_001), /応答が大きすぎ/],
    ['oversized text', delta('x'.repeat(100_001)), /応答の上限/],
  ] as const)
    await t.test(name, async (child) => {
      const stream = openStream([encode(event)]);
      const requests = mockServer(child, { response: () => stream.response });
      await assert.rejects(
        llama().chat(
          [user('test')],
          new AbortController().signal,
          () => {},
          () => {},
        ),
        error,
      );
      assert.equal(stream.canceled(), true);
      assert.equal(requests.at(-1)!.signal.aborted, true);
    });
});

test('EOF before DONE rejects the response while retaining text already delivered', async (t) => {
  const requests = mockServer(t, { response: () => new Response(delta('途中まで')) });
  let output = '';
  await assert.rejects(
    llama().chat(
      [user('test')],
      new AbortController().signal,
      (text) => (output += text),
      () => {},
    ),
    /途中で切断/,
  );
  assert.equal(output, '途中まで');
  assert.equal(requests.at(-1)!.signal.aborted, true);
});

test('finish_reason length reports truncation, retains partial text and cancels without waiting for DONE', async (t) => {
  const stream = openStream([
    encode(delta('文の途中') + 'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n'),
  ]);
  const requests = mockServer(t, { response: () => stream.response });
  let output = '';
  await assert.rejects(
    llama().chat(
      [user('test')],
      new AbortController().signal,
      (text) => (output += text),
      () => {},
    ),
    /応答トークン上限.*途中まで/,
  );
  assert.equal(output, '文の途中');
  assert.equal(stream.canceled(), true);
  assert.equal(requests.at(-1)!.signal.aborted, true);
});

test('external cancellation stops further deltas and releases the stream', async (t) => {
  const controller = new AbortController();
  const stream = openStream([encode(delta('最初') + delta('表示しない') + done)]);
  const requests = mockServer(t, { response: () => stream.response });
  let output = '';
  await assert.rejects(
    llama().chat(
      [user('test')],
      controller.signal,
      (text) => {
        output += text;
        controller.abort();
      },
      () => {},
    ),
    /応答を中断/,
  );
  assert.equal(output, '最初');
  assert.equal(stream.canceled(), true);
  assert.equal(requests.at(-1)!.signal.aborted, true);
});

test('idle timeout aborts a stream which never produces its first event', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => (started = resolve));
  const requests = mockServer(t, {
    response: (request) => {
      const response = new Response(
        new ReadableStream({
          start(controller) {
            request.signal.addEventListener(
              'abort',
              () => controller.error(request.signal.reason),
              { once: true },
            );
          },
        }),
      );
      started();
      return response;
    },
  });
  const result = llama().chat(
    [user('test')],
    new AbortController().signal,
    () => {},
    () => {},
  );
  const rejection = assert.rejects(result, /タイムアウト/);
  await ready;
  t.mock.timers.tick(60001);
  await rejection;
  assert.equal(requests.at(-1)!.signal.aborted, true);
});

test('template lookup shares the generation timeout and cannot fall back after a timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requested!: () => void;
  const ready = new Promise<void>((resolve) => (requested = resolve));
  const routes: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    routes.push(new URL(input).pathname);
    requested();
    return new Promise<Response>((_, reject) =>
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }),
    );
  });
  const result = llama().chat(
    [user('test')],
    new AbortController().signal,
    () => {},
    () => {},
  );
  const rejection = assert.rejects(result, /タイムアウト/);
  await ready;
  t.mock.timers.tick(60001);
  await rejection;
  assert.deepEqual(routes, ['/apply-template']);
});

test('exact template tokens reserve output capacity and trim only complete older turns', async (t) => {
  const requests = mockServer(t, { tokens: (messages) => (messages.length > 4 ? 950 : 500) });
  const history: Message[] = [
    user('old'),
    { ...user('old-answer'), role: 'assistant' },
    user('recent'),
    { ...user('recent-answer'), role: 'assistant' },
    user('latest'),
  ];
  let trims = 0;
  await llama({ context: 1024, outputTokens: 128 }).chat(
    history,
    new AbortController().signal,
    () => {},
    () => trims++,
  );
  const completion = requests.at(-1)!;
  assert.deepEqual(
    completion.body.messages.slice(1).map((m: any) => m.content),
    ['recent', 'recent-answer', 'latest'],
  );
  assert.equal(completion.body.max_tokens, 128);
  assert.equal(trims, 1);
});

test('large UTF-8 input that fits in real tokens is retained without byte-based over-trimming', async (t) => {
  const requests = mockServer(t, { tokens: () => 100 });
  const text = '日本語'.repeat(1000);
  await llama({ context: 1024, outputTokens: 128 }).chat(
    [user(text)],
    new AbortController().signal,
    () => {},
    () => assert.fail('unexpected trimming'),
  );
  assert.equal(requests.at(-1)!.body.messages.at(-1).content, text);
});

test('template overhead that exceeds context blocks generation before completion', async (t) => {
  const requests = mockServer(t, { tokens: () => 1000 });
  await assert.rejects(
    llama({ context: 1024, outputTokens: 128 }).chat(
      [user('short')],
      new AbortController().signal,
      () => {},
      () => {},
    ),
    /文脈上限/,
  );
  assert.deepEqual(
    requests.map((r) => r.route),
    ['/apply-template', '/tokenize'],
  );
  assert.equal(requests[0].signal.aborted, true);
});

test('intent uses template token counting with its output reserve', async (t) => {
  const requests = mockServer(t, { tokens: () => 900 });
  await assert.rejects(
    llama({ context: 1024 }).intent('こんにちは', false, new AbortController().signal),
    /入力が長すぎ/,
  );
  assert.deepEqual(
    requests.map((r) => r.route),
    ['/apply-template', '/tokenize'],
  );
});

test('unsupported token endpoints fall back, but authentication and server errors remain errors', async (t) => {
  for (const [route, status] of [
    ['templateStatus', 404],
    ['templateStatus', 405],
    ['tokenizeStatus', 501],
  ] as const)
    await t.test(`${route} ${status}`, async (child) => {
      const requests = mockServer(child, { [route]: status });
      await llama().chat(
        [user('short')],
        new AbortController().signal,
        () => {},
        () => {},
      );
      assert.equal(requests.at(-1)!.route, '/v1/chat/completions');
    });
  for (const status of [401, 500, 503])
    await t.test(`HTTP ${status}`, async (child) => {
      const requests = mockServer(child, { templateStatus: status });
      await assert.rejects(
        llama().chat(
          [user('short')],
          new AbortController().signal,
          () => {},
          () => {},
        ),
      );
      assert.deepEqual(
        requests.map((r) => r.route),
        ['/apply-template'],
      );
    });
});

test('fallback still rejects oversized input rather than sending an unchecked request', async (t) => {
  const requests = mockServer(t, { templateStatus: 404 });
  await assert.rejects(
    llama().chat(
      [user('a'.repeat(6000))],
      new AbortController().signal,
      () => {},
      () => {},
    ),
    /文脈上限/,
  );
  assert.deepEqual(
    requests.map((r) => r.route),
    ['/apply-template'],
  );
});

test('legacy fallback still permits a short intent with default context settings', async (t) => {
  const requests = mockServer(t, {
    templateStatus: 404,
    response: () =>
      Response.json({
        choices: [
          { message: { content: '{"intent":"chat","method":null,"target":"unspecified"}' } },
        ],
      }),
  });
  const intent = await llama().intent('こんにちは', false, new AbortController().signal);
  assert.equal(intent.intent, 'chat');
  assert.equal(requests.at(-1)!.route, '/v1/chat/completions');
  assert.equal(requests.at(-1)!.signal.aborted, true);
});

test('an invalid successful token response is rejected instead of silently using an estimate', async (t) => {
  const requests = mockServer(t, { tokens: () => 0 });
  await assert.rejects(
    llama().chat(
      [user('test')],
      new AbortController().signal,
      () => {},
      () => {},
    ),
    /トークン数を確認/,
  );
  assert.deepEqual(
    requests.map((r) => r.route),
    ['/apply-template', '/tokenize'],
  );
});
