import { _electron as electron } from 'playwright';
import { panelWindow } from './electron-test.mjs';
import { DatabaseSync } from 'node:sqlite';
import { mkdir, copyFile, cp, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

if (!process.argv[2])
  throw new Error('Pass an offline test-fixture data directory from the previous release.');
const source = path.resolve(process.argv[2]);
const directory = path.resolve('artifacts/upgrade-' + Date.now()),
  data = path.join(directory, 'state');
await mkdir(data, { recursive: true });
for (const name of ['companion.sqlite', 'companion.sqlite-wal', 'companion.sqlite-shm']) {
  const file = path.join(source, name);
  if (
    await access(file).then(
      () => true,
      () => false,
    )
  )
    await copyFile(file, path.join(data, name));
}
if (
  await access(path.join(source, 'avatars')).then(
    () => true,
    () => false,
  )
)
  await cp(path.join(source, 'avatars'), path.join(data, 'avatars'), { recursive: true });
const db = new DatabaseSync(path.join(data, 'companion.sqlite'), { readOnly: true });
const read = (bucket) =>
  db
    .prepare('SELECT value FROM records WHERE bucket=? ORDER BY rowid')
    .all(bucket)
    .map((row) => JSON.parse(row.value));
const before = {
  conversations: read('conversations'),
  plans: read('plans'),
  avatars: read('avatars'),
};
db.close();
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const packaged = process.env.COMPANION_PACKAGE;
let app;
try {
  app = await electron.launch({
    ...(packaged ? { executablePath: path.resolve(packaged) } : {}),
    args: [...(packaged ? [] : ['.']), '--user-data-dir=' + data],
    env,
  });
  const panel = await panelWindow(app);
  await panel.getByRole('heading', { name: '会話', exact: true }).waitFor();
  const after = await panel.evaluate(() => window.companion.state());
  assert.deepEqual(after.conversations, before.conversations);
  assert.deepEqual(after.avatars, before.avatars);
  assert.deepEqual(
    after.plans.map((plan) => plan.id).sort(),
    before.plans.map((plan) => plan.id).sort(),
  );
  for (const plan of before.plans) {
    const restored = after.plans.find((value) => value.id === plan.id);
    assert.deepEqual(restored.operations, plan.operations);
    assert.equal(
      restored.status,
      plan.status === 'ready' ? 'stale' : plan.status === 'executing' ? 'recovery' : plan.status,
    );
  }
  const report = {
    passed: true,
    packaged: !!packaged,
    source,
    directory,
    conversations: before.conversations.length,
    plans: before.plans.length,
    avatars: before.avatars.length,
  };
  await writeFile(path.join(directory, 'result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await app?.close();
}
