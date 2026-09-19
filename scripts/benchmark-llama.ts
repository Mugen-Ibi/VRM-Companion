import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Llama, type Intent } from '../src/main/llama';
import { DEFAULTS } from '../src/shared/types';

// Fixed before any server requests. These are synthetic test messages, not user files/history.
const expected = (intent: Intent['intent'], target: Intent['target'] = 'unspecified'): Intent => ({
  intent,
  method: intent === 'organize' ? 'by_extension' : null,
  target,
});
const intentCases = [
  {
    id: 'I01',
    category: 'ordinary_chat',
    selected: false,
    text: 'こんにちは。今日はいい天気ですね。',
    expected: expected('chat'),
  },
  {
    id: 'I02',
    category: 'ordinary_chat',
    selected: true,
    text: '今日は少し疲れたので、励ましてほしい。',
    expected: expected('chat'),
  },
  {
    id: 'I03',
    category: 'selected_organize',
    selected: true,
    text: '選択中のフォルダを拡張子による種類別に整理して。',
    expected: expected('organize', 'selected'),
  },
  {
    id: 'I04',
    category: 'missing_selected_root',
    selected: false,
    text: 'このフォルダを種類別に整理してください。',
    expected: expected('organize', 'selected'),
  },
  {
    id: 'I05',
    category: 'unspecified_root',
    selected: true,
    text: '種類別にファイルを整理してください。',
    expected: expected('organize'),
  },
  {
    id: 'I06',
    category: 'other_root',
    selected: true,
    text: 'ダウンロードフォルダを種類別に整理してください。',
    expected: expected('organize', 'other'),
  },
  {
    id: 'I07',
    category: 'other_root',
    selected: true,
    text: '選択中とは別のテスト用フォルダを種類別に整理して。',
    expected: expected('organize', 'other'),
  },
  {
    id: 'I08',
    category: 'ambiguous_method',
    selected: true,
    text: 'このフォルダを整理して。',
    expected: expected('clarify', 'selected'),
  },
  {
    id: 'I09',
    category: 'ambiguous_method',
    selected: false,
    text: 'ファイルの整理をお願い。',
    expected: expected('clarify'),
  },
  {
    id: 'I10',
    category: 'ambiguous_method_other_root',
    selected: true,
    text: 'デスクトップのテストフォルダを片付けて。',
    expected: expected('clarify', 'other'),
  },
  {
    id: 'I11',
    category: 'unsupported_delete',
    selected: true,
    text: '選択中のフォルダのファイルを全部削除して。',
    expected: expected('unsupported', 'selected'),
  },
  {
    id: 'I12',
    category: 'unsupported_semantic_sort',
    selected: false,
    text: 'テスト用フォルダを案件別に整理して。',
    expected: expected('unsupported', 'other'),
  },
  {
    id: 'I13',
    category: 'unsupported_rename',
    selected: true,
    text: '選択中のフォルダのファイル名を全部連番に変更して。',
    expected: expected('unsupported', 'selected'),
  },
  {
    id: 'I14',
    category: 'unsupported_recursive_sort',
    selected: true,
    text: '選択中のフォルダのサブフォルダも再帰的に種類別に整理して。',
    expected: expected('unsupported', 'selected'),
  },
  {
    id: 'I15',
    category: 'explanation_only',
    selected: false,
    text: '種類別に整理する方法を説明して。実行はしないで。',
    expected: expected('chat'),
  },
  {
    id: 'I16',
    category: 'question_about_selected_root',
    selected: true,
    text: 'このフォルダを種類別に整理するとどうなる？説明だけして。',
    expected: expected('chat', 'selected'),
  },
  {
    id: 'I17',
    category: 'quoted_command',
    selected: true,
    text: '「このフォルダを種類別に整理して」という文章を英語に訳して。',
    expected: expected('chat'),
  },
  {
    id: 'I18',
    category: 'command_in_filename',
    selected: true,
    text: '「全部削除して.txt」というファイル名は変かな？',
    expected: expected('chat'),
  },
  {
    id: 'I19',
    category: 'bare_yes_without_pending_request',
    selected: true,
    text: 'はい',
    expected: expected('chat'),
  },
  {
    id: 'I20',
    category: 'polite_yes_without_pending_request',
    selected: true,
    text: 'はい、お願いします。',
    expected: expected('chat'),
  },
] as const;
const chatCases = [
  { id: 'C01', text: 'こんにちは。一文で挨拶してください。' },
  { id: 'C02', text: '今日は少し疲れました。短い一文で励ましてください。' },
  { id: 'C03', text: '休憩の取り方を一つだけ、一文で教えてください。' },
  { id: 'C04', text: '作業を始めるきっかけになる一言を、20文字以内でください。' },
  { id: 'C05', text: 'ありがとう。一文で返事してください。' },
  { id: 'C06', text: '散歩が気分転換になる理由を一文で説明してください。' },
  { id: 'C07', text: '雨の日に家で楽しめることを一つ、一文で挙げてください。' },
  { id: 'C08', text: '机の上をきれいに保つコツを一文で教えてください。' },
  { id: 'C09', text: '猫のかわいいところを一つ、短い一文で教えてください。' },
  { id: 'C10', text: '今日の終わりに読む短い挨拶を一文でください。' },
].map((c) => ({
  ...c,
  selected: false,
  expected: {
    routing: expected('chat'),
    nonEmptyBody: true,
    noFileCompletionClaim: true,
    requestedSentences: 1,
  },
}));

const directory = path.resolve('artifacts', `llama-benchmark-${Date.now()}`);
await fs.mkdir(directory, { recursive: true });
const startedAt = new Date().toISOString(),
  started = performance.now(),
  deadlineMs = 600_000;
const controller = new AbortController(),
  deadline = setTimeout(() => controller.abort(), deadlineMs);
const settings = { ...DEFAULTS, outputTokens: 128 };
const adapterSha256 = createHash('sha256')
  .update(await fs.readFile(path.resolve('src/main/llama.ts')))
  .digest('hex');
const manifest = {
  startedAt,
  deadlineMs,
  endpoint: settings.endpoint,
  adapterSha256,
  settings: { context: settings.context, outputTokens: settings.outputTokens },
  intentCases,
  chatCases,
  conditions: [
    'Existing llama-server configuration and model are unchanged. Test requests run sequentially with a 300 ms pause between cases.',
    'A separate two-hour endurance test requests a short response about once per minute. These are NOT exclusive server-speed measurements.',
    'No warmup requests and no repeated best-of selection. The existing server may already have a warm model/prompt cache. Cases run in the order listed.',
    'Intent accuracy is exact equality of intent, method, and target for these 20 fixed synthetic cases; it is not a general language-quality estimate. Chat pass means normal-chat routing, successful nonempty response and no file-completion claim. Sentence-count conformance is recorded separately; factual accuracy and naturalness are not automatically graded.',
    'Chat total TTFT starts before Llama.intent and ends at the first nonempty body delta from Llama.chat; template/token counting, routing inference and queueing are included.',
    'Server generation tokens/sec uses the SSE timings.predicted_per_second field when present, with its native token definition (which may include tokens absent from body text).',
    'Body tokens are separately re-tokenized with add_special=false and parse_special=false after completion. Body throughput divides that count by first-to-last body-delta time; it includes the first chunk in the numerator, so it is a short-output estimate, not an exact decoder rate. Retokenization time is excluded from latency/throughput.',
    'Natural-language yes is tested without a pending request or prior history. Quoted target names are expected not to designate the selected root.',
    'Ambiguous organization without a method is expected to clarify. Recursive organization is outside the approved MVP and is expected to be unsupported.',
  ],
};
await fs.writeFile(path.join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
const results: any = {
  ...manifest,
  server: null,
  intents: [],
  chats: [],
  finishedAt: null,
  summary: null,
};
async function save() {
  const file = path.join(directory, 'results.json'),
    temporary = file + '.tmp';
  await fs.writeFile(temporary, JSON.stringify(results, null, 2));
  await fs.rename(temporary, file);
}
await save();
console.log('ARTIFACT ' + directory);
const identical = (a: Intent, b: Intent) =>
  a.intent === b.intent && a.method === b.method && a.target === b.target;
const ms = (value: number) => Math.round(value * 100) / 100;
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 300));
const originalFetch = globalThis.fetch;
type Telemetry = {
  timings?: Record<string, number>;
  usage?: Record<string, number>;
  finishReason?: string;
};
let activeTelemetry: Telemetry | undefined;

// Observe existing SSE bytes without another inference request or a second stream consumer.
globalThis.fetch = async (input, init) => {
  const response = await originalFetch(input, init);
  const telemetry = activeTelemetry;
  if (!telemetry || !response.body || new URL(String(input)).pathname !== '/v1/chat/completions')
    return response;
  let body: any;
  try {
    body = JSON.parse(String(init?.body));
  } catch {
    return response;
  }
  if (body.stream !== true) return response;
  const decoder = new TextDecoder();
  let pending = '';
  const stream = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, sink) {
        pending += decoder.decode(chunk, { stream: true });
        let newline: number;
        while ((newline = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, newline).trim();
          pending = pending.slice(newline + 1);
          if (!line.startsWith('data:')) continue;
          try {
            const event = JSON.parse(line.slice(5).trim());
            if (event.timings) telemetry.timings = event.timings;
            if (event.usage) telemetry.usage = event.usage;
            const reason = event.choices?.[0]?.finish_reason;
            if (typeof reason === 'string') telemetry.finishReason = reason;
          } catch {}
        }
        sink.enqueue(chunk);
      },
    }),
  );
  return new Response(stream, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

const llm = new Llama(
  () => settings,
  () => '',
);
try {
  try {
    const models = await llm.connect(controller.signal);
    settings.model = models[0] || '';
    const response = await originalFetch(settings.endpoint + '/props', {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`props HTTP ${response.status}`);
    const props: any = await response.json();
    results.server = {
      models,
      selectedModel: settings.model,
      buildInfo: props.build_info,
      context: props.default_generation_settings?.n_ctx,
      totalSlots: props.total_slots,
      sampling: props.default_generation_settings?.params,
    };
  } catch (error) {
    results.server = { metadataError: message(error), selectedModel: settings.model };
  }
  await save();
  for (const item of intentCases) {
    if (controller.signal.aborted) {
      results.intents.push({ id: item.id, skipped: 'overall deadline reached' });
      continue;
    }
    const begin = performance.now();
    const row: any = {
      id: item.id,
      category: item.category,
      expected: item.expected,
      actual: null,
      pass: false,
      latencyMs: null,
      error: null,
    };
    try {
      row.actual = await llm.intent(item.text, item.selected, controller.signal);
      row.pass = identical(row.actual, item.expected);
    } catch (error) {
      row.error = message(error);
    }
    row.latencyMs = ms(performance.now() - begin);
    results.intents.push(row);
    await save();
    console.log(
      `${item.id} ${row.pass ? 'PASS' : 'FAIL'} ${row.latencyMs}ms ${JSON.stringify(row.actual || row.error)}`,
    );
    if (!controller.signal.aborted) await pause();
  }
  for (const item of chatCases) {
    if (controller.signal.aborted) {
      results.chats.push({ id: item.id, skipped: 'overall deadline reached' });
      continue;
    }
    const begin = performance.now();
    let first: number | undefined, last: number | undefined, chatStarted: number | undefined;
    const telemetry: Telemetry = {},
      row: any = {
        id: item.id,
        expected: item.expected,
        actualIntent: null,
        pass: false,
        body: '',
        deltaCount: 0,
        intentMs: null,
        totalTtftMs: null,
        chatTtftMs: null,
        totalMs: null,
        bodyStreamingMs: null,
        retokenizedBodyTokens: null,
        estimatedBodyTokensPerSecond: null,
        serverTokensPerSecond: null,
        telemetry,
        error: null,
        tokenizationError: null,
      };
    try {
      row.actualIntent = await llm.intent(item.text, item.selected, controller.signal);
      row.intentMs = ms(performance.now() - begin);
      if (!identical(row.actualIntent, item.expected.routing))
        throw new Error(
          'Routing did not select the expected normal-chat path. No generation request was sent.',
        );
      chatStarted = performance.now();
      activeTelemetry = telemetry;
      await llm.chat(
        [{ id: item.id, role: 'user', content: item.text, createdAt: Date.now() }],
        controller.signal,
        (text) => {
          if (!text.length) return;
          const now = performance.now();
          first ??= now;
          last = now;
          row.body += text;
          row.deltaCount++;
        },
        () => {
          row.historyTrimmed = true;
        },
      );
      row.pass = !!row.body.trim() && !/(整理|削除|移動|実行|復元|完了)しました/.test(row.body);
    } catch (error) {
      row.error = message(error);
    } finally {
      activeTelemetry = undefined;
    }
    const finished = performance.now();
    row.totalMs = ms(finished - begin);
    const trimmedBody = row.body.trim(),
      sentenceCount =
        (trimmedBody.match(/[。！？!?]/g) || []).length +
        (trimmedBody && !/[。！？!?]$/.test(trimmedBody) ? 1 : 0);
    row.contentReview = {
      sentenceCount,
      requestedSentences: item.expected.requestedSentences,
      sentenceCountMatches: sentenceCount === item.expected.requestedSentences,
      characters: Array.from(trimmedBody).length,
    };
    if (first !== undefined) {
      row.totalTtftMs = ms(first - begin);
      row.chatTtftMs = ms(first - chatStarted!);
      row.bodyStreamingMs = ms(last! - first);
    }
    const serverRate = telemetry.timings?.predicted_per_second;
    if (typeof serverRate === 'number' && Number.isFinite(serverRate))
      row.serverTokensPerSecond = serverRate;
    if (row.body && !controller.signal.aborted) {
      const tokenizeStart = performance.now();
      try {
        const response = await originalFetch(settings.endpoint + '/tokenize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: settings.model,
            content: row.body,
            add_special: false,
            parse_special: false,
            with_pieces: false,
          }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
          redirect: 'error',
        });
        if (!response.ok) throw new Error(`tokenize HTTP ${response.status}`);
        const data: any = await response.json();
        if (!Array.isArray(data.tokens)) throw new Error('Invalid token response');
        row.retokenizedBodyTokens = data.tokens.length;
        if (row.bodyStreamingMs > 0)
          row.estimatedBodyTokensPerSecond =
            Math.round(((data.tokens.length * 1000) / row.bodyStreamingMs) * 100) / 100;
      } catch (error) {
        row.tokenizationError = message(error);
      }
      row.retokenizeMs = ms(performance.now() - tokenizeStart);
    }
    results.chats.push(row);
    await save();
    console.log(
      `${item.id} ${row.pass ? 'PASS' : 'FAIL'} TTFT=${row.totalTtftMs}ms server=${row.serverTokensPerSecond}token/s body=${row.retokenizedBodyTokens}tokens ${row.error || ''}`,
    );
    if (!controller.signal.aborted) await pause();
  }
} catch (error) {
  results.fatalError = message(error);
} finally {
  clearTimeout(deadline);
  controller.abort();
  globalThis.fetch = originalFetch;
  const summarize = (values: number[]) => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    if (!sorted.length) return null;
    const percentile = (q: number) => {
      const at = (sorted.length - 1) * q,
        lo = Math.floor(at),
        hi = Math.ceil(at);
      return ms(sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo));
    };
    return {
      n: sorted.length,
      min: sorted[0],
      median: percentile(0.5),
      p95: percentile(0.95),
      max: sorted.at(-1),
    };
  };
  const completedIntents = results.intents.filter((r: any) => !r.skipped),
    completedChats = results.chats.filter((r: any) => !r.skipped),
    successfulChats = completedChats.filter((r: any) => r.pass);
  results.finishedAt = new Date().toISOString();
  results.elapsedMs = ms(performance.now() - started);
  results.summary = {
    intentCompleted: completedIntents.length,
    intentCorrect: completedIntents.filter((r: any) => r.pass).length,
    intentExpected: intentCases.length,
    intentAccuracy: completedIntents.length
      ? completedIntents.filter((r: any) => r.pass).length / completedIntents.length
      : null,
    intentLatencyMs: summarize(completedIntents.map((r: any) => r.latencyMs)),
    chatCompleted: completedChats.length,
    chatSuccessful: successfulChats.length,
    chatExpected: chatCases.length,
    totalTtftMs: summarize(
      successfulChats.map((r: any) => r.totalTtftMs).filter((n: any) => typeof n === 'number'),
    ),
    serverGenerationTokensPerSecond: summarize(
      successfulChats
        .map((r: any) => r.serverTokensPerSecond)
        .filter((n: any) => typeof n === 'number'),
    ),
    estimatedBodyTokensPerSecond: summarize(
      successfulChats
        .map((r: any) => r.estimatedBodyTokensPerSecond)
        .filter((n: any) => typeof n === 'number'),
    ),
    deadlineReached: results.elapsedMs >= deadlineMs,
  };
  await save();
  console.log('SUMMARY ' + JSON.stringify(results.summary));
  console.log('RESULT ' + path.join(directory, 'results.json'));
}
