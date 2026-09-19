import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  Tray,
  Menu,
  nativeImage,
  screen,
  session,
  safeStorage,
  shell,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  DEFAULTS,
  CATEGORIES,
  type Settings,
  type State,
  type Phase,
  type AppEvent,
  type Root,
  type Plan,
  type Avatar,
  type Pending,
  type Conversation,
  type Message,
} from '../shared/types';
import { Store } from './store';
import { Organizer, NativeFiles } from './files';
import { Llama, endpoint } from './llama';
import { inspectVRM } from './vrm';

const base = app.getAppPath(),
  panelFile = path.join(base, 'dist/renderer/index.html'),
  avatarFile = path.join(base, 'dist/renderer/avatar.html');
// Isolated test data is accepted only in a non-packaged test launch.
if (!app.isPackaged && process.env.COMPANION_TEST_DATA)
  app.setPath('userData', path.resolve(process.env.COMPANION_TEST_DATA));
// An explicit launch option supports isolated/portable data for both packaged and source builds.
const requestedData = app.commandLine.getSwitchValue('user-data-dir');
if (requestedData) app.setPath('userData', path.resolve(requestedData));
let panel: BrowserWindow,
  avatarWindow: BrowserWindow,
  tray: Tray,
  store: Store,
  organizer: Organizer;
let settings: Settings,
  phase: Phase = 'idle',
  busy = false,
  controller: AbortController | null = null,
  pending: Pending | null = null;
let conversations: Conversation[] = [],
  quitting = false,
  interaction: 'auto' | 'move' | 'pass' = 'auto',
  preview: Avatar | null = null;
let previewTimer: ReturnType<typeof setTimeout> | undefined;
let previewGeneration = 0,
  avatarDialogOpen = false;
let ignoredMouse: boolean | undefined;
let recoveryWarning: string | undefined;
const idSchema = z.string().uuid(),
  textSchema = z.string().min(1).max(6000);
const settingsSchema = z
  .object({
    endpoint: z.string().max(200),
    model: z.string().max(200),
    context: z.number().int().min(1024).max(131072),
    outputTokens: z.number().int().min(64).max(4096),
    persona: z.string().min(1).max(80),
    userName: z.string().max(80),
    style: z.string().max(2000),
    saveHistory: z.boolean(),
    avatarId: z.string().uuid().nullable(),
    avatarVisible: z.boolean(),
    scale: z.number().min(0.5).max(1.8),
    fps: z.number().int().min(10).max(60),
    alwaysOnTop: z.boolean(),
    autoStart: z.boolean(),
    avatarX: z.number().optional(),
    avatarY: z.number().optional(),
  })
  .strict();
function effectiveSettings() {
  return preview ? { ...settings, avatarId: preview.id } : settings;
}
function state(): State {
  return {
    settings,
    avatarVisible:
      !!avatarWindow &&
      !avatarWindow.isDestroyed() &&
      avatarWindow.isVisible() &&
      !avatarWindow.isMinimized(),
    roots: store
      .list<Root>('roots')
      .map((root) => ({ ...root, revoked: organizer.isRevoked(root.id) })),
    plans: store.list<Plan>('plans').reverse(),
    conversations,
    avatars: store.list<Avatar>('avatars'),
    pending,
    phase,
    busy,
    dataPath: store.directory,
    hasApiKey: !!store.get('secrets', 'apiKey'),
    recoveryWarning: organizer.journalFault || recoveryWarning,
  };
}
function emit(event: AppEvent) {
  if (panel && !panel.isDestroyed()) panel.webContents.send('companion:event', event);
}
function avatarState() {
  return {
    settings: effectiveSettings(),
    phase,
    visible: avatarWindow.isVisible() && !avatarWindow.isMinimized(),
  };
}
function updateAvatar() {
  if (avatarWindow && !avatarWindow.isDestroyed())
    avatarWindow.webContents.send('avatar:update', avatarState());
}
function broadcast() {
  emit({ type: 'state', state: state() });
  updateAvatar();
}
function persist(c: Conversation) {
  if (settings.saveHistory) store.put('conversations', c.id, c);
}
function conversation(id: string) {
  const c = conversations.find((c) => c.id === id);
  if (!c) throw new Error('会話が見つかりません。');
  return c;
}
function message(c: Conversation, role: Message['role'], content: string) {
  const m: Message = { id: randomUUID(), role, content, createdAt: Date.now() };
  c.messages.push(m);
  persist(c);
  return m;
}
function newConversation() {
  pending = null;
  const c: Conversation = { id: randomUUID(), title: '新しい会話', messages: [] };
  conversations.push(c);
  persist(c);
  return c.id;
}
function apiKey() {
  const secret = store.get<string>('secrets', 'apiKey');
  return secret ? safeStorage.decryptString(Buffer.from(secret, 'base64')) : '';
}
const llm = new Llama(() => settings, apiKey);
async function task(
  fn: (signal: AbortSignal) => Promise<void | Phase>,
  taskPhase: Phase = 'working',
) {
  if (busy) throw new Error('処理中です。停止してから操作してください。');
  busy = true;
  phase = taskPhase;
  controller = new AbortController();
  try {
    broadcast();
    const outcome = await fn(controller.signal);
    phase = outcome || (controller.signal.aborted ? 'canceled' : 'success');
  } catch (error) {
    phase = controller.signal.aborted ? 'canceled' : 'error';
    throw error;
  } finally {
    busy = false;
    controller = null;
    broadcast();
  }
}
function idleOnly() {
  if (busy) throw new Error('処理中です。停止してから操作してください。');
}
function verifySender(
  event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent,
  window: BrowserWindow,
  file: string,
) {
  if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame)
    throw new Error('許可されていない送信元です。');
  const url = new URL(event.senderFrame.url);
  if (url.protocol !== 'file:' || path.resolve(fileURLToPath(url)) !== path.resolve(file))
    throw new Error('許可されていない画面です。');
}
function handle(name: string, fn: (...args: any[]) => unknown) {
  ipcMain.handle(`companion:${name}`, async (event, ...args) => {
    try {
      verifySender(event, panel, panelFile);
      return { ok: true, value: await fn(...args) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '操作に失敗しました。' };
    }
  });
}
function configureWindow(win: BrowserWindow) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
}
function showPanel() {
  panel.show();
  panel.focus();
}
function setAvatarVisible(visible: boolean) {
  if (visible && !effectiveSettings().avatarId) return;
  settings = { ...settings, avatarVisible: visible };
  if (visible) {
    if (avatarWindow.webContents.isCrashed()) avatarWindow.reload();
    avatarWindow.showInactive();
  } else avatarWindow.hide();
  // Hiding remains available even if preferences cannot currently be saved.
  try {
    store.put('settings', 'main', settings);
  } catch {
    emit({
      type: 'error',
      message:
        'アバターの表示設定を保存できませんでした。次回起動時には以前の設定に戻る場合があります。',
    });
  }
  broadcast();
}
function ignoreMouse(value: boolean) {
  if (ignoredMouse === value) return;
  avatarWindow.setIgnoreMouseEvents(value, { forward: true });
  ignoredMouse = value;
}
function configureInteraction() {
  ignoreMouse(interaction !== 'move');
}
async function discardPreview() {
  clearTimeout(previewTimer);
  previewTimer = undefined;
  const old = preview;
  preview = null;
  if (old && !store.get('avatars', old.id))
    await fs.rm(path.join(store.directory, 'avatars', old.id + '.vrm'), { force: true });
}
async function startPreview(candidate: Avatar) {
  const generation = ++previewGeneration;
  await discardPreview();
  if (generation !== previewGeneration) {
    if (!store.get('avatars', candidate.id))
      await fs.rm(path.join(store.directory, 'avatars', candidate.id + '.vrm'), { force: true });
    return;
  }
  preview = candidate;
  settings = { ...settings, avatarVisible: true };
  avatarWindow.showInactive();
  broadcast();
  previewTimer = setTimeout(() => {
    if (preview?.id === candidate.id)
      void discardPreview()
        .then(() => {
          emit({
            type: 'error',
            message: 'VRM読み込みがタイムアウトしました。以前のモデルを維持します。',
          });
          broadcast();
        })
        .catch((error) => emit({ type: 'error', message: String(error) }));
  }, 30000);
}
function safePosition() {
  const bounds = avatarWindow.getBounds();
  const displays = screen.getAllDisplays();
  if (
    !displays.some(
      (d) =>
        bounds.x >= d.workArea.x &&
        bounds.y >= d.workArea.y &&
        bounds.x + bounds.width <= d.workArea.x + d.workArea.width &&
        bounds.y + bounds.height <= d.workArea.y + d.workArea.height,
    )
  ) {
    const a = screen.getPrimaryDisplay().workArea;
    avatarWindow.setPosition(a.x + a.width - 400, a.y + a.height - 550);
  }
}
function createWindows() {
  panel = new BrowserWindow({
    width: 1120,
    height: 810,
    minWidth: 820,
    minHeight: 600,
    title: 'VRM Companion',
    backgroundColor: '#f6f5f2',
    webPreferences: {
      preload: path.join(base, 'dist/preload/panel.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });
  panel.setMenuBarVisibility(false);
  configureWindow(panel);
  panel.loadFile(panelFile);
  panel.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      panel.hide();
    }
  });
  avatarWindow = new BrowserWindow({
    width: 380,
    height: 540,
    x: settings.avatarX,
    y: settings.avatarY,
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: settings.alwaysOnTop,
    show: false,
    webPreferences: {
      preload: path.join(base, 'dist/preload/avatar.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  configureWindow(avatarWindow);
  avatarWindow.loadFile(avatarFile);
  safePosition();
  configureInteraction();
  avatarWindow.once('ready-to-show', () => {
    if (settings.avatarId && settings.avatarVisible) avatarWindow.showInactive();
  });
  const visibilityChanged = () => {
    if (!quitting) broadcast();
  };
  avatarWindow.on('show', visibilityChanged);
  avatarWindow.on('hide', visibilityChanged);
  avatarWindow.on('minimize', visibilityChanged);
  avatarWindow.on('restore', visibilityChanged);
  avatarWindow.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      setAvatarVisible(false);
    }
  });
  avatarWindow.webContents.on('render-process-gone', () => {
    void discardPreview().catch(() => {});
    phase = 'error';
    emit({
      type: 'error',
      message: 'アバター表示が停止しました。会話パネルの「アバターを表示」から再開できます。',
    });
  });
  screen.on('display-removed', safePosition);
  screen.on('display-metrics-changed', safePosition);
  // A raster tray mark avoids the unsupported SVG / one-pixel fallback path.
  const pixels = Buffer.alloc(32 * 32 * 4);
  for (let y = 2; y < 30; y++)
    for (let x = 2; x < 30; x++) {
      const check =
        (x >= 8 && x <= 14 && Math.abs(y - x - 6) < 2) ||
        (x >= 14 && x <= 24 && Math.abs(y - (34 - x)) < 2);
      pixels.set(check ? [255, 255, 255, 255] : [106, 113, 53, 255], (y * 32 + x) * 4);
    }
  const trayIcon = nativeImage
    .createFromBitmap(pixels, { width: 32, height: 32 })
    .resize({ width: 16, height: 16 });
  tray = new Tray(trayIcon);
  tray.setToolTip('VRM Companion');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '会話を開く', click: showPanel },
      {
        label: 'アバターを表示',
        click: () => setAvatarVisible(true),
      },
      { label: 'アバターを隠す', click: () => setAvatarVisible(false) },
      { type: 'separator' },
      ...(['auto', 'move', 'pass'] as const).map((mode, i) => ({
        label: ['自動クリック透過', '移動モード（透過解除）', '全体クリック透過'][i],
        click: () => {
          interaction = mode;
          configureInteraction();
        },
      })),
      {
        label: '処理を停止',
        click: () => {
          controller?.abort();
          organizer.canceled = true;
        },
      },
      { type: 'separator' },
      {
        label: '終了',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on('double-click', showPanel);
}
function registerAPI() {
  handle('state', () => state());
  handle('settings', (value: unknown, key: unknown) => {
    idleOnly();
    const next = settingsSchema.parse(value);
    endpoint(next.endpoint);
    if (next.outputTokens >= next.context / 2)
      throw new Error('応答上限は文脈上限の半分未満にしてください。');
    // Settings cannot choose arbitrary avatars or position windows; dedicated methods do that.
    next.avatarId = settings.avatarId;
    next.avatarVisible = settings.avatarVisible;
    next.avatarX = settings.avatarX;
    next.avatarY = settings.avatarY;
    if (key !== undefined) {
      const secret = z.string().max(512).parse(key);
      if (secret) {
        if (!safeStorage.isEncryptionAvailable())
          throw new Error('APIキーを安全に保存できません。');
        store.put('secrets', 'apiKey', safeStorage.encryptString(secret).toString('base64'));
      } else store.delete('secrets', 'apiKey');
    }
    store.put('settings', 'main', next);
    settings = next;
    avatarWindow.setAlwaysOnTop(settings.alwaysOnTop);
    app.setLoginItemSettings({ openAtLogin: settings.autoStart });
    broadcast();
    return state();
  });
  handle('connect', async () => {
    let models: string[] = [];
    await task(async (signal) => {
      models = await llm.connect(signal);
      if (!settings.model && models[0]) {
        settings.model = models[0];
        store.put('settings', 'main', settings);
      }
    }, 'thinking');
    return { models, message: 'llama-serverに接続しました。' };
  });
  handle('newConversation', () => {
    idleOnly();
    const id = newConversation();
    broadcast();
    return id;
  });
  handle('deleteConversation', (id: unknown) => {
    idleOnly();
    const value = idSchema.parse(id);
    store.delete('conversations', value);
    conversations = conversations.filter((c) => c.id !== value);
    pending = null;
    if (!conversations.length) newConversation();
    broadcast();
  });
  handle('clearHistory', () => {
    idleOnly();
    store.clear('conversations');
    conversations = [];
    newConversation();
    broadcast();
  });
  handle('send', async (id: unknown, text: unknown) => {
    const c = conversation(idSchema.parse(id)),
      input = textSchema.parse(text);
    idleOnly();
    pending = null;
    message(c, 'user', input);
    if (c.title === '新しい会話') c.title = input.slice(0, 30);
    persist(c);
    await task(async (signal) => {
      try {
        const intent = await llm.intent(input, !!c.rootId, signal);
        if (intent.intent === 'chat') {
          const history = [...c.messages];
          const m = message(c, 'assistant', '');
          phase = 'responding';
          broadcast();
          try {
            await llm.chat(
              history,
              signal,
              (chunk) => {
                m.content += chunk;
                emit({ type: 'delta', conversationId: c.id, messageId: m.id, text: chunk });
              },
              () =>
                emit({
                  type: 'progress',
                  text: '文脈上限に合わせて古い会話を省略しました',
                  done: 0,
                  total: 0,
                }),
            );
          } catch (error) {
            m.status = 'error';
            m.content += '\n〔応答を中断しました〕';
            throw error;
          } finally {
            persist(c);
          }
        } else if (
          intent.intent === 'organize' &&
          intent.method === 'by_extension' &&
          intent.target === 'selected' &&
          c.rootId
        ) {
          message(
            c,
            'assistant',
            '選択中のフォルダ直下を確認し、種類別の整理案を作ります。実行前に一覧を確認できます。',
          );
          phase = 'working';
          await organizer.propose(c.rootId, c.id, signal);
        } else {
          const reason =
            intent.intent === 'unsupported'
              ? 'その整理方法は未対応です。拡張子による種類別整理に切り替えられます。'
              : '対象フォルダと、種類別に整理することを確認してください。';
          pending = {
            id: randomUUID(),
            conversationId: c.id,
            reason,
            needsTarget: intent.target !== 'selected' || !c.rootId,
          };
          message(c, 'assistant', reason);
        }
      } catch (error) {
        const failed = message(c, 'assistant', (error as Error).message);
        failed.status = 'error';
        persist(c);
        throw error;
      }
    }, 'thinking');
  });
  handle('cancel', () => {
    controller?.abort();
    organizer.canceled = true;
    pending = null;
    broadcast();
  });
  handle('selectRoot', async (id: unknown) => {
    const c = conversation(idSchema.parse(id));
    await task(async () => {
      const result = await dialog.showOpenDialog(panel, {
        title: '整理対象の通常ローカルフォルダ（同期フォルダは未対応）',
        properties: ['openDirectory'],
      });
      if (result.canceled) return 'idle';
      const root = await organizer.register(result.filePaths[0]);
      c.rootId = root.id;
      if (pending?.conversationId === c.id) pending.needsTarget = false;
      persist(c);
    });
  });
  handle('chooseRoot', (cid: unknown, rid: unknown) => {
    idleOnly();
    const c = conversation(idSchema.parse(cid)),
      root = organizer.root(idSchema.parse(rid));
    c.rootId = root.id;
    if (pending?.conversationId === c.id) pending.needsTarget = false;
    persist(c);
    broadcast();
  });
  handle('revokeRoot', (id: unknown) => {
    const value = idSchema.parse(id);
    controller?.abort();
    pending = null;
    try {
      organizer.revoke(value);
    } finally {
      for (const c of conversations) if (c.rootId === value) c.rootId = undefined;
      broadcast();
    }
    for (const c of conversations) persist(c);
  });
  handle('resolvePending', async (id: unknown) => {
    if (!pending || pending.id !== idSchema.parse(id))
      throw new Error('確認依頼が失効しています。');
    const c = conversation(pending.conversationId);
    if (!c.rootId || pending.needsTarget)
      throw new Error('対象フォルダを明示的に選択してください。');
    pending = null;
    await task(async (signal) => {
      await organizer.propose(c.rootId!, c.id, signal);
    });
  });
  handle('dismissPending', () => {
    pending = null;
    broadcast();
  });
  handle('propose', async (id: unknown) => {
    const c = conversation(idSchema.parse(id));
    if (!c.rootId) throw new Error('対象フォルダを選択してください。');
    pending = null;
    await task(async (signal) => {
      await organizer.propose(c.rootId!, c.id, signal);
    });
  });
  handle('editPlan', (id: unknown, rev: unknown, choices: unknown) => {
    idleOnly();
    organizer.edit(
      idSchema.parse(id),
      z.number().int().parse(rev),
      z.record(z.string().uuid(), z.enum(CATEGORIES)).parse(choices),
    );
  });
  handle('prepare', async (id: unknown) => {
    const value = idSchema.parse(id);
    await task(async (signal) => organizer.prepare(value, signal));
  });
  handle('approve', async (id: unknown, rev: unknown, hash: unknown) => {
    const value = idSchema.parse(id),
      revision = z.number().int().parse(rev),
      digest = z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .parse(hash);
    await task(async () => {
      const result = await organizer.execute(value, revision, digest);
      const c = conversations.find((c) => c.id === result.conversationId);
      const moves = result.operations.filter((o) => o.kind === 'move');
      const uncertain = result.operations.filter((o) =>
        ['intent', 'unresolved'].includes(o.state),
      ).length;
      if (c)
        message(
          c,
          'assistant',
          `作業記録：${result.undoOf ? '復元' : '整理'} ${moves.filter((o) => o.state === 'done').length}件完了、${moves.filter((o) => o.state === 'failed').length}件失敗、${moves.filter((o) => o.state === 'pending').length}件未実行。フォルダ作成を含む${uncertain}操作は照合が必要です。${result.status === 'canceled' ? '停止しました。' : ''}`,
        );
      return result.status === 'completed'
        ? 'success'
        : result.status === 'canceled'
          ? 'canceled'
          : 'attention';
    });
  });
  handle('undo', async (id: unknown) => {
    const value = idSchema.parse(id);
    await task(async (signal) => {
      await organizer.undo(value, signal);
    });
  });
  handle('recover', async () => {
    await task(async (signal) => {
      await organizer.recover(signal);
      return store.list<Plan>('plans').some((p) => p.status === 'recovery')
        ? 'attention'
        : 'success';
    });
  });
  handle('acknowledgeRecovery', async (id: unknown, rev: unknown) => {
    const value = idSchema.parse(id),
      revision = z.number().int().parse(rev);
    await task(async () => {
      const p = organizer.get(value);
      if (p.status !== 'recovery' || p.revision !== revision)
        throw new Error('確認対象が変わりました。');
      const root = store.get<Root>('roots', p.rootId);
      const result = await dialog.showMessageBox(panel, {
        type: 'warning',
        title: '未確定の操作を手動確認',
        message: '実ファイルの状態を確認しましたか？',
        detail: `対象: ${root?.path || p.rootId}\n計画: ${p.id}\n\n${p.operations
          .filter((op) => ['intent', 'unresolved'].includes(op.state))
          .map((op) => `${op.from || 'フォルダ作成'} → ${op.to}`)
          .join(
            '\n',
          )}\n\nこの操作ではファイルを変更しません。成否が未確定の項目を記録に残して照合を終了します。未確定項目はアプリの復元対象から外れます。`,
        buttons: ['キャンセル', '実ファイルを確認済み・照合を終了'],
        defaultId: 0,
        cancelId: 0,
      });
      if (result.response !== 1) return 'idle';
      organizer.acknowledge(value, revision);
      const c = conversations.find((c) => c.id === p.conversationId);
      if (c)
        message(
          c,
          'assistant',
          '作業記録：未確定の操作を手動確認済みとして記録しました。ファイルの変更や再実行は行っていません。',
        );
      return 'attention';
    });
  });
  handle('deleteJob', (id: unknown) => {
    idleOnly();
    const p = organizer.get(idSchema.parse(id));
    if (['executing', 'recovery'].includes(p.status))
      throw new Error('未解決の記録は削除できません。');
    store.delete('plans', p.id);
    store.delete('approvals', p.id);
    broadcast();
  });
  handle('importAvatar', async () => {
    idleOnly();
    if (preview || avatarDialogOpen) throw new Error('モデルの読み込み中です。');
    avatarDialogOpen = true;
    try {
      const result = await dialog.showOpenDialog(panel, {
        title: 'ユーザーが用意したVRMを選択',
        filters: [{ name: 'VRM', extensions: ['vrm'] }],
        properties: ['openFile'],
      });
      if (result.canceled) return;
      const file = result.filePaths[0];
      const stat = await fs.stat(file);
      if (stat.size > 100 * 1024 ** 2) throw new Error('100MiB以下のVRMを選択してください。');
      const bytes = await fs.readFile(file);
      const info = inspectVRM(bytes, (b) => nativeImage.createFromBuffer(b).getSize());
      const confirm = await dialog.showMessageBox(panel, {
        type: 'info',
        title: 'VRMの情報',
        message: info.name,
        detail: `VRM ${info.version === '1' ? '1.0' : '0.x'}\n作者: ${info.authors}\n${info.license}\n\nモデルの利用条件を確認してインポートしてください。`,
        buttons: ['インポート', 'キャンセル'],
        defaultId: 0,
        cancelId: 1,
      });
      if (confirm.response !== 0) return;
      await fs.mkdir(path.join(store.directory, 'avatars'), { recursive: true });
      await fs.writeFile(path.join(store.directory, 'avatars', info.id + '.vrm'), bytes, {
        flag: 'wx',
      });
      await startPreview(info);
    } finally {
      avatarDialogOpen = false;
    }
  });
  handle('selectAvatar', async (id: unknown) => {
    if (avatarDialogOpen) throw new Error('インポート画面を閉じてください。');
    const value = idSchema.parse(id),
      info = store.get<Avatar>('avatars', value);
    if (!info) throw new Error('モデルがありません。');
    if (settings.avatarId === value) {
      previewGeneration++;
      await discardPreview();
      setAvatarVisible(true);
      return;
    }
    await startPreview(info);
  });
  handle('deleteAvatar', async (id: unknown) => {
    const value = idSchema.parse(id);
    previewGeneration++;
    if (settings.avatarId === value) {
      const next = { ...settings, avatarId: null };
      store.put('settings', 'main', next);
      settings = next;
    }
    if (preview?.id === value) await discardPreview();
    store.delete('avatars', value);
    await fs.rm(path.join(store.directory, 'avatars', value + '.vrm'), { force: true });
    broadcast();
  });
  handle('avatarBytes', (id: unknown) => readAvatar(id));
  handle('showAvatar', () => setAvatarVisible(true));
  handle('hideAvatar', () => setAvatarVisible(false));
  handle('openData', () => shell.openPath(store.directory));
  handle('backupData', () => {
    idleOnly();
    return store.backup();
  });
  ipcMain.handle('avatar:state', (event) => {
    verifySender(event, avatarWindow, avatarFile);
    return avatarState();
  });
  ipcMain.handle('avatar:bytes', (event, id) => {
    verifySender(event, avatarWindow, avatarFile);
    return readAvatar(id);
  });
  ipcMain.on('avatar:hit', (event, hit) => {
    verifySender(event, avatarWindow, avatarFile);
    if (interaction === 'auto') ignoreMouse(hit !== true);
  });
  ipcMain.on('avatar:open', (event) => {
    verifySender(event, avatarWindow, avatarFile);
    showPanel();
  });
  ipcMain.on('avatar:menu', (event) => {
    verifySender(event, avatarWindow, avatarFile);
    Menu.buildFromTemplate([
      { label: 'アバターを隠す', click: () => setAvatarVisible(false) },
      { label: '会話を開く', click: showPanel },
    ]).popup({ window: avatarWindow });
  });
  ipcMain.on('avatar:drag', (event, dx, dy) => {
    verifySender(event, avatarWindow, avatarFile);
    if (
      interaction === 'pass' ||
      typeof dx !== 'number' ||
      typeof dy !== 'number' ||
      !Number.isFinite(dx) ||
      !Number.isFinite(dy) ||
      Math.abs(dx) > 200 ||
      Math.abs(dy) > 200
    )
      return;
    const [x, y] = avatarWindow.getPosition();
    avatarWindow.setPosition(Math.round(x + dx), Math.round(y + dy));
  });
  ipcMain.on('avatar:report', (event, id, ok, error) => {
    verifySender(event, avatarWindow, avatarFile);
    if (!preview || preview.id !== id) {
      if (!preview && settings.avatarId === id && ok !== true)
        emit({
          type: 'error',
          message:
            '保存済みモデルを表示できません。アバター画面から別のVRMを選択してください。 ' +
            String(error).slice(0, 300),
        });
      return;
    }
    const candidate = preview;
    clearTimeout(previewTimer);
    previewTimer = undefined;
    if (ok === true) {
      try {
        store.put('avatars', candidate.id, candidate);
        const next = { ...settings, avatarId: candidate.id };
        store.put('settings', 'main', next);
        settings = next;
        preview = null;
        broadcast();
      } catch (error) {
        preview = null;
        emit({ type: 'error', message: 'モデルの保存に失敗しました。 ' + String(error) });
        broadcast();
      }
    } else {
      void discardPreview()
        .then(() => {
          emit({
            type: 'error',
            message:
              'モデルを表示できません。以前のモデルを維持します。 ' + String(error).slice(0, 300),
          });
          broadcast();
        })
        .catch((error) => emit({ type: 'error', message: String(error) }));
    }
  });
}
async function readAvatar(id: unknown) {
  const value = idSchema.parse(id);
  if (!store.get('avatars', value) && preview?.id !== value)
    throw new Error('許可されていないモデルです。');
  return new Uint8Array(await fs.readFile(path.join(store.directory, 'avatars', value + '.vrm')));
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (panel) showPanel();
  });
  app.whenReady().then(async () => {
    try {
      store = new Store(app.getPath('userData'));
      settings = settingsSchema.parse({ ...DEFAULTS, ...store.get<Settings>('settings', 'main') });
      endpoint(settings.endpoint);
      recoveryWarning = store.get<{ warning: string }>('recovery', 'restored')?.warning;
      conversations = store.list<Conversation>('conversations');
      if (!conversations.length) newConversation();
      for (const p of store.list<Plan>('plans')) {
        if (p.status === 'executing') {
          p.status = 'recovery';
          store.put('plans', p.id, p);
        } else if (p.status === 'ready') {
          p.status = 'stale';
          store.put('plans', p.id, p);
        }
      }
      organizer = new Organizer(
        store,
        new NativeFiles(path.join(base, 'native/windows-files/bin/CompanionFiles.exe')),
        (text, done, total) => emit({ type: 'progress', text, done, total }),
        broadcast,
        [base, path.dirname(app.getPath('exe'))],
      );
      session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) =>
        callback(false),
      );
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        let allowed = ['data:', 'blob:', 'devtools:'].some((protocol) =>
          details.url.startsWith(protocol),
        );
        if (details.url.startsWith('file:')) {
          try {
            const file = path.resolve(fileURLToPath(details.url)).toLowerCase(),
              assets = path.resolve(base, 'dist/renderer').toLowerCase();
            allowed = file.startsWith(assets + path.sep);
          } catch {
            allowed = false;
          }
        }
        callback({ cancel: !allowed });
      });
      createWindows();
      registerAPI();
    } catch (error) {
      try {
        store?.close();
      } catch {}
      const directory = app.getPath('userData');
      const result = await dialog.showMessageBox({
        type: 'error',
        title: 'VRM Companionを起動できません',
        message: (error as Error).message,
        detail:
          'データは削除していません。\n保存先: ' +
          directory +
          '\n\nバックアップの復元では、元のDBを別フォルダに保管し、フォルダの許可と承認を失効させます。バックアップ作成以後の会話・作業記録は戻りません。',
        buttons: ['保存先を開く', 'バックアップを選んで復元', '終了'],
        defaultId: 0,
        cancelId: 2,
      });
      if (result.response === 0) await shell.openPath(directory);
      if (result.response === 1) {
        const selected = await dialog.showOpenDialog({
          title: '設定画面で作成したバックアップを選択',
          defaultPath: path.join(directory, 'backups'),
          filters: [{ name: 'SQLite backup', extensions: ['sqlite'] }],
          properties: ['openFile'],
        });
        if (!selected.canceled) {
          try {
            Store.restore(directory, selected.filePaths[0]);
            app.relaunch();
          } catch (error) {
            dialog.showErrorBox('バックアップを復元できません', String(error));
          }
        }
      }
      quitting = true;
      app.quit();
    }
  });
  app.on('before-quit', (event) => {
    if (busy) {
      event.preventDefault();
      controller?.abort();
      organizer.canceled = true;
      quitting = true;
      const wait = setInterval(() => {
        if (!busy) {
          clearInterval(wait);
          app.quit();
        }
      }, 100);
      return;
    }
    quitting = true;
    if (store && avatarWindow && !avatarWindow.isDestroyed()) {
      try {
        const [x, y] = avatarWindow.getPosition();
        settings.avatarX = x;
        settings.avatarY = y;
        store.put('settings', 'main', settings);
      } catch (error) {
        console.error('Window position could not be saved.');
      } finally {
        try {
          store.close();
        } catch {}
      }
    }
  });
}
