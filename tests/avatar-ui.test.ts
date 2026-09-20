import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { DEFAULTS, CATEGORIES, type State } from '../src/shared/types';
import { AvatarMotion } from '../src/renderer/motion';

// Exercise the actual renderer sources without opening another Electron instance
// or touching application data. GPU, IPC and DOM edges are controlled test doubles.
function evaluateRenderer(file: string, globals: Record<string, unknown>, expose: string) {
  const parsed = ts.createSourceFile(
    file,
    readFileSync(new URL('../src/renderer/' + file, import.meta.url), 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const source = parsed.statements
    .filter((statement) => !ts.isImportDeclaration(statement))
    .map((statement) => statement.getText(parsed))
    .join('\n');
  const context = vm.createContext({ ...globals, console, queueMicrotask });
  vm.runInContext(
    ts.transpileModule(source + '\n' + expose, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
    }).outputText,
    context,
  );
  return context;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((ok, no) => {
    resolve = ok;
    reject = no;
  });
  return { promise, resolve, reject };
}
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));
function avatarHarness() {
  const reports: { id: string; ok: boolean }[] = [],
    disposed: string[] = [],
    requests: string[] = [],
    parses: string[] = [];
  const delayed = new Map<string, ReturnType<typeof deferred<any>>>();
  let draws = 0,
    updates = 0,
    panelOpens = 0,
    menuOpens = 0;
  const drags: [number, number][] = [],
    captured = new Set<number>(),
    canvasEvents = new Map<string, (event: any) => void>();
  const canvas = {
    addEventListener: (name: string, fn: (event: any) => void) => canvasEvents.set(name, fn),
    setPointerCapture: (id: number) => captured.add(id),
    hasPointerCapture: (id: number) => captured.has(id),
    releasePointerCapture: (id: number) => captured.delete(id),
  };
  class Vector {
    constructor(
      public x = 0,
      public y = 0,
      public z = 0,
    ) {}
    set(x: number, y: number, z: number) {
      this.x = x;
      this.y = y;
      this.z = z;
    }
    multiplyScalar(value: number) {
      this.x *= value;
      this.y *= value;
      this.z *= value;
    }
  }
  type Bounds = {
    min: { x: number; y: number; z: number };
    max: { x: number; y: number; z: number };
  };
  const candidate = (id: string, height = 2, bounds?: Bounds) => ({
    scene: {
      id,
      height,
      bounds,
      traverse() {},
      updateMatrixWorld() {},
      scale: new Vector(1, 1, 1),
      position: new Vector(),
    },
    humanoid: {
      getNormalizedBoneNode() {
        return null;
      },
    },
    update(dt: number) {
      if (dt > 0) updates++;
    },
  });
  const THREE = {
    WebGLRenderer: class {
      setClearColor() {}
      setPixelRatio() {}
      setSize() {}
      render() {
        draws++;
      }
    },
    Scene: class {
      add() {}
      remove() {}
    },
    HemisphereLight: class {},
    DirectionalLight: class {
      position = new Vector();
    },
    PerspectiveCamera: class {
      position = new Vector();
      far = 100;
      constructor(
        public fov: number,
        public aspect: number,
      ) {}
      lookAt() {}
      updateProjectionMatrix() {}
    },
    Raycaster: class {
      setFromCamera() {}
      intersectObject() {
        return [{}];
      }
    },
    Vector2: class {
      set() {}
    },
    Box3: class {
      max = { x: 0, y: 0, z: 0 };
      min = { x: 0, y: 0, z: 0 };
      setFromObject(scene: any) {
        this.min = scene.bounds?.min ?? { x: -0.5, y: 0, z: -0.2 };
        this.max = scene.bounds?.max ?? { x: 0.5, y: scene.height, z: 0.2 };
        return this;
      }
    },
  };
  class GLTFLoader {
    manager = { setURLModifier() {} };
    register() {}
    parseAsync(buffer: ArrayBuffer) {
      const id = String.fromCharCode(new Uint8Array(buffer)[0]);
      parses.push(id);
      return delayed.get(id)?.promise ?? Promise.resolve({ userData: { vrm: candidate(id) } });
    }
  }
  const api = {
    state: () => new Promise(() => {}),
    onUpdate() {},
    bytes: async (id: string) => {
      requests.push(id);
      return new Uint8Array([id.charCodeAt(0)]);
    },
    report: (id: string, ok: boolean) => reports.push({ id, ok }),
    hit() {},
    dragging() {},
    onGesture() {},
    drag: (x: number, y: number) => drags.push([x, y]),
    openPanel: () => panelOpens++,
    openMenu: () => menuOpens++,
  };
  const windowEvents = new Map<string, () => void>();
  const context = evaluateRenderer(
    'avatar.ts',
    {
      THREE,
      AvatarMotion,
      GLTFLoader,
      VRMLoaderPlugin: class {},
      VRMUtils: {
        rotateVRM0() {},
        deepDispose(scene: any) {
          disposed.push(scene.id);
        },
      },
      window: {
        avatarHost: api,
        addEventListener: (name: string, fn: () => void) => windowEvents.set(name, fn),
      },
      document: { hidden: false, querySelector: () => canvas, addEventListener() {} },
      devicePixelRatio: 1,
      innerWidth: 380,
      innerHeight: 540,
      requestAnimationFrame() {},
      cancelAnimationFrame() {},
    },
    'globalThis.testAPI={update,frame,current:()=>({loadedId,loadingId}),camera:()=>camera};',
  );
  const update = (id: string | null, visible = true) =>
    context.testAPI.update({
      settings: { ...DEFAULTS, avatarId: id },
      phase: 'idle',
      visible,
    }) as Promise<void>;
  return {
    update,
    frame: (time: number) => context.testAPI.frame(time),
    current: () => context.testAPI.current(),
    camera: () => context.testAPI.camera(),
    resize: (width: number, height: number) => {
      context.innerWidth = width;
      context.innerHeight = height;
      windowEvents.get('resize')!();
    },
    candidate,
    delayed,
    reports,
    disposed,
    requests,
    parses,
    counts: () => ({ draws, updates }),
    interaction: () => ({ panelOpens, menuOpens, drags, captured: [...captured] }),
    pointer: (name: string, values: Record<string, unknown> = {}) => {
      let prevented = false;
      canvasEvents.get(name)!({
        button: 0,
        pointerId: 1,
        clientX: 100,
        clientY: 100,
        screenX: 100,
        screenY: 100,
        preventDefault: () => {
          prevented = true;
        },
        ...values,
      });
      return { prevented };
    },
  };
}

test('returning to the current avatar invalidates a pending replacement and reports success', async () => {
  const h = avatarHarness();
  await h.update('A');
  const pending = deferred<any>();
  h.delayed.set('B', pending);
  const loading = h.update('B');
  await nextTurn();
  assert.deepEqual(h.parses, ['A', 'B']);
  await h.update('A');
  pending.resolve({ userData: { vrm: h.candidate('B') } });
  await loading;
  assert.equal(h.current().loadedId, 'A');
  assert.deepEqual(h.disposed, ['B']);
  assert.equal(h.reports.at(-1)?.id, 'A');
  assert.equal(
    h.reports.some((r) => r.id === 'B'),
    false,
  );
});
test('clearing the avatar while the first model loads cannot resurrect it', async () => {
  const h = avatarHarness(),
    pending = deferred<any>();
  h.delayed.set('A', pending);
  const loading = h.update('A');
  await nextTurn();
  assert.deepEqual(h.parses, ['A']);
  await h.update(null);
  pending.resolve({ userData: { vrm: h.candidate('A') } });
  await loading;
  assert.equal(h.current().loadedId, null);
  assert.deepEqual(h.disposed, ['A']);
  assert.deepEqual(h.reports, []);
});
test('a stale load failure cannot clear or restart a newer pending model', async () => {
  const h = avatarHarness(),
    old = deferred<any>(),
    next = deferred<any>();
  h.delayed.set('A', old);
  h.delayed.set('B', next);
  const first = h.update('A');
  await nextTurn();
  const second = h.update('B');
  await nextTurn();
  old.reject(new Error('old failure'));
  await first;
  await h.update('B');
  assert.equal(h.current().loadingId, 'B');
  assert.deepEqual(h.requests, ['A', 'B']);
  assert.deepEqual(h.reports, []);
  next.resolve({ userData: { vrm: h.candidate('B') } });
  await second;
  assert.equal(h.current().loadedId, 'B');
});
test('invalid loaded geometry is disposed and keeps the previous model', async () => {
  const h = avatarHarness();
  await h.update('A');
  const invalid = deferred<any>();
  h.delayed.set('B', invalid);
  const loading = h.update('B');
  invalid.resolve({ userData: { vrm: h.candidate('B', 0) } });
  await loading;
  assert.equal(h.current().loadedId, 'A');
  assert.deepEqual(h.disposed, ['B']);
  assert.deepEqual(h.reports.at(-1), { id: 'B', ok: false });
});
test('explicit window visibility stops rendering even while document.hidden is false', async () => {
  const h = avatarHarness();
  await h.update('A');
  h.frame(100);
  assert.deepEqual(h.counts(), { draws: 1, updates: 1 });
  await h.update('A', false);
  h.frame(1000);
  h.frame(2000);
  assert.deepEqual(h.counts(), { draws: 1, updates: 1 });
  await h.update('A', true);
  h.frame(2100);
  assert.deepEqual(h.counts(), { draws: 2, updates: 2 });
});
test('right click opens the avatar menu without dragging or opening the panel', async () => {
  const h = avatarHarness();
  await h.update('A');
  h.pointer('pointerdown', { button: 2 });
  h.pointer('pointermove', { button: 2, screenX: 160 });
  h.pointer('pointerup', { button: 2 });
  assert.equal(h.pointer('contextmenu', { button: 2 }).prevented, true);
  assert.deepEqual(h.interaction(), { panelOpens: 0, menuOpens: 1, drags: [], captured: [] });
  h.pointer('pointerdown');
  h.pointer('pointerup');
  assert.equal(h.interaction().panelOpens, 1);
});
test('hiding the avatar releases pointer capture and cannot resume a stale drag', async () => {
  const h = avatarHarness();
  await h.update('A');
  h.pointer('pointerdown', { pointerId: 7 });
  h.pointer('pointermove', { pointerId: 7, screenX: 110 });
  assert.deepEqual(h.interaction().captured, [7]);
  assert.deepEqual(h.interaction().drags, [[10, 0]]);
  await h.update('A', false);
  assert.deepEqual(h.interaction().captured, []);
  await h.update('A', true);
  h.pointer('pointermove', { pointerId: 7, screenX: 150 });
  h.pointer('pointerup', { pointerId: 7 });
  assert.deepEqual(h.interaction().drags, [[10, 0]]);
  assert.equal(h.interaction().panelOpens, 0);
});
test('translated wide/deep model is centered and all bounds fit within camera margins', async () => {
  const h = avatarHarness(),
    bounds = { min: { x: 10, y: 20, z: -7 }, max: { x: 26, y: 22, z: -3 } },
    model = h.candidate('B', 2, bounds),
    loaded = deferred<any>();
  h.delayed.set('B', loaded);
  loaded.resolve({ userData: { vrm: model } });
  await h.update('B');
  assert.equal(h.current().loadedId, 'B');
  const normalized = (axis: 'x' | 'y' | 'z', value: number) =>
    value * model.scene.scale[axis] + model.scene.position[axis];
  assert.ok(Math.abs(normalized('x', 10) + normalized('x', 26)) < 1e-12);
  assert.ok(Math.abs(normalized('z', -7) + normalized('z', -3)) < 1e-12);
  assert.ok(Math.abs(normalized('y', 20)) < 1e-12);
  assert.ok(Math.abs(normalized('y', 22) - 1.65) < 1e-12);
  for (const [width, height] of [
    [380, 540],
    [200, 600],
    [800, 400],
  ]) {
    h.resize(width, height);
    const camera = h.camera(),
      tan = Math.tan((camera.fov * Math.PI) / 360);
    assert.equal(camera.position.y, 0.825);
    for (const x of [10, 26])
      for (const y of [20, 22])
        for (const z of [-7, -3]) {
          const distance = camera.position.z - normalized('z', z);
          assert.ok(distance > 0 && distance < camera.far);
          assert.ok(Math.abs(normalized('x', x) / (distance * tan * camera.aspect)) < 0.9);
          assert.ok(Math.abs((normalized('y', y) - camera.position.y) / (distance * tan)) < 0.9);
        }
  }
});
test('non-finite bounds reject the candidate without losing the displayed model', async () => {
  const h = avatarHarness();
  await h.update('A');
  const loaded = deferred<any>();
  h.delayed.set('B', loaded);
  loaded.resolve({
    userData: {
      vrm: h.candidate('B', 2, { min: { x: -1, y: 0, z: 0 }, max: { x: Infinity, y: 2, z: 1 } }),
    },
  });
  await h.update('B');
  assert.equal(h.current().loadedId, 'A');
  assert.deepEqual(h.disposed, ['B']);
  assert.deepEqual(h.reports.at(-1), { id: 'B', ok: false });
});

function panelHarness(initial: Partial<State> = {}) {
  let document: any;
  const handlers = new Map<string, (event: any) => void>(),
    deleted: string[] = [],
    sent: unknown[] = [],
    visibilityCalls: string[] = [];
  class Element {
    id = '';
    name = '';
    type = '';
    value = '';
    checked = false;
    hidden = false;
    textContent = '';
    dataset: Record<string, string> = {};
    selectionStart: number | null = 0;
    selectionEnd: number | null = 0;
    scrollTop = 0;
    scrollHeight = 100;
    clientHeight = 100;
    listeners = new Map<string, (event: any) => void>();
    addEventListener(event: string, fn: (event: any) => void) {
      this.listeners.set(event, fn);
    }
    getAttribute(name: string) {
      return name === 'name' ? this.name : null;
    }
    focus() {
      document.activeElement = this;
    }
    setSelectionRange(start: number, end: number) {
      this.selectionStart = start;
      this.selectionEnd = end;
    }
    querySelectorAll() {
      return [] as Element[];
    }
  }
  class Input extends Element {}
  class Textarea extends Element {}
  const decode = (value: string) =>
    value
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  let elements: Element[] = [],
    html = '';
  const scroll = new Element(),
    toast = new Element(),
    form = new Element();
  form.querySelectorAll = () => elements;
  const app = new Element() as Element & {
    innerHTML: string;
    contains(el: unknown): boolean;
    querySelector(selector: string): Element | undefined;
  };
  app.contains = (el) => elements.includes(el as Element);
  app.querySelector = (selector) => elements.find((el) => selector === `[name="${el.name}"]`);
  Object.defineProperty(app, 'innerHTML', {
    get: () => html,
    set: (value: string) => {
      html = value;
      elements = [];
      for (const match of value.matchAll(
        /<input\b([^>]*)>|<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/g,
      )) {
        const el = match[1] !== undefined ? new Input() : new Textarea();
        const attrs = match[1] ?? match[2];
        for (const name of ['id', 'name', 'type', 'value'] as const) {
          const attr = attrs.match(new RegExp('(?:^|\\s)' + name + '="([^"]*)"'));
          if (attr) el[name] = decode(attr[1]);
        }
        if (el instanceof Textarea) el.value = decode(match[3] || '');
        el.checked = /\bchecked\b/.test(attrs);
        elements.push(el);
      }
    },
  });
  document = {
    activeElement: null,
    getElementById: (id: string) => elements.find((el) => el.id === id),
    querySelector: (selector: string) =>
      selector === '#app'
        ? app
        : selector === '#toast'
          ? toast
          : selector === '.chat-scroll'
            ? scroll
            : selector === '#settings-form'
              ? html.includes('id="settings-form"')
                ? form
                : null
              : elements.find((el) => selector === '#' + el.id),
  };
  const state: State = {
    llm: { models: [], status: 'unloaded', loadedModel: '' },
    settings: { ...DEFAULTS },
    conversations: [{ id: 'conversation', title: 'New', messages: [] }],
    roots: [],
    plans: [],
    avatars: [],
    pending: null,
    phase: 'idle',
    busy: false,
    avatarVisible: false,
    dataPath: 'test-data',
    hasApiKey: false,
    ...initial,
  };
  const api = {
    state: () => new Promise(() => {}),
    onEvent: (fn: (event: any) => void) => handlers.set('event', fn),
    deleteConversation: async (id: string) => deleted.push(id),
    send: async (...args: unknown[]) => sent.push(args),
    showAvatar: async () => visibilityCalls.push('show'),
    hideAvatar: async () => visibilityCalls.push('hide'),
  };
  const context = evaluateRenderer(
    'panel.ts',
    {
      window: { companion: api },
      document,
      HTMLElement: Element,
      HTMLInputElement: Input,
      HTMLTextAreaElement: Textarea,
      CATEGORIES,
      StateSync: class {
        constructor(
          read: unknown,
          snapshot: unknown,
          private apply: (event: any) => void,
        ) {}
        receive(event: any) {
          this.apply(event);
        }
        refresh() {
          return Promise.resolve();
        }
      },
      setTimeout: () => 0,
      clearTimeout() {},
      confirm: () => true,
    },
    'globalThis.testAPI={setState:s=>{state=s;render();},run,readDraft:()=>draft};',
  );
  context.testAPI.setState(state);
  return {
    state,
    html: () => html,
    document,
    form,
    app,
    deleted,
    sent,
    visibilityCalls,
    element: (id: string) => document.getElementById(id) as Element,
    run: (action: string, extra: Record<string, string> = {}) =>
      context.testAPI.run({ dataset: { action, ...extra } }),
    event: (event: any) => handlers.get('event')!(event),
    draft: () => context.testAPI.readDraft(),
  };
}

test('suggestion buttons populate the composer without sending', () => {
  const h = panelHarness();
  h.run('suggest', { text: 'こんにちは' });
  assert.equal(h.draft(), 'こんにちは');
  assert.equal(h.element('message-input').value, 'こんにちは');
  assert.deepEqual(h.sent, []);
});

test('chat is the default and organization is an explicit choice preserved across updates', async () => {
  const h = panelHarness();
  h.run('suggest', { text: 'このフォルダを整理して' });
  h.run('send');
  await Promise.resolve();
  assert.deepEqual(h.sent[0], ['conversation', 'このフォルダを整理して', 'chat']);
  h.run('sendMode', { mode: 'organize' });
  h.event({ type: 'update', state: { ...h.state, phase: 'success' } });
  h.run('suggest', { text: 'このフォルダを種類別に整理して' });
  h.run('send');
  await Promise.resolve();
  assert.deepEqual(h.sent[1], ['conversation', 'このフォルダを種類別に整理して', 'organize']);
});
test('retry restores the user input preceding the failed response and requires an explicit send', () => {
  const h = panelHarness({
    conversations: [
      {
        id: 'conversation',
        title: 'Retry',
        messages: [
          { id: 'u', role: 'user', content: '前の質問', createdAt: 1 },
          { id: 'a', role: 'assistant', content: '中断', status: 'error', createdAt: 2 },
        ],
      },
    ],
  });
  assert.match(h.html(), /前の入力を再入力/);
  h.run('retryInput', { id: 'a' });
  assert.equal(h.element('message-input').value, '前の質問');
  assert.deepEqual(h.sent, []);
});
test('individual conversation deletion invokes only the selected conversation API', async () => {
  const h = panelHarness();
  assert.match(h.html(), /この会話を削除/);
  h.run('deleteConversation', { id: 'conversation' });
  await Promise.resolve();
  assert.deepEqual(h.deleted, ['conversation']);
});
test('all tabs offer hide/show while busy and follow actual avatar visibility', async () => {
  const h = panelHarness({
    busy: true,
    avatarVisible: true,
    settings: { ...DEFAULTS, avatarId: 'A' },
  });
  for (const tab of ['chat', 'organize', 'avatars', 'settings']) {
    h.run('tab', { tab });
    const header = h.html().match(/<header class="topbar">[\s\S]*?<\/header>/)![0];
    const toggle = header.match(
      /<button[^>]*data-action="toggleAvatar"[^>]*>[\s\S]*?<\/button>/,
    )![0];
    assert.match(toggle, /アバターを隠す/);
    assert.doesNotMatch(toggle, /disabled/);
  }
  h.run('toggleAvatar');
  await Promise.resolve();
  assert.deepEqual(h.visibilityCalls, ['hide']);
  h.event({ type: 'state', state: { ...h.state, avatarVisible: false } });
  assert.match(h.html(), /data-action="toggleAvatar"[^>]*>アバターを表示/);
  h.run('toggleAvatar');
  await Promise.resolve();
  assert.deepEqual(h.visibilityCalls, ['hide', 'show']);
});
test('first preview can be hidden before a model is committed, but empty show is disabled', async () => {
  const h = panelHarness({ busy: true, avatarVisible: true });
  let toggle = h.html().match(/<button[^>]*data-action="toggleAvatar"[^>]*>[\s\S]*?<\/button>/)![0];
  assert.doesNotMatch(toggle, /disabled/);
  h.run('toggleAvatar');
  await Promise.resolve();
  assert.deepEqual(h.visibilityCalls, ['hide']);
  h.event({ type: 'state', state: { ...h.state, avatarVisible: false } });
  toggle = h.html().match(/<button[^>]*data-action="toggleAvatar"[^>]*>[\s\S]*?<\/button>/)![0];
  assert.match(toggle, /disabled/);
  h.run('toggleAvatar');
  await Promise.resolve();
  assert.deepEqual(h.visibilityCalls, ['hide']);
});
test('state updates preserve settings edits, checkbox values, focus and selection', () => {
  const h = panelHarness();
  h.run('tab', { tab: 'settings' });
  const persona = h.element('persona');
  persona.value = '編集中の名前';
  persona.focus();
  persona.setSelectionRange(2, 4);
  const history = h.form.querySelectorAll().find((el) => el.name === 'saveHistory')!;
  history.checked = false;
  h.form.listeners.get('input')!({});
  h.event({ type: 'state', state: { ...h.state, phase: 'success' } });
  assert.equal(h.element('persona').value, '編集中の名前');
  assert.equal(h.document.activeElement, h.element('persona'));
  assert.equal(h.element('persona').selectionStart, 2);
  assert.equal(h.element('persona').selectionEnd, 4);
  assert.equal(h.form.querySelectorAll().find((el) => el.name === 'saveHistory')!.checked, false);
});
test('IME composition defers a state redraw until composition finishes', async () => {
  const h = panelHarness(),
    input = h.element('message-input');
  h.app.listeners.get('compositionstart')!({});
  h.event({ type: 'state', state: { ...h.state, phase: 'success' } });
  assert.equal(h.element('message-input'), input);
  input.value = '変換中';
  input.listeners.get('input')!({ target: input });
  h.app.listeners.get('compositionend')!({});
  await Promise.resolve();
  assert.notEqual(h.element('message-input'), input);
  assert.equal(h.element('message-input').value, '変換中');
});
test('chat contains the current conversation plan and explicit approval controls', () => {
  const plan = {
    id: 'plan',
    rootId: 'root',
    rootIdentity: 'root',
    conversationId: 'conversation',
    revision: 1,
    hash: 'abc',
    expiresAt: 1000,
    createdAt: 0,
    status: 'ready' as const,
    entries: [],
    operations: [],
    totalBytes: 0,
  };
  const h = panelHarness({
    plans: [plan, { ...plan, id: 'other-plan', conversationId: 'another' }],
  });
  assert.match(h.html(), /この会話の整理案と作業記録/);
  assert.match(h.html(), /この内容で整理する/);
  assert.match(h.html(), /data-id="plan"/);
  assert.doesNotMatch(h.html(), /data-id="other-plan"/);
});
