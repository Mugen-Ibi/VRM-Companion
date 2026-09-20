import { z } from 'zod';
import type { Message, Settings } from '../shared/types';
export const IntentSchema = z
  .object({
    intent: z.enum(['chat', 'organize', 'clarify', 'unsupported']),
    method: z.enum(['by_extension']).nullable(),
    target: z.enum(['selected', 'unspecified', 'other']),
  })
  .strict();
export type Intent = z.infer<typeof IntentSchema>;
export function endpoint(input: string) {
  const url = new URL(input);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !['', '/'].includes(url.pathname)
  )
    throw new Error('接続先は http://127.0.0.1:ポート または http://[::1]:ポートにしてください。');
  return url.origin;
}
type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };
export function completedHistory(history: Message[]): ChatMessage[] {
  const turns: { user: Message; replies: Message[] }[] = [];
  for (const message of history) {
    if (message.role === 'user') turns.push({ user: message, replies: [] });
    else turns.at(-1)?.replies.push(message);
  }
  return turns.flatMap((turn, index) => {
    if (turn.replies.some((m) => m.status === 'error')) return [];
    if (!turn.replies.length && index !== turns.length - 1) return [];
    return [
      { role: 'user' as const, content: turn.user.content },
      ...(turn.replies.length
        ? [{ role: 'assistant' as const, content: turn.replies.map((m) => m.content).join('\n\n') }]
        : []),
    ];
  });
}
const templateOptions = { enable_thinking: false };
class HttpError extends Error {
  constructor(readonly status: number) {
    super(
      status === 503
        ? 'モデルを読み込み中です。しばらくして再試行してください。'
        : status === 401
          ? 'APIキーが一致しません。'
          : `LLMサーバーがエラーを返しました（HTTP ${status}）。設定とモデルを確認してください。`,
    );
  }
}
function interrupted(signal: AbortSignal) {
  return new Error(signal.aborted ? '応答を中断しました。' : '接続・応答がタイムアウトしました。');
}
export class Llama {
  constructor(
    private settings: () => Settings,
    private key: () => string,
  ) {}
  private async request(route: string, body: unknown | undefined, signal: AbortSignal) {
    const key = this.key();
    const response = await fetch(endpoint(this.settings().endpoint) + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      redirect: 'error',
    }).catch((error) => {
      if (signal.aborted) throw new Error('接続・応答が中断またはタイムアウトしました。');
      throw new Error('llama-serverに接続できません。起動とポートを確認してください。');
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(response.status);
    }
    return response;
  }
  async connect(signal: AbortSignal) {
    const timeout = AbortSignal.any([signal, AbortSignal.timeout(15000)]);
    const health = await this.request('/health', undefined, timeout);
    await health.body?.cancel();
    const data = (await (await this.request('/v1/models', undefined, timeout)).json()) as {
      data?: { id: string }[];
    };
    return (data.data ?? []).map((v) => v.id).filter((v) => typeof v === 'string');
  }
  private tokenCounter(s: Settings, signal: AbortSignal) {
    let supported = true;
    // Old servers without these endpoints can only provide a conservative estimate.
    const estimate = (messages: ChatMessage[]) =>
      messages.reduce((n, m) => n + Buffer.byteLength(m.content, 'utf8') + 128, 1024);
    return async (messages: ChatMessage[]) => {
      signal.throwIfAborted();
      if (!supported) return estimate(messages);
      try {
        // Use the same template options as generation, including its assistant prefix.
        // llama.cpp documents /apply-template and /tokenize in tools/server/README.md.
        const formatted = (await (
          await this.request(
            '/apply-template',
            {
              model: s.model || undefined,
              messages,
              chat_template_kwargs: templateOptions,
              add_generation_prompt: true,
            },
            signal,
          )
        ).json()) as { prompt?: unknown };
        if (typeof formatted.prompt !== 'string' || !formatted.prompt.length)
          throw new Error('モデルの会話テンプレートを確認できませんでした。');
        const tokenized = (await (
          await this.request(
            '/tokenize',
            {
              model: s.model || undefined,
              content: formatted.prompt,
              add_special: true,
              parse_special: true,
              with_pieces: false,
            },
            signal,
          )
        ).json()) as { tokens?: unknown };
        if (
          !Array.isArray(tokenized.tokens) ||
          !tokenized.tokens.length ||
          !tokenized.tokens.every((t) => Number.isInteger(t))
        )
          throw new Error('モデルのトークン数を確認できませんでした。');
        return tokenized.tokens.length;
      } catch (error) {
        // Authentication, invalid templates, disconnects and timeouts must not be hidden.
        if (error instanceof HttpError && [404, 405, 501].includes(error.status)) {
          supported = false;
          return estimate(messages);
        }
        throw error;
      }
    };
  }
  private async fitHistory(
    messages: ChatMessage[],
    s: Settings,
    signal: AbortSignal,
    onTrim: () => void,
  ) {
    const count = this.tokenCounter(s, signal),
      budget = s.context - s.outputTokens;
    if ((await count(messages)) <= budget) return messages;
    // Keep the latest user request and remove whole older turns, never orphan an assistant reply.
    const starts = messages.flatMap((m, i) => (i > 1 && m.role === 'user' ? [i] : []));
    const suffix = (i: number) => [messages[0], ...messages.slice(starts[i])];
    if (!starts.length || (await count(suffix(starts.length - 1))) > budget)
      throw new Error(
        '入力が文脈上限を超えています。短くするかコンテキスト設定を増やしてください。',
      );
    // Search boundedly rather than making two HTTP requests for every historical message.
    let low = 0,
      high = starts.length - 1;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if ((await count(suffix(mid))) <= budget) high = mid;
      else low = mid + 1;
    }
    onTrim();
    return suffix(low);
  }
  async intent(text: string, selected: boolean, signal: AbortSignal): Promise<Intent> {
    // Compact inline examples leave space for older servers' conservative byte budget.
    // Intent and target are independent: missing folder authority belongs to the app's confirmation step.
    const policy = [
      'Classify this single user turn; never execute it. Return only JSON with intent, method, target.',
      'Choose intent before target. Priority:',
      '1. chat: greetings, thanks, yes alone (no pending action), information-seeking questions, translation, or explanation/advice only. Polite questions requesting an action are ACTUAL requests. Quoted commands and filenames are data, not requests to execute.',
      '2. unsupported: an ACTUAL request to delete, rename, edit file contents, traverse subfolders/recursively sort, or group by project/date/meaning. This overrides any mention of sorting by extension/type.',
      '3. organize: an ACTUAL request to sort direct files by extension or file type. An explicit method without a target is still organize, NOT clarify.',
      '4. clarify: an ACTUAL sorting request that does not specify the method.',
      'A named or different folder is NOT an unsupported method. Sorting another folder by file type is organize with target=other.',
      'method="by_extension" only for organize; otherwise null.',
      'target is independent: selected ONLY for an EXPLICIT reference to the current/this/selected folder; other for ANY named folder, path or another folder; unspecified otherwise. Just "files" or an unnamed "folder" is unspecified. Never assume a selected folder. Ignore targets inside quoted examples or text to translate; quoted folder names used as actual targets still count.',
      'Examples (input => output):',
      '今見ているフォルダの下の階層も種類ごとに分けて => {"intent":"unsupported","method":null,"target":"selected"}',
      '資料置き場を片付けて => {"intent":"clarify","method":null,"target":"other"}',
      '少し整理を手伝ってほしい => {"intent":"clarify","method":null,"target":"unspecified"}',
      '移動はせずに、ファイルを分類する考え方を説明して => {"intent":"chat","method":null,"target":"unspecified"}',
      'Folder availability is handled by the application after classification.',
    ].join('\n');
    const messages: ChatMessage[] = [
      { role: 'system', content: policy },
      { role: 'user', content: '形式に応じてファイルを振り分けてください。' },
      {
        role: 'assistant',
        content: '{"intent":"organize","method":"by_extension","target":"unspecified"}',
      },
      { role: 'user', content: text },
    ];
    const s = this.settings(),
      controller = new AbortController(),
      requestSignal = AbortSignal.any([signal, controller.signal]);
    const timer = setTimeout(() => controller.abort(), 60000);
    try {
      if ((await this.tokenCounter(s, requestSignal)(messages)) + 192 > s.context)
        throw new Error('入力が長すぎます。依頼を短くしてください。');
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await this.request(
          '/v1/chat/completions',
          {
            model: s.model || undefined,
            messages,
            temperature: 0,
            max_tokens: 192,
            stream: false,
            chat_template_kwargs: templateOptions,
            response_format: {
              type: 'json_schema',
              json_schema: {
                name: 'companion_intent',
                strict: true,
                schema: {
                  type: 'object',
                  properties: {
                    intent: {
                      type: 'string',
                      enum: ['chat', 'organize', 'clarify', 'unsupported'],
                    },
                    method: { type: ['string', 'null'], enum: ['by_extension', null] },
                    target: { type: 'string', enum: ['selected', 'unspecified', 'other'] },
                  },
                  required: ['intent', 'method', 'target'],
                  additionalProperties: false,
                },
              },
            },
          },
          requestSignal,
        );
        const result = (await response.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        try {
          return IntentSchema.parse(JSON.parse(result.choices?.[0]?.message?.content ?? ''));
        } catch {
          if (attempt === 1)
            throw new Error('依頼を判定できませんでした。「種類別に整理」ボタンから操作できます。');
        }
      }
      throw new Error('意図を判定できません。');
    } catch (error) {
      if (requestSignal.aborted) throw interrupted(signal);
      throw error;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
  async chat(
    history: Message[],
    signal: AbortSignal,
    onDelta: (text: string) => void,
    onTrim: () => void,
  ) {
    const s = this.settings();
    const system: ChatMessage = {
      role: 'system',
      content: `あなたの名前は${s.persona}。ユーザーの呼び名は${s.userName || '指定なし'}。${s.style}\n日本語で応答する。この通常会話経路にはファイル操作機能はない。ファイル作業を実行・完了したと主張しない。作業結果はアプリの実行記録カードを案内する。`,
    };
    const allMessages: ChatMessage[] = [system, ...completedHistory(history)];
    const controller = new AbortController();
    const requestSignal = AbortSignal.any([signal, controller.signal]);
    const total = setTimeout(() => controller.abort(), 180000);
    let idle = setTimeout(() => controller.abort(), 60000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const messages = await this.fitHistory(allMessages, s, requestSignal, onTrim);
      clearTimeout(idle);
      idle = setTimeout(() => controller.abort(), 60000);
      const response = await this.request(
        '/v1/chat/completions',
        {
          model: s.model || undefined,
          messages,
          temperature: 0.7,
          max_tokens: s.outputTokens,
          stream: true,
          chat_template_kwargs: templateOptions,
        },
        requestSignal,
      );
      if (!response.body) throw new Error('応答ストリームがありません。');
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '',
        ended = false,
        count = 0;
      while (!ended) {
        requestSignal.throwIfAborted();
        const { value, done } = await reader.read();
        requestSignal.throwIfAborted();
        if (done) break;
        clearTimeout(idle);
        idle = setTimeout(() => controller.abort(), 30000);
        pending += decoder.decode(value, { stream: true });
        if (pending.length > 1_000_000) throw new Error('応答が大きすぎます。');
        let newline;
        while ((newline = pending.indexOf('\n')) >= 0) {
          requestSignal.throwIfAborted();
          const line = pending.slice(0, newline).trim();
          pending = pending.slice(newline + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            ended = true;
            break;
          }
          let parsed;
          try {
            parsed = JSON.parse(data);
          } catch {
            throw new Error('LLMサーバーの応答形式が不正です。再試行してください。');
          }
          if (!parsed || typeof parsed !== 'object')
            throw new Error('LLMサーバーの応答形式が不正です。');
          if (parsed.error) throw new Error('推論中にエラーが発生しました。');
          const text = parsed.choices?.[0]?.delta?.content;
          if (typeof text === 'string') {
            count += text.length;
            if (count > 100000) throw new Error('応答の上限を超えました。');
            onDelta(text);
          }
          if (parsed.choices?.[0]?.finish_reason === 'length')
            throw new Error(
              '応答トークン上限に達しました。表示済みの内容は途中までの応答です。必要に応じて応答上限を増やしてください。',
            );
        }
      }
      requestSignal.throwIfAborted();
      if (!ended) throw new Error('応答が途中で切断されました。再試行してください。');
      if (count === 0)
        throw new Error(
          '本文が生成されませんでした。モデルとチャットテンプレートを確認してください。',
        );
    } catch (error) {
      if (requestSignal.aborted) throw interrupted(signal);
      throw error;
    } finally {
      clearTimeout(total);
      clearTimeout(idle);
      // Parsing failures and limits must terminate server work just like explicit cancellation.
      controller.abort();
      if (reader) {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    }
  }
}
