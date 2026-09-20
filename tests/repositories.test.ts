import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/main/store';
import { Repositories } from '../src/main/repositories';

test('valid legacy records remain readable and malformed records fail closed without removal', () => {
  const directory = path.resolve('artifacts/repository-tests', randomUUID());
  fs.mkdirSync(directory, { recursive: true });
  const store = new Store(directory),
    records = new Repositories(store),
    id = randomUUID();
  try {
    const conversation = {
      id,
      title: '旧版の会話',
      messages: [{ id: randomUUID(), role: 'user' as const, content: '保持する', createdAt: 1 }],
    };
    store.put('conversations', id, conversation);
    assert.deepEqual(records.conversations.get(id), conversation);
    const invalid = { ...conversation, messages: 'invalid' };
    store.put('conversations', id, invalid);
    assert.throws(() => records.validate(), /保存データの形式/);
    assert.deepEqual(store.get('conversations', id), invalid);
    assert.throws(() => records.conversations.put(invalid as any), /保存データの形式/);
  } finally {
    store.close();
  }
});
test('multi-record writes roll back when the later write fails', () => {
  const store = new Store(path.resolve('artifacts/repository-tests', randomUUID()));
  try {
    store.put('settings', 'main', { old: true });
    assert.throws(
      () =>
        store.transaction(() => {
          store.put('secrets', 'apiKey', 'replacement');
          store.put('settings', 'main', { old: false });
          throw new Error('disk failure');
        }),
      /disk failure/,
    );
    assert.equal(store.get('secrets', 'apiKey'), undefined);
    assert.deepEqual(store.get('settings', 'main'), { old: true });
  } finally {
    store.close();
  }
});
