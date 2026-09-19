import { Llama } from '../src/main/llama';
import { DEFAULTS } from '../src/shared/types';
import fs from 'node:fs/promises';
const url = process.env.COMPANION_LLM_URL || 'http://127.0.0.1:8080';
const settings = { ...DEFAULTS, endpoint: url };
const llama = new Llama(
  () => settings,
  () => '',
);
const models = await llama.connect(new AbortController().signal);
settings.model = models[0] ?? '';
const results: unknown[] = [];
for (const [text, selected, expected] of [
  ['こんにちは', false, 'chat'],
  ['このフォルダを種類別に整理して', true, 'organize'],
  ['ダウンロードを案件別に整理して', false, 'unsupported'],
  ['ファイルを消して', false, 'unsupported'],
  ['フォルダを整理する方法を教えて', true, 'chat'],
  ['整理して', false, 'clarify'],
] as const) {
  const start = performance.now();
  try {
    const result = await llama.intent(text, selected, new AbortController().signal);
    const row = { text, expected, result, ms: Math.round(performance.now() - start) };
    results.push(row);
    console.log(JSON.stringify(row));
  } catch (error) {
    const row = { text, error: (error as Error).message };
    results.push(row);
    console.log(row);
  }
}
const start = performance.now();
let first = 0,
  answer = '';
await llama.chat(
  [
    {
      id: 'real-check',
      role: 'user',
      content: 'こんにちは。日本語で短く挨拶してください。',
      createdAt: Date.now(),
    },
  ],
  new AbortController().signal,
  (text) => {
    if (!first) first = performance.now();
    answer += text;
  },
  () => {},
);
results.push({
  chat: answer,
  firstTokenMs: Math.round(first - start),
  totalMs: Math.round(performance.now() - start),
});
console.log(results.at(-1));
await fs.mkdir('artifacts', { recursive: true });
await fs.writeFile(
  'artifacts/llama-verification.json',
  JSON.stringify({ endpoint: url, models, results }, null, 2),
);
