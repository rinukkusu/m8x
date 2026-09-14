import assert from 'node:assert/strict';
import test from 'node:test';

import { readExecutionInput, storedExecutionInput } from './execution-input.js';
import type { Item } from '../types.js';

/**
 * What the worker reads out of a row the web app wrote.
 *
 * These two functions are the only place the payload's shape is known, and a
 * row written by the version before an upgrade is read by the version after it,
 * so the old spellings have to keep working.
 */

const items: Item[] = [{ json: { hello: 'world' } }];

test('a run with nothing but items stores a bare array', () => {
  assert.deepEqual(storedExecutionInput({ seedItems: items }), items);
});

test('items survive the round trip', () => {
  assert.deepEqual(readExecutionInput(storedExecutionInput({ seedItems: items })).seedItems, items);
});

test('the trigger and the resume point survive the round trip', () => {
  const stored = storedExecutionInput({
    seedItems: items,
    triggerNodeId: 'webhook_1',
    resumeFromNodeId: 'http_3',
  });

  assert.deepEqual(readExecutionInput(stored), {
    seedItems: items,
    triggerNodeId: 'webhook_1',
    resumeFromNodeId: 'http_3',
  });
});

test('the pinned-data flag survives the round trip, and is absent unless set', () => {
  const pinned = readExecutionInput(storedExecutionInput({ seedItems: items, usePinnedData: true }));
  assert.equal(pinned.usePinnedData, true);

  // A run that never mentioned pins reads back without the key at all, rather
  // than with a false that a later `in` check would trip over.
  const plain = readExecutionInput(storedExecutionInput({ seedItems: items }));
  assert.equal('usePinnedData' in plain, false);

  // And it is not something a trigger can turn on by accident: the flag only
  // exists because whoever queued the run put it there.
  assert.equal(readExecutionInput(items).usePinnedData, undefined);
});

test('either node id can be set on its own', () => {
  const triggered = readExecutionInput(
    storedExecutionInput({ seedItems: items, triggerNodeId: 'schedule_1' }),
  );
  assert.equal(triggered.triggerNodeId, 'schedule_1');
  assert.equal(triggered.resumeFromNodeId, undefined);

  const resumed = readExecutionInput(
    storedExecutionInput({ seedItems: [], resumeFromNodeId: 'set_2' }),
  );
  assert.equal(resumed.triggerNodeId, undefined);
  assert.equal(resumed.resumeFromNodeId, 'set_2');
});

test('a row written before the split still names both', () => {
  // `startNodeId` carried both meanings at once, so a queued row from the
  // previous version has to keep behaving the way it did when it was written.
  const legacy = { items, startNodeId: 'telegram_1' };

  assert.deepEqual(readExecutionInput(legacy), {
    seedItems: items,
    triggerNodeId: 'telegram_1',
    resumeFromNodeId: 'telegram_1',
  });
});

test('a new spelling wins over the old one when a row somehow has both', () => {
  const mixed = { items, startNodeId: 'old', triggerNodeId: 'new', resumeFromNodeId: 'newer' };
  const read = readExecutionInput(mixed);

  assert.equal(read.triggerNodeId, 'new');
  assert.equal(read.resumeFromNodeId, 'newer');
});

test('a bare array, as every run before the field existed was stored', () => {
  const read = readExecutionInput(items);

  assert.deepEqual(read.seedItems, items);
  assert.equal(read.triggerNodeId, undefined);
  assert.equal(read.resumeFromNodeId, undefined);
});

test('a payload that makes no sense is an empty run, not a crash', () => {
  for (const nonsense of [null, undefined, 'a string', 42, {}, { items: 'not a list' }]) {
    const read = readExecutionInput(nonsense);
    assert.deepEqual(read.seedItems, [], `${JSON.stringify(nonsense)} should read as no items`);
    assert.equal(read.triggerNodeId, undefined);
  }
});

test('an empty node id is treated as absent rather than as a node called ""', () => {
  const read = readExecutionInput({ items, triggerNodeId: '', resumeFromNodeId: '' });

  assert.equal(read.triggerNodeId, undefined);
  assert.equal(read.resumeFromNodeId, undefined);
});
