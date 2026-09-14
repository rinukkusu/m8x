import assert from 'node:assert/strict';
import test from 'node:test';

import { edge, node } from '../test-support.js';
import type { Graph, Item } from '../types.js';
import { capturePinnedOutput, MAX_ITEMS_STORED } from './payload.js';
import { pinRefusal } from './pins.js';

/**
 * The pure half of pinned data: which nodes may hold a pin, and how a pin is
 * cut down to size. Storing one needs a database and is exercised by using it.
 */

/** trigger -> loop, loop branch -> body -> back to loop, done branch -> after. */
function loopGraph(): Graph {
  return {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('loop', 'flow.loopOverItems', { batchSize: 1 }),
      node('body', 'action.set', { assignments: [] }, 0, 100),
      node('after', 'flow.noOp', {}, 0, 300),
    ],
    edges: [edge('trigger', 'loop'), edge('loop', 'body', 0), edge('body', 'loop'), edge('loop', 'after', 1)],
  };
}

test('an ordinary node can be pinned', () => {
  assert.equal(pinRefusal(loopGraph(), 'trigger'), null);
  // Fed by the loop's Done branch, so it runs once, outside the region.
  assert.equal(pinRefusal(loopGraph(), 'after'), null);
});

test('a node inside a loop region is refused, because it runs once per pass', () => {
  const refusal = pinRefusal(loopGraph(), 'body');
  assert.ok(refusal);
  assert.match(refusal, /pass/);
});

test('the loop node itself is refused', () => {
  assert.ok(pinRefusal(loopGraph(), 'loop'));
});

test('a node that is no longer on the canvas is refused', () => {
  assert.ok(pinRefusal(loopGraph(), 'deleted'));
});

// ---------------------------------------------------------------------------
// Capping
// ---------------------------------------------------------------------------

const items = (count: number, fill = 'x'): Item[] =>
  Array.from({ length: count }, (_, index) => ({ json: { index, fill } }));

test('a small pin is stored exactly as it was produced', () => {
  const captured = capturePinnedOutput([items(2), items(1)]);
  assert.equal(captured.truncated, false);
  assert.deepEqual(captured.branches, [items(2), items(1)]);
});

test('the item budget is spent across branches, not per branch', () => {
  const captured = capturePinnedOutput([items(MAX_ITEMS_STORED), items(10)]);

  assert.equal(captured.truncated, true);
  assert.equal(captured.branches[0]!.length, MAX_ITEMS_STORED);
  // The first branch used the whole budget, so the second keeps nothing — but
  // it is still there, because dropping it would change how many outputs the
  // node appears to have.
  assert.equal(captured.branches.length, 2);
  assert.equal(captured.branches[1]!.length, 0);
});

test('a pin over the byte cap is cut down rather than dropped', () => {
  const captured = capturePinnedOutput([items(20, 'y'.repeat(8_000))]);

  assert.equal(captured.truncated, true);
  assert.ok(captured.branches[0]!.length > 0, 'something useful survived');
  assert.ok(captured.branches[0]!.length < 20);
});

test('a single item too large to store leaves nothing behind', () => {
  const captured = capturePinnedOutput([[{ json: { blob: 'z'.repeat(200_000) } }]]);

  assert.equal(captured.truncated, true);
  assert.deepEqual(captured.branches, [[]]);
});
