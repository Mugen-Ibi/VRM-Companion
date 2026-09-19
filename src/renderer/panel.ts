import { CATEGORIES, type State, type Plan, type Category } from '../shared/types';
const api = window.companion,
  app = document.querySelector<HTMLDivElement>('#app')!;
let state: State,
  tab = 'chat',
  conversationId = '',
  draft = '',
  progress = '',
  connected = false,
  toastTimer: ReturnType<typeof setTimeout>;
type FieldDraft = { value: string; checked: boolean };
let settingsDraft: Map<string, FieldDraft> | null = null,
  settingsDraftVersion = 0,
  composing = false,
  renderPending = false;
const pages = new Map<string, number>();
const esc = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
const bytes = (n: number) =>
  n >= 1024 ** 3
    ? (n / 1024 ** 3).toFixed(2) + ' GiB'
    : n >= 1024 ** 2
      ? (n / 1024 ** 2).toFixed(1) + ' MiB'
      : (n / 1024).toFixed(1) + ' KiB';
const disabled = () => (state.busy ? 'disabled' : '');
function toast(text: string) {
  const el = document.querySelector<HTMLDivElement>('#toast')!;
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 6500);
}
async function action(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (error) {
    toast((error as Error).message.replace(/^Error invoking remote method '[^']+': Error: /, ''));
  }
}
function active() {
  return state.conversations.find((c) => c.id === conversationId) ?? state.conversations.at(-1)!;
}
function button(label: string, action: string, classes = '', extra = '') {
  return `<button class="${classes}" data-action="${action}" ${extra}>${label}</button>`;
}
const phaseNames = {
  idle: '待機中',
  thinking: '考えています',
  responding: '応答中',
  working: '作業中',
  success: '完了',
  error: '確認が必要です',
  canceled: '停止',
  attention: '要確認',
};
function rememberSettings(form: HTMLFormElement) {
  settingsDraft = new Map(
    Array.from(
      form.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea'),
      (el) => [
        el.id || el.name,
        { value: el.value, checked: el instanceof HTMLInputElement && el.checked },
      ],
    ),
  );
  settingsDraftVersion++;
}
function focusSnapshot() {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || !app.contains(el)) return;
  const id = el.id,
    name = el.getAttribute('name'),
    entry = el.dataset.entry;
  const selection =
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
      ? { start: el.selectionStart, end: el.selectionEnd }
      : undefined;
  return () => {
    const next = id
      ? document.getElementById(id)
      : name
        ? app.querySelector<HTMLElement>(`[name="${name}"]`)
        : entry
          ? app.querySelector<HTMLElement>(`[data-entry="${entry}"]`)
          : null;
    next?.focus({ preventScroll: true });
    if (
      selection?.start !== null &&
      selection?.start !== undefined &&
      selection.end !== null &&
      (next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement)
    )
      next.setSelectionRange(selection.start, selection.end);
  };
}
function render() {
  if (!state) return;
  if (composing) {
    renderPending = true;
    return;
  }
  renderPending = false;
  const restoreFocus = focusSnapshot(),
    oldScroll = document.querySelector('.chat-scroll');
  const keepScroll =
    oldScroll && oldScroll.scrollHeight - oldScroll.clientHeight - oldScroll.scrollTop > 32
      ? oldScroll.scrollTop
      : null;
  const c = active();
  conversationId = c.id;
  const currentAvatar = state.avatars.find((a) => a.id === state.settings.avatarId);
  const avatarVisibilityButton = button(
    state.avatarVisible ? 'アバターを隠す' : 'アバターを表示',
    'toggleAvatar',
    'avatar-visibility-toggle',
    !state.avatarVisible && !state.settings.avatarId ? 'disabled' : '',
  );
  const title =
    tab === 'chat'
      ? '会話'
      : tab === 'organize'
        ? 'フォルダを整える'
        : tab === 'avatars'
          ? 'アバター'
          : '設定';
  app.innerHTML = `<div class="shell"><aside class="sidebar"><div class="brand"><span class="brand-mark">c</span>Companion</div><div class="brand-sub">YOUR LOCAL SPACE</div><nav class="nav">${[
    ['chat', '◌', '会話'],
    ['organize', '▤', 'フォルダ整理'],
    ['avatars', '◇', 'アバター'],
    ['settings', '⚙', '設定'],
  ]
    .map(([id, icon, label]) =>
      button(
        `<span class="nav-icon">${icon}</span>${label}`,
        'tab',
        tab === id ? 'active' : '',
        `data-tab="${id}"`,
      ),
    )
    .join(
      '',
    )}</nav><div class="eyebrow sidebar-label">Conversations</div>${button('＋ 新しい会話', 'new', 'quiet small', disabled())}<div class="conversation-list">${[
    ...state.conversations,
  ]
    .reverse()
    .map((v) =>
      button(
        esc(v.title),
        'conversation',
        v.id === c.id ? 'selected' : '',
        `data-id="${v.id}" ${disabled()}`,
      ),
    )
    .join(
      '',
    )}</div><div class="sidebar-footer"><span class="dot"></span>ローカルで動作<br>あなたのPC、あなたの空間。</div></aside><main class="main"><header class="topbar"><div><h1>${title}</h1><div class="subtitle">${tab === 'chat' ? '日常のことも、小さなお手伝いも。' : tab === 'organize' ? '移動する前に、内容を一緒に確認。' : tab === 'avatars' ? 'あなたが選んだモデルを、デスクトップに。' : '会話と表示を、使いやすく。'}</div></div><div class="topbar-actions">${avatarVisibilityButton}<span class="pill">${phaseNames[state.phase]}</span></div></header><section class="content">${state.recoveryWarning ? `<div class="notice error" role="alert">${esc(state.recoveryWarning)}</div>` : ''}${tab === 'chat' ? chat(currentAvatar?.name) : tab === 'organize' ? organize() : tab === 'avatars' ? avatars() : settingsForm()}</section><footer class="statusline" id="progress">${esc(progress || 'VRM Companion · テキスト会話 / ローカル実行')}</footer></main></div>`;
  if (tab === 'chat') {
    const scroll = document.querySelector('.chat-scroll')!;
    scroll.scrollTop = keepScroll ?? scroll.scrollHeight;
  }
  app
    .querySelectorAll<HTMLElement>('[data-action]')
    .forEach((el) => el.addEventListener('click', () => run(el)));
  document
    .querySelector<HTMLTextAreaElement>('#message-input')
    ?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send();
      }
    });
  document
    .querySelector<HTMLTextAreaElement>('#message-input')
    ?.addEventListener('input', (e) => (draft = (e.target as HTMLTextAreaElement).value));
  app.querySelectorAll<HTMLSelectElement>('[data-entry]').forEach((el) =>
    el.addEventListener('change', () =>
      action(() =>
        api.editPlan(el.dataset.plan!, Number(el.dataset.rev), {
          [el.dataset.entry!]: el.value as Category,
        }),
      ),
    ),
  );
  const form = document.querySelector<HTMLFormElement>('#settings-form');
  if (form) {
    form
      .querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input,textarea')
      .forEach((el) => {
        const saved = settingsDraft?.get(el.id || el.name);
        if (saved) {
          el.value = saved.value;
          if (el instanceof HTMLInputElement) el.checked = saved.checked;
        }
      });
    form.addEventListener('input', () => rememberSettings(form));
    form.addEventListener('change', () => rememberSettings(form));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!state.busy) void action(saveSettings);
    });
  }
  restoreFocus?.();
}
function chat(avatarName?: string) {
  const c = active(),
    root = state.roots.find((r) => r.id === c.rootId && !r.revoked);
  return `<div class="chat-layout"><div class="chat-main"><div class="conversation-toolbar">${button('この会話を削除', 'deleteConversation', 'quiet small danger', `data-id="${c.id}" ${disabled()}`)}</div><div class="chat-scroll">${c.messages.length ? c.messages.map((m) => `<article class="message ${m.role} ${m.status === 'error' ? 'error' : ''}" data-message="${m.id}"><div class="author">${m.role === 'user' ? 'YOU' : esc(state.settings.persona)}</div><div class="message-text">${esc(m.content || '…')}</div>${m.status === 'error' ? button('前の入力を再入力', 'retryInput', 'quiet small', `data-id="${m.id}" ${disabled()}`) : ''}</article>`).join('') : `<div class="welcome"><span class="welcome-mark">✳</span><div class="eyebrow">A little company, on your desktop</div><h2>いつものデスクに、<br>もうひとつの居場所。</h2><p>好きなアバターと話したり、ファイルを整えたり。<br>まずはローカルLLMに接続して、ひとこと話しかけてみましょう。</p><div class="suggestions">${button('こんにちは', 'suggest', '', 'data-text="こんにちは"')}${button('今日の作業を一緒に考えて', 'suggest', '', 'data-text="今日の作業を一緒に考えて"')}</div></div>`}${state.pending?.conversationId === c.id ? `<div class="notice">${esc(state.pending.reason)}<div class="actions">${button('対象フォルダを選ぶ', 'selectRoot', 'small', disabled())}${button('種類別整理の案を作る', 'resolve', 'primary small', disabled())}${button('キャンセル', 'dismiss', 'quiet small')}</div></div>` : ''}${conversationPlans(c.id)}</div><div class="composer"><textarea id="message-input" aria-label="メッセージ" placeholder="メッセージを入力…" maxlength="6000">${esc(draft)}</textarea><div class="composer-bottom"><span>Enterで送信 · Shift+Enterで改行</span>${state.busy ? button('停止', 'cancel', 'danger') : button('送信 ↗', 'send', 'primary')}</div></div></div><aside><div class="aside-card"><div class="eyebrow">Your companion</div><div class="avatar-empty"><div class="orb"></div></div><h3>${esc(avatarName || 'あなたのVRMを選ぶ')}</h3><p>${avatarName ? 'モデルはデスクトップに表示されます。位置はドラッグで調整できます。' : 'モデルの探索・入手はユーザー自身で。対応するVRM 0.x / 1.0を読み込めます。'}</p>${button(avatarName ? 'デスクトップに表示' : 'VRMをインポート', avatarName ? 'showAvatar' : 'importAvatar', '', disabled())}</div><div class="aside-card"><div class="eyebrow">Workspace</div><h3>${root ? '整理対象を選択済み' : 'フォルダのお手伝い'}</h3><p>${esc(root?.path || '指定したフォルダの直下を種類別に。確認してから移動します。')}</p>${button('フォルダを選択', 'selectRoot', '', disabled())}${button('整理案を作る', 'propose', 'secondary-button', disabled())}</div><div class="setup-step"><b>${connected ? '●' : '○'}</b>${connected ? 'ローカルLLM接続済み' : '設定からLLMの接続を確認'}</div></aside></div>`;
}
function organize() {
  const c = active();
  const roots = state.roots.filter((r) => !r.revoked);
  return `<div class="section-heading"><h2>整理のワークスペース</h2>${button('＋ 対象フォルダ', 'selectRoot', '', disabled())}</div><p class="muted">直下のファイルを拡張子で分類します。元の名前を保ち、同名ファイルは上書きしません。</p><div class="card"><div class="eyebrow">Selected folders</div>${roots.length ? roots.map((r) => `<div class="root-row row spread"><span class="path">${esc(r.path)} ${r.id === c.rootId ? '✓' : ''}</span><span>${button('選択', 'chooseRoot', 'small', `data-id="${r.id}" ${disabled()}`)} ${button('許可解除', 'revokeRoot', 'small quiet danger', `data-id="${r.id}"`)}</span></div>`).join('') : '<p class="muted">対象フォルダはまだありません。通常のローカルNTFSフォルダを選択してください。</p>'}<div class="actions">${button('種類別の整理案を作成', 'propose', 'primary', disabled())}${state.busy ? button('処理を停止', 'cancel', 'danger') : ''}</div></div>${state.plans.some((p) => p.status === 'recovery') || state.recoveryWarning ? `<div class="notice error">前回の作業に未確定の項目があります。実行記録とファイルの状態を照合してください。<div class="actions">${button('状態を照合する', 'recover', '', disabled())}</div></div>` : ''}${state.plans.length ? state.plans.map(planCard).join('') : '<div class="empty-state"><div class="welcome-mark">▤</div><h3>まだ何も変更していません</h3><p class="muted">フォルダを選ぶと、ここに整理案が表示されます。<br>移動前にすべての変更を確認できます。</p></div>'}`;
}
const statuses: Record<Plan['status'], string> = {
  draft: '未検証',
  ready: '承認待ち',
  executing: '実行中',
  completed: '完了',
  partial: '一部完了',
  canceled: '停止',
  failed: '失敗',
  stale: '再検証が必要',
  recovery: '照合が必要',
  reviewed: '手動確認済み',
};
function planCard(p: Plan) {
  const root = state.roots.find((r) => r.id === p.rootId);
  const editable = ['draft', 'ready', 'stale'].includes(p.status) && !p.undoOf;
  const page = pages.get(p.id) || 0;
  const entries = p.entries.slice(page * 50, (page + 1) * 50);
  return `<div class="card"><div class="row spread"><div class="plan-title">${p.undoOf ? '元の場所へ戻す' : '種類別に整える'}<span class="tag">${statuses[p.status]}</span></div><span class="muted">${new Date(p.createdAt).toLocaleString('ja-JP')}</span></div><p class="path">${esc(root?.path || '許可解除済み')}</p><p class="muted">候補 ${p.entries.filter((e) => !e.excluded && e.category !== '変更なし').length}件 · ${bytes(p.totalBytes)} · 1ファイル512MiB / 合計2GiB / 200件まで</p>${p.error ? `<div class="notice error">${esc(p.error)}</div>` : ''}${editable ? `<div class="table-wrap"><table><thead><tr><th>ファイル / 理由</th><th>サイズ</th><th>移動先</th></tr></thead><tbody>${entries.map((e) => `<tr><td>${esc(e.name)}<div class="reason">${esc(e.reason)}</div></td><td>${bytes(e.size)}</td><td><select aria-label="${esc(e.name)}の分類" data-entry="${e.id}" data-plan="${p.id}" data-rev="${p.revision}" ${e.excluded || state.busy ? 'disabled' : ''}>${CATEGORIES.map((cat) => `<option ${cat === e.category ? 'selected' : ''}>${cat}</option>`).join('')}</select></td></tr>`).join('')}</tbody></table></div><div class="row spread"><span class="muted">${Math.min(page * 50 + 1, p.entries.length)}–${Math.min((page + 1) * 50, p.entries.length)} / ${p.entries.length}</span><span>${button('前へ', 'page', 'small quiet', `data-id="${p.id}" data-page="${page - 1}" ${page === 0 ? 'disabled' : ''}`)}${button('次へ', 'page', 'small quiet', `data-id="${p.id}" data-page="${page + 1}" ${(page + 1) * 50 >= p.entries.length ? 'disabled' : ''}`)}</span></div>` : ''}${p.operations.length ? `<div class="table-wrap"><table><thead><tr><th>移動元</th><th>移動先</th><th>状態</th></tr></thead><tbody>${p.operations.map((o) => `<tr><td>${esc(o.from || 'フォルダ作成')}</td><td>${esc(o.to)}</td><td>${esc({ pending: '未実行', intent: '実行記録あり', done: '完了', failed: '失敗', unresolved: '未確定', unverified: '成否未確定・手動確認済み' }[o.state])}${o.error ? `<div class="reason">${esc(o.error)}</div>` : ''}</td></tr>`).join('')}</tbody></table></div>` : ''}${
    p.undoOf
      ? p.entries
          .filter((e) => e.excluded)
          .map((e) => `<p class="muted">対象外: ${esc(e.name)} — ${esc(e.excluded)}</p>`)
          .join('')
      : ''
  }<div class="actions">${editable ? button('内容を検証する', 'prepare', '', `data-id="${p.id}" ${disabled()}`) : ''}${p.status === 'ready' ? button('この内容で' + (p.undoOf ? '戻す' : '整理する'), 'approve', 'primary', `data-id="${p.id}" data-rev="${p.revision}" data-hash="${p.hash}" ${disabled()}`) : ''}${['completed', 'partial', 'canceled', 'failed', 'reviewed'].includes(p.status) && !p.undoOf ? button('復元案を確認', 'undo', '', `data-id="${p.id}" ${disabled()}`) : ''}${p.status === 'recovery' ? button('実ファイルを手動確認して照合を終了', 'acknowledgeRecovery', 'quiet small', `data-id="${p.id}" data-rev="${p.revision}" ${disabled()}`) : ''}${!['executing', 'recovery'].includes(p.status) ? button('記録を削除', 'deleteJob', 'quiet small', `data-id="${p.id}" ${disabled()}`) : ''}</div>${p.status === 'ready' ? '<p class="muted">表示中の変更だけを一括承認します。10分経過・再起動・対象変更で承認は失効します。</p>' : ''}</div>`;
}
function avatars() {
  return `<div class="section-heading"><h2>あなたのアバター</h2>${button('＋ VRMをインポート', 'importAvatar', 'primary', disabled())}</div><p class="muted">モデルの探索・選定・入手はユーザーに委ねます。外見やキャラクター設定による制限はありません。</p><div class="notice">VRM 0.x / 1.0、100MiB以下。モデルにない表情は省略し、状態は会話画面で表示します。</div>${state.avatars.length ? `<div class="card">${state.avatars.map((a) => `<div class="avatar-item"><div class="row spread"><strong>${esc(a.name)} ${a.id === state.settings.avatarId ? '✓' : ''}</strong><span class="tag">VRM ${a.version === '1' ? '1.0' : '0.x'}</span></div><p class="muted">作者: ${esc(a.authors)} · ${bytes(a.size)}</p><div class="license">${esc(a.license)}</div><div class="actions">${button('表示する', 'selectAvatar', 'small', `data-id="${a.id}"`)}${button('管理コピーを削除', 'deleteAvatar', 'small quiet danger', `data-id="${a.id}"`)}</div></div>`).join('')}</div>` : '<div class="empty-state"><div class="avatar-empty"><div class="orb"></div></div><h3>まだアバターがありません</h3><p class="muted">お手元のVRMファイルをインポートしてください。<br>原本は変更せず、アプリの保存領域へコピーします。</p></div>'}`;
}
function settingsForm() {
  const s = state.settings;
  return `<form id="settings-form"><div class="card"><div class="eyebrow">Local intelligence</div><h3>ローカルLLM</h3><p class="muted">起動済みのllama-serverに接続します。モデルのダウンロードや外部通信は行いません。</p><div class="form-grid"><div><label for="endpoint">接続先</label><input id="endpoint" name="endpoint" value="${esc(s.endpoint)}" required></div><div><label for="model">モデルID（空欄なら接続時に取得）</label><input id="model" name="model" value="${esc(s.model)}"></div><div><label for="context">コンテキスト上限</label><input id="context" name="context" type="number" min="1024" max="131072" value="${s.context}"></div><div><label for="outputTokens">応答トークン上限</label><input id="outputTokens" name="outputTokens" type="number" min="64" max="4096" value="${s.outputTokens}"></div><div class="wide"><label for="api-key">APIキー（任意）</label><input id="api-key" type="password" autocomplete="off" placeholder="${state.hasApiKey ? '保存済み。変更するときだけ入力' : '未設定'}"><label class="check"><input id="clear-key" type="checkbox">保存済みキーを削除</label></div></div><div class="actions">${button('設定を保存', 'saveSettings', 'primary', `type="button" ${disabled()}`)}${button('接続を確認', 'connect', '', `type="button" ${disabled()}`)}</div></div><div class="card"><div class="eyebrow">Personality</div><h3>話し方</h3><div class="form-grid"><div><label for="persona">キャラクター名</label><input id="persona" name="persona" maxlength="80" value="${esc(s.persona)}"></div><div><label for="userName">あなたの呼び名</label><input id="userName" name="userName" maxlength="80" value="${esc(s.userName)}"></div><div class="wide"><label for="style">口調・応答の好み</label><textarea id="style" name="style" rows="3" maxlength="2000">${esc(s.style)}</textarea></div></div></div><div class="card"><div class="eyebrow">Desktop & storage</div><h3>表示と保存</h3><div class="form-grid"><div><label for="scale">アバター倍率（0.5〜1.8）</label><input id="scale" name="scale" type="number" step="0.1" min="0.5" max="1.8" value="${s.scale}"></div><div><label for="fps">描画上限fps（10〜60）</label><input id="fps" name="fps" type="number" min="10" max="60" value="${s.fps}"></div></div><label class="check"><input name="alwaysOnTop" type="checkbox" ${s.alwaysOnTop ? 'checked' : ''}>アバターを最前面に表示</label><label class="check"><input name="autoStart" type="checkbox" ${s.autoStart ? 'checked' : ''}>Windowsログイン時に起動</label><label class="check"><input name="saveHistory" type="checkbox" ${s.saveHistory ? 'checked' : ''}>会話履歴を保存する</label><p class="muted">履歴保存を無効にしても、ファイル操作の復旧記録は保存します。既存の会話は「全履歴を削除」で消せます。保存データはOSアカウントの権限で保護します。会話削除は通常のバックアップにも反映します。復旧用に保管した damaged- フォルダと外部へコピーしたバックアップは残るため、必要なら保存先から別途削除してください。</p><div class="path">${esc(state.dataPath)}</div><div class="actions">${button('設定を保存', 'saveSettings', 'primary', `type="button" ${disabled()}`)}${button('保存先を開く', 'openData', '', 'type="button"')}${button('バックアップを作成', 'backupData', '', `type="button" ${disabled()}`)}${button('全履歴を削除', 'clearHistory', 'quiet danger', `type="button" ${disabled()}`)}</div></div></form>`;
}
function conversationPlans(id: string) {
  const plans = state.plans.filter((p) => p.conversationId === id);
  if (!plans.length) return '';
  return `<section class="chat-plans" aria-label="この会話の整理案と作業記録"><div class="row spread"><h3>整理案と作業記録</h3>${button('すべての記録を開く', 'tab', 'quiet small', 'data-tab="organize"')}</div>${plans.slice(0, 3).map(planCard).join('')}</section>`;
}
async function saveSettings() {
  const form = document.querySelector<HTMLFormElement>('#settings-form')!,
    version = settingsDraftVersion;
  const data = new FormData(form),
    s = { ...state.settings };
  for (const key of ['endpoint', 'model', 'persona', 'userName', 'style'] as const)
    s[key] = String(data.get(key) || '');
  for (const key of ['context', 'outputTokens', 'scale', 'fps'] as const)
    s[key] = Number(data.get(key));
  for (const key of ['alwaysOnTop', 'autoStart', 'saveHistory'] as const) s[key] = data.has(key);
  const key = document.querySelector<HTMLInputElement>('#api-key')!.value;
  state = await api.settings(
    s,
    document.querySelector<HTMLInputElement>('#clear-key')!.checked ? '' : key || undefined,
  );
  if (version === settingsDraftVersion) settingsDraft = null;
  connected = false;
  render();
}
function fillComposer(text: string) {
  draft = text;
  render();
  const input = document.querySelector<HTMLTextAreaElement>('#message-input');
  input?.focus();
  input?.setSelectionRange(text.length, text.length);
}
function send() {
  if (state.busy || !draft.trim()) return;
  const text = draft;
  draft = '';
  const input = document.querySelector<HTMLTextAreaElement>('#message-input');
  if (input) input.value = '';
  action(() => api.send(conversationId, text));
}
function run(el: HTMLElement) {
  const a = el.dataset.action,
    id = el.dataset.id!;
  if (a === 'tab') {
    tab = el.dataset.tab!;
    render();
    return;
  }
  if (a === 'conversation') {
    conversationId = id;
    tab = 'chat';
    render();
    return;
  }
  if (a === 'suggest') {
    fillComposer(el.dataset.text!);
    return;
  }
  if (a === 'retryInput') {
    const messages = active().messages,
      index = messages.findIndex((m) => m.id === id);
    const user = messages
      .slice(0, index)
      .reverse()
      .find((m) => m.role === 'user');
    if (user) {
      fillComposer(user.content);
      toast('前の入力を戻しました。内容を確認して送信してください。');
    }
    return;
  }
  if (a === 'send') {
    send();
    return;
  }
  if (a === 'page') {
    pages.set(id, Number(el.dataset.page));
    render();
    return;
  }
  action(async () => {
    switch (a) {
      case 'new':
        conversationId = await api.newConversation();
        tab = 'chat';
        render();
        break;
      case 'deleteConversation':
        if (confirm('この会話の履歴を削除しますか？作業記録は残ります。'))
          await api.deleteConversation(id);
        break;
      case 'cancel':
        await api.cancel();
        break;
      case 'selectRoot':
        await api.selectRoot(conversationId);
        break;
      case 'chooseRoot':
        await api.chooseRoot(conversationId, id);
        break;
      case 'revokeRoot':
        await api.revokeRoot(id);
        break;
      case 'propose':
        tab = 'organize';
        render();
        await api.propose(conversationId);
        break;
      case 'resolve':
        tab = 'organize';
        const pending = state.pending!.id;
        render();
        await api.resolvePending(pending);
        break;
      case 'dismiss':
        await api.dismissPending();
        break;
      case 'prepare':
        await api.prepare(id);
        break;
      case 'approve':
        await api.approve(id, Number(el.dataset.rev), el.dataset.hash!);
        break;
      case 'undo':
        await api.undo(id);
        break;
      case 'recover':
        await api.recover();
        break;
      case 'acknowledgeRecovery':
        await api.acknowledgeRecovery(id, Number(el.dataset.rev));
        break;
      case 'deleteJob':
        if (confirm('記録を削除すると、この記録から復元できなくなります。削除しますか？'))
          await api.deleteJob(id);
        break;
      case 'importAvatar':
        await api.importAvatar();
        break;
      case 'selectAvatar':
        await api.selectAvatar(id);
        break;
      case 'deleteAvatar':
        if (confirm('アプリが保存したモデルのコピーを削除しますか？原本は残ります。'))
          await api.deleteAvatar(id);
        break;
      case 'showAvatar':
        await api.showAvatar();
        break;
      case 'toggleAvatar':
        if (state.avatarVisible) await api.hideAvatar();
        else if (state.settings.avatarId) await api.showAvatar();
        break;
      case 'saveSettings':
        await saveSettings();
        toast('設定を保存しました');
        break;
      case 'connect':
        await saveSettings();
        const result = await api.connect();
        connected = true;
        toast(result.message);
        render();
        break;
      case 'clearHistory':
        if (confirm('保存済みの会話履歴をすべて削除しますか？作業記録は残ります。'))
          await api.clearHistory();
        break;
      case 'backupData':
        toast('バックアップを作成しました。\n' + (await api.backupData()));
        break;
      case 'openData':
        await api.openData();
        break;
    }
  });
}
app.addEventListener('compositionstart', () => {
  composing = true;
});
app.addEventListener('compositionend', () => {
  composing = false;
  queueMicrotask(() => {
    if (renderPending) render();
  });
});
api.onEvent((event) => {
  if (event.type === 'state') {
    state = event.state;
    render();
  } else if (event.type === 'delta') {
    const m = state.conversations
      .find((c) => c.id === event.conversationId)
      ?.messages.find((m) => m.id === event.messageId);
    if (m) m.content += event.text;
    const node = app.querySelector(`[data-message="${event.messageId}"] .message-text`);
    if (node && m) node.textContent = m.content;
    const scroll = document.querySelector('.chat-scroll');
    if (scroll && scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 80)
      scroll.scrollTop = scroll.scrollHeight;
  } else if (event.type === 'progress') {
    progress =
      event.text +
      (event.total ? ` · ${event.done.toLocaleString()} / ${event.total.toLocaleString()}` : '');
    const node = document.querySelector('#progress');
    if (node) node.textContent = progress;
  } else toast(event.message);
});
api
  .state()
  .then((value) => {
    state = value;
    render();
  })
  .catch((e) => toast(e.message));
