import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { z } from 'zod';
import { settingsSchema, mergeSettingsEdit } from '../src/main/settings';
import { notifySafely } from '../src/main/notifications';
import { Repositories } from '../src/main/repositories';
import { DEFAULTS, CATEGORIES, type Avatar, type Phase } from '../src/shared/types';

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const avatar = (name: string): Avatar => ({
  id: randomUUID(),
  name,
  version: '1',
  authors: 'test',
  license: 'test',
  hash: '0'.repeat(64),
  size: 8,
});

function mainHarness() {
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile(
    'index.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  // Run the original declarations and IPC registrations, excluding imports and
  // actual Electron startup. Lifecycle functions/handlers are never reimplemented.
  const declarations = parsed.statements
    .filter(
      (statement) =>
        !ts.isImportDeclaration(statement) &&
        !(
          ts.isIfStatement(statement) &&
          statement.expression.getText(parsed).replace(/\s/g, '') ===
            '!app.requestSingleInstanceLock()'
        ),
    )
    .map((statement) => statement.getText(parsed))
    .join('\n');
  const root = path.resolve('virtual-main-lifecycle'),
    records = new Map<string, unknown>(),
    files = new Map<string, Buffer>();
  const timers = new Map<number, () => void>(),
    handlers = new Map<string, Function>(),
    events = new Map<string, Function>();
  const panelEvents: any[] = [],
    avatarEvents: any[] = [],
    removed: string[] = [],
    blockedRemovals = new Map<string, ReturnType<typeof deferred>>();
  let timerId = 0,
    failNextSend = false,
    shown = 0,
    importCandidate = avatar('Imported');
  const store = {
    directory: path.join(root, 'data'),
    transaction: (fn: () => unknown) => fn(),
    get(bucket: string, id: string) {
      const value = records.get(bucket + ':' + id);
      return value === undefined ? undefined : structuredClone(value);
    },
    put(bucket: string, id: string, value: unknown) {
      records.set(bucket + ':' + id, structuredClone(value));
    },
    delete(bucket: string, id: string) {
      records.delete(bucket + ':' + id);
    },
    list(bucket: string) {
      return [...records]
        .filter(([key]) => key.startsWith(bucket + ':'))
        .map(([, value]) => structuredClone(value));
    },
  };
  const makeWindow = (file: string, output: any[]) => {
    const frame = { url: pathToFileURL(path.join(root, 'dist/renderer', file)).href };
    let visible = true;
    let bounds = { x: 100, y: 200, width: 380, height: 540 },
      ignored = false,
      invalidations = 0;
    return {
      webContents: {
        invalidate() {
          invalidations++;
        },
        isCrashed: () => false,
        mainFrame: frame,
        send(channel: string, value: unknown) {
          if (file === 'index.html' && failNextSend) {
            failNextSend = false;
            throw new Error('initial broadcast failed');
          }
          output.push({ channel, value: structuredClone(value) });
        },
      },
      setAlwaysOnTop() {},
      isDestroyed: () => false,
      isVisible: () => visible,
      isMinimized: () => false,
      getPosition: () => [bounds.x, bounds.y],
      setBounds: (value: typeof bounds) => {
        bounds = value;
      },
      setIgnoreMouseEvents: (value: boolean) => {
        ignored = value;
      },
      dragInfo: () => ({ bounds, ignored, invalidations }),
      showInactive() {
        visible = true;
        shown++;
      },
      hide() {
        visible = false;
      },
    };
  };
  const panel = makeWindow('index.html', panelEvents),
    avatarWindow = makeWindow('avatar.html', avatarEvents);
  const ipcMain = {
    handle: (name: string, callback: Function) => handlers.set(name, callback),
    on: (name: string, callback: Function) => events.set(name, callback),
  };
  const fs = {
    stat: async () => ({ size: 8 }),
    readFile: async () => Buffer.from('fixture'),
    mkdir: async () => {},
    writeFile: async (file: string, bytes: Buffer) => {
      files.set(file, bytes);
    },
    rm: async (file: string) => {
      removed.push(file);
      await blockedRemovals.get(file)?.promise;
      files.delete(file);
    },
  };
  const context = vm.createContext({
    path,
    fs,
    z,
    settingsSchema,
    mergeSettingsEdit,
    notifySafely,
    Repositories,
    runMaintenance: async () => importCandidate,
    DEFAULTS,
    CATEGORIES,
    AbortController,
    Error,
    URL,
    fileURLToPath,
    randomUUID,
    Buffer,
    console,
    app: {
      getAppPath: () => root,
      isPackaged: true,
      commandLine: { getSwitchValue: () => '' },
      setLoginItemSettings() {},
    },
    ipcMain,
    Llama: class {},
    endpoint() {},
    inspectVRM: () => importCandidate,
    nativeImage: { createFromBuffer: () => ({ getSize: () => ({ width: 1, height: 1 }) }) },
    dialog: {
      showOpenDialog: async () => ({
        canceled: false,
        filePaths: [path.join(root, 'provided.vrm')],
      }),
      showMessageBox: async () => ({ response: 0 }),
    },
    setTimeout: (callback: () => void) => {
      const id = ++timerId;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  const expose = `globalThis.testMain={
    init(values){settings={...DEFAULTS};store=values.store;panel=values.panel;avatarWindow=values.avatarWindow;organizer={isRevoked:()=>false,journalFault:null};registerAPI();},
    setRuntime:value=>{runtime=value;},task,abort:()=>controller?.abort(),startPreview,
    setSelected:id=>{settings={...settings,avatarId:id};store.put('settings','main',settings);},
    current:()=>({busy,controllerPresent:controller!==null,phase,previewId:preview?.id??null,selectedId:settings.avatarId,effectiveId:effectiveSettings().avatarId,avatarDialogOpen})
  };`;
  vm.runInContext(
    ts.transpileModule(declarations + '\n' + expose, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText,
    context,
  );
  context.testMain.init({ store, panel, avatarWindow });
  const panelEvent = { sender: panel.webContents, senderFrame: panel.webContents.mainFrame },
    avatarEvent = {
      sender: avatarWindow.webContents,
      senderFrame: avatarWindow.webContents.mainFrame,
    };
  return {
    setOrganizer: (value: unknown) => {
      (context as any).injected = value;
      vm.runInContext('organizer=injected', context);
    },
    setMaintenance: (fn: () => Promise<unknown>) => {
      context.runMaintenance = fn;
    },
    store,
    files,
    timers,
    removed,
    panelEvents,
    avatarEvents,
    blockedRemovals,
    setRuntime: (value: any) => context.testMain.setRuntime(value),
    current: () => context.testMain.current(),
    task: (fn: (signal: AbortSignal) => Promise<void | Phase>) =>
      context.testMain.task(fn) as Promise<void>,
    abort: () => context.testMain.abort(),
    invoke: async (name: string, ...args: unknown[]) => {
      const reply = await handlers.get('companion:' + name)!(panelEvent, ...args);
      if (!reply.ok) throw new Error(reply.error);
      return reply.value;
    },
    report: (id: string, ok: boolean, error?: string) =>
      events.get('avatar:report')!(avatarEvent, id, ok, error),
    avatarEvent: (name: string, ...args: unknown[]) =>
      events.get('avatar:' + name)!(avatarEvent, ...args),
    dragInfo: () => structuredClone(avatarWindow.dragInfo()),
    setSelected: (candidate: Avatar) => {
      store.put('avatars', candidate.id, candidate);
      context.testMain.setSelected(candidate.id);
    },
    importNext: (candidate: Avatar) => {
      importCandidate = candidate;
    },
    failBroadcast: () => {
      failNextSend = true;
    },
    shown: () => shown,
    copyPath: (candidate: Avatar) => path.join(store.directory, 'avatars', candidate.id + '.vrm'),
  };
}

test('drag holds hit testing, coalesces movement, keeps dimensions and releases on hide', async () => {
  const h = mainHarness();
  h.avatarEvent('dragging', true);
  h.avatarEvent('hit', false);
  assert.equal(h.dragInfo().ignored, false, 'transparent pixels must not release a held drag');
  h.avatarEvent('drag', 4, 5);
  h.avatarEvent('drag', 6, -3);
  h.avatarEvent('drag', Infinity, 0);
  h.avatarEvent('drag', 10000, 0);
  assert.equal(h.dragInfo().bounds.x, 100, 'movement waits for the single scheduled flush');
  assert.equal(h.timers.size, 1);
  await h.invoke('hideAvatar');
  assert.deepEqual(h.dragInfo().bounds, { x: 110, y: 202, width: 380, height: 540 });
  assert.equal(h.dragInfo().invalidations, 1);
  assert.equal(h.dragInfo().ignored, true);
  assert.equal(h.timers.size, 0);
  h.avatarEvent('drag', 5, 5);
  assert.equal(h.timers.size, 0, 'a stale drag cannot move a hidden avatar');
  h.avatarEvent('hit', true);
  assert.equal(h.dragInfo().ignored, false, 'normal hover works again after drag');
});

test('display notification failure cannot fail a task or retain its lock', async () => {
  const h = mainHarness();
  let called = false;
  h.failBroadcast();
  await h.task(async () => {
    called = true;
  });
  assert.equal(called, true);
  assert.equal(h.current().busy, false);
  assert.equal(h.current().controllerPresent, false);
  assert.equal(h.current().phase, 'success');
});
test('avatar visibility stays controllable during a task and preserves model selection', async () => {
  const h = mainHarness(),
    model = avatar('Visible'),
    pending = deferred();
  h.setSelected(model);
  const running = h.task(async () => {
    await pending.promise;
  });
  try {
    assert.equal(h.current().busy, true);
    await h.invoke('hideAvatar');
    assert.equal((await h.invoke('state')).avatarVisible, false);
    assert.equal((h.store.get('settings', 'main') as typeof DEFAULTS).avatarVisible, false);
    assert.equal(h.current().selectedId, model.id);
    assert.equal(h.current().busy, true);
    await h.invoke('showAvatar');
    assert.equal((await h.invoke('state')).avatarVisible, true);
    assert.equal((h.store.get('settings', 'main') as typeof DEFAULTS).avatarVisible, true);
  } finally {
    pending.resolve();
    await running;
  }
});
for (const phase of ['canceled', 'attention'] as const)
  test(`task preserves an explicit ${phase} result`, async () => {
    const h = mainHarness();
    await h.task(async () => phase);
    assert.equal(h.current().phase, phase);
    assert.equal(h.current().busy, false);
    assert.equal(h.current().controllerPresent, false);
    assert.equal(h.panelEvents.at(-1).value.state.phase, phase);
  });
test('a canceled task returning no explicit outcome does not become success', async () => {
  const h = mainHarness(),
    pending = deferred();
  const running = h.task(async (signal) => {
    await pending.promise;
    assert.equal(signal.aborted, true);
  });
  h.abort();
  pending.resolve();
  await running;
  assert.equal(h.current().phase, 'canceled');
  assert.equal(h.current().controllerPresent, false);
});
test('reselecting the displayed model leaves import available and commits a replacement only after its report', async () => {
  const h = mainHarness(),
    current = avatar('Current'),
    replacement = avatar('Replacement');
  h.setSelected(current);
  await h.invoke('selectAvatar', current.id);
  assert.equal(h.current().previewId, null);
  assert.equal(h.timers.size, 0);
  h.importNext(replacement);
  await h.invoke('importAvatar');
  assert.equal(h.current().previewId, replacement.id);
  assert.equal(h.current().selectedId, current.id);
  assert.equal(h.store.get('avatars', replacement.id), undefined);
  assert.ok(h.files.has(h.copyPath(replacement)));
  h.report(replacement.id, true);
  assert.equal(h.current().selectedId, replacement.id);
  assert.equal(h.current().previewId, null);
  assert.equal(h.timers.size, 0);
  assert.ok(h.store.get('avatars', replacement.id));
});
test('returning to the displayed model discards an import and ignores its late success report', async () => {
  const h = mainHarness(),
    current = avatar('Current'),
    replacement = avatar('Discarded');
  h.setSelected(current);
  h.importNext(replacement);
  await h.invoke('importAvatar');
  await h.invoke('selectAvatar', current.id);
  h.report(replacement.id, true);
  assert.equal(h.current().selectedId, current.id);
  assert.equal(h.current().previewId, null);
  assert.equal(h.store.get('avatars', replacement.id), undefined);
  assert.equal(h.files.has(h.copyPath(replacement)), false);
  assert.equal(h.timers.size, 0);
});
test('deleting a candidate while preview preparation awaits cleanup cannot resurrect that model', async () => {
  const h = mainHarness(),
    current = avatar('Current'),
    oldImport = avatar('Old import'),
    candidate = avatar('Deleted candidate');
  h.setSelected(current);
  h.store.put('avatars', candidate.id, candidate);
  h.importNext(oldImport);
  await h.invoke('importAvatar');
  const cleanup = deferred();
  h.blockedRemovals.set(h.copyPath(oldImport), cleanup);
  const preparing = h.invoke('selectAvatar', candidate.id);
  await nextTurn();
  assert.ok(h.removed.includes(h.copyPath(oldImport)));
  assert.equal(h.current().previewId, null);
  await h.invoke('deleteAvatar', candidate.id);
  cleanup.resolve();
  await preparing;
  h.report(candidate.id, true);
  assert.equal(h.current().selectedId, current.id);
  assert.equal(h.current().effectiveId, current.id);
  assert.equal(h.current().previewId, null);
  assert.equal(h.store.get('avatars', candidate.id), undefined);
  assert.equal(h.timers.size, 0);
  assert.equal(
    h.avatarEvents.some((event) => event.value.settings.avatarId === candidate.id),
    false,
  );
});

test('settings commit preserves visibility and model changes made during an awaited stop', async () => {
  const h = mainHarness(),
    first = avatar('first'),
    second = avatar('second'),
    gate = deferred();
  h.setSelected(first);
  h.setRuntime({ stop: () => gate.promise, cancelIdle() {}, scheduleIdle() {} });
  const next = { ...(await h.invoke('state')).settings, context: 8192 };
  const saving = h.invoke('settings', next);
  await nextTurn();
  await h.invoke('hideAvatar');
  h.setSelected(second);
  gate.resolve();
  await saving;
  const state = await h.invoke('state');
  assert.equal(state.settings.avatarVisible, false);
  assert.equal(state.avatarVisible, false);
  assert.equal(state.settings.avatarId, second.id);
  assert.equal(state.settings.context, 8192);
  assert.equal((h.store.get('settings', 'main') as typeof DEFAULTS).avatarId, second.id);
});
test('canceling a settings save while the model stops does not commit the edit', async () => {
  const h = mainHarness(),
    gate = deferred();
  h.setRuntime({ stop: () => gate.promise, cancelIdle() {}, scheduleIdle() {} });
  const saving = h.invoke('settings', { ...(await h.invoke('state')).settings, context: 8192 });
  await nextTurn();
  h.abort();
  gate.resolve();
  await assert.rejects(saving);
  assert.equal((await h.invoke('state')).settings.context, DEFAULTS.context);
});
test('status events never include the conversation or plan collections', async () => {
  const h = mainHarness();
  await h.task(async () => {});
  for (const { value } of h.panelEvents) {
    assert.equal(value.type, 'update');
    assert.equal('plans' in value.state, false);
    assert.equal('conversations' in value.state, false);
  }
});

test('failed conversation writes change neither in-memory history nor title', async () => {
  const h = mainHarness(),
    id = await h.invoke('newConversation');
  h.store.put = () => {
    throw new Error('injected disk failure');
  };
  await assert.rejects(h.invoke('send', id, 'unsaved', 'chat'), /disk failure/);
  const c = (await h.invoke('state')).conversations[0];
  assert.equal(c.messages.length, 0);
  assert.equal(c.title, '新しい会話');
  await assert.rejects(h.invoke('newConversation'), /disk failure/);
  assert.equal((await h.invoke('state')).conversations.length, 1);
});

test('failed avatar registration cleans its app-owned copy and retains the selected model', async () => {
  const h = mainHarness(),
    old = avatar('old'),
    candidate = avatar('failed');
  h.setSelected(old);
  h.importNext(candidate);
  await h.invoke('importAvatar');
  const put = h.store.put.bind(h.store);
  h.store.put = (bucket, id, value) => {
    if (bucket === 'avatars') throw new Error('disk');
    put(bucket, id, value);
  };
  h.report(candidate.id, true);
  await nextTurn();
  assert.equal(h.current().selectedId, old.id);
  assert.equal(h.files.has(h.copyPath(candidate)), false);
  assert.equal(h.store.get('avatars', candidate.id), undefined);
});

test('canceling root selection while registration waits does not attach the root', async () => {
  const h = mainHarness(),
    gate = deferred(),
    id = await h.invoke('newConversation');
  h.setOrganizer({
    isRevoked: () => false,
    register: async (_path: string, signal: AbortSignal) => {
      await gate.promise;
      assert.equal(signal.aborted, true);
      return { id: randomUUID() };
    },
  });
  const pending = h.invoke('selectRoot', id);
  await nextTurn();
  await h.invoke('cancel');
  gate.resolve();
  await assert.rejects(pending);
  assert.equal((await h.invoke('state')).conversations[0].rootId, undefined);
  assert.equal(h.current().phase, 'canceled');
});

for (const action of ['deleteConversation', 'clearHistory'])
  test(`canceling ${action} during backup cleanup preserves live history`, async () => {
    const h = mainHarness(),
      gate = deferred(),
      id = await h.invoke('newConversation');
    h.setMaintenance(() => gate.promise);
    const pending = h.invoke(action, id);
    await nextTurn();
    await h.invoke('cancel');
    gate.resolve();
    await assert.rejects(pending);
    assert.equal((await h.invoke('state')).conversations[0].id, id);
    assert.ok(h.store.get('conversations', id));
    assert.equal(h.current().phase, 'canceled');
  });
