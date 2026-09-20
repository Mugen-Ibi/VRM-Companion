import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StateSync } from '../src/renderer/state-sync';
import type { State, AppEvent } from '../src/shared/types';

test('a snapshot absorbs queued deltas and a sequence gap fetches authoritative state', async () => {
  let resolve!: (value: State) => void,
    reads = 0;
  const applied: AppEvent[] = [],
    snapshots: State[] = [];
  const sync = new StateSync(
    () => {
      reads++;
      return new Promise((done) => {
        resolve = done;
      });
    },
    (state) => snapshots.push(state),
    (event) => applied.push(event),
    (error) => {
      throw error;
    },
  );
  const delta = (sequence: number): AppEvent => ({
    type: 'delta',
    sequence,
    conversationId: 'c',
    messageId: 'm',
    text: String(sequence),
  });
  const initial = sync.refresh();
  sync.receive(delta(1));
  resolve({ sequence: 1 } as State);
  await initial;
  assert.equal(applied.length, 0);
  sync.receive(delta(2));
  sync.receive(delta(2));
  assert.equal(applied.length, 1);
  sync.receive(delta(4));
  assert.equal(reads, 2);
  sync.receive(delta(5));
  resolve({ sequence: 4 } as State);
  await sync.refresh();
  assert.deepEqual(
    applied.map((event) => event.sequence),
    [2, 5],
  );
  sync.receive({ type: 'state', sequence: 3, state: { sequence: 3 } as State });
  assert.deepEqual(
    snapshots.map((state) => state.sequence),
    [1, 4],
  );
});
