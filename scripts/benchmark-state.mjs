import { _electron as electron } from 'playwright';
import { panelWindow } from './electron-test.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';

const directory = path.resolve('artifacts/state-benchmark-' + Date.now());
const data = path.join(directory, 'state');
await mkdir(data, { recursive: true });
const db = new DatabaseSync(path.join(data, 'companion.sqlite'));
db.exec(
  'CREATE TABLE records(bucket TEXT,id TEXT,value TEXT,PRIMARY KEY(bucket,id)); PRAGMA user_version=1; BEGIN;',
);
const put = db.prepare('INSERT INTO records VALUES(?,?,?)');
const rootId = randomUUID();
put.run(
  'roots',
  rootId,
  JSON.stringify({
    id: rootId,
    path: path.join(directory, 'files'),
    identity: 'benchmark',
    revoked: true,
  }),
);
const conversations = [];
for (let i = 0; i < 80; i++) {
  const id = randomUUID();
  conversations.push(id);
  put.run(
    'conversations',
    id,
    JSON.stringify({
      id,
      title: '負荷検証 ' + i,
      messages: Array.from({ length: 100 }, (_, j) => ({
        id: randomUUID(),
        role: j % 2 ? 'assistant' : 'user',
        content: '履歴負荷を確認するための検証用テキスト。'.repeat(20),
        createdAt: j,
      })),
    }),
  );
}
for (let i = 0; i < 100; i++) {
  const id = randomUUID();
  put.run(
    'plans',
    id,
    JSON.stringify({
      id,
      rootId,
      rootIdentity: 'benchmark',
      conversationId: conversations[0],
      revision: 1,
      hash: '',
      expiresAt: 0,
      createdAt: i,
      status: 'completed',
      entries: Array.from({ length: 200 }, (_, j) => ({
        id: randomUUID(),
        name: `fixture-${j}.txt`,
        size: 1,
        category: '文書',
        reason: '検証',
      })),
      operations: [],
      totalBytes: 0,
    }),
  );
}
db.exec('COMMIT;');
db.close();
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let app;
try {
  app = await electron.launch({ args: ['.', '--user-data-dir=' + data], env });
  const panel = await panelWindow(app);
  await panel.getByRole('heading', { name: '会話', exact: true }).waitFor();
  const results = await panel.evaluate(async () => {
    const result = {
      fixture: { conversations: 80, messages: 8000, plans: 100, entries: 20000 },
      events: [],
      hideMs: [],
      snapshotMs: [],
      backupMs: 0,
    };
    const unsubscribe = window.companion.onEvent((event) =>
      result.events.push({
        type: event.type,
        bytes: new TextEncoder().encode(JSON.stringify(event)).length,
      }),
    );
    for (let i = 0; i < 5; i++) {
      let start = performance.now();
      await window.companion.hideAvatar();
      result.hideMs.push(performance.now() - start);
      start = performance.now();
      await window.companion.state();
      result.snapshotMs.push(performance.now() - start);
    }
    unsubscribe();
    return result;
  });
  await app.evaluate(() => {
    globalThis.__maintenancePulse = { last: Date.now(), gaps: [] };
    globalThis.__maintenancePulse.timer = setInterval(() => {
      const probe = globalThis.__maintenancePulse,
        now = Date.now();
      probe.gaps.push(now - probe.last);
      probe.last = now;
    }, 10);
  });
  results.backupMs = await panel.evaluate(async () => {
    const start = performance.now();
    await window.companion.backupData();
    return performance.now() - start;
  });
  results.backupMainTimer = await app.evaluate(() => {
    const probe = globalThis.__maintenancePulse;
    clearInterval(probe.timer);
    delete globalThis.__maintenancePulse;
    return { intervalMs: 10, samples: probe.gaps.length, maxGapMs: Math.max(...probe.gaps) };
  });
  results.bundleSha256 = createHash('sha256')
    .update(await readFile('dist/main/index.cjs'))
    .digest('hex');
  results.methodology =
    'Isolated Electron fixture; renderer-to-main API round-trip including renderer event handling. Event sizes are UTF-8 JSON estimates, not Chromium wire sizes. No actual file moves or model inference.';
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ directory, ...results }, null, 2));
} finally {
  await app?.close();
}
