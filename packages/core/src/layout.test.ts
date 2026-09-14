import assert from 'node:assert/strict';
import test from 'node:test';

import { autoLayout } from './layout.js';
import { edge, node } from './test-support.js';
import type { Graph } from './types.js';

/** Tidying a canvas: columns follow the edges, rows follow what feeds them. */

test('a chain becomes one straight, evenly spaced line', () => {
  const graph: Graph = {
    nodes: [node('a', 'trigger.manual', {}, 13, 47), node('b', 'action.set', {}, 400, 190), node('c', 'action.set', {}, 90, 600)],
    edges: [edge('a', 'b'), edge('b', 'c')],
  };

  const placed = autoLayout(graph);

  assert.equal(placed.get('a')!.y, placed.get('b')!.y);
  assert.equal(placed.get('b')!.y, placed.get('c')!.y);
  assert.ok(placed.get('a')!.x < placed.get('b')!.x);
  assert.equal(placed.get('b')!.x - placed.get('a')!.x, placed.get('c')!.x - placed.get('b')!.x);
});

test('the laid out graph starts where the old one did', () => {
  const graph: Graph = {
    nodes: [node('a', 'trigger.manual', {}, 120, 80), node('b', 'action.set', {}, 700, 500)],
    edges: [edge('a', 'b')],
  };

  const placed = autoLayout(graph);

  assert.deepEqual(placed.get('a'), { x: 120, y: 80 });
});

test('a branch fans out into its own rows, in the order it was drawn', () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual', {}, 0, 0),
      node('lower', 'action.set', {}, 300, 400),
      node('upper', 'action.set', {}, 300, 100),
    ],
    edges: [edge('trigger', 'upper'), edge('trigger', 'lower')],
  };

  const placed = autoLayout(graph);

  assert.equal(placed.get('upper')!.x, placed.get('lower')!.x);
  assert.ok(placed.get('upper')!.y < placed.get('lower')!.y);
  assert.ok(placed.get('trigger')!.x < placed.get('upper')!.x);
});

test('a node waits for its furthest source rather than its nearest', () => {
  const graph: Graph = {
    nodes: [
      node('a', 'trigger.manual'),
      node('b', 'action.set'),
      node('c', 'action.set'),
      node('join', 'action.set'),
    ],
    edges: [edge('a', 'b'), edge('b', 'c'), edge('a', 'join'), edge('c', 'join')],
  };

  const placed = autoLayout(graph);
  const step = placed.get('b')!.x - placed.get('a')!.x;

  assert.equal(placed.get('join')!.x - placed.get('a')!.x, step * 3);
});

test('the wire back to a loop node does not push the loop to the right', () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('loop', 'flow.loopOverItems'),
      node('body', 'action.set'),
      node('after', 'action.set'),
    ],
    edges: [edge('trigger', 'loop'), edge('loop', 'body', 0), edge('body', 'loop'), edge('loop', 'after', 1)],
  };

  const placed = autoLayout(graph);

  assert.ok(placed.get('loop')!.x < placed.get('body')!.x);
  assert.ok(placed.get('trigger')!.x < placed.get('loop')!.x);
});

test('a graph stuck in a cycle still gets every node a position', () => {
  const graph: Graph = {
    nodes: [node('a', 'trigger.manual'), node('b', 'action.set'), node('c', 'action.set')],
    edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'b')],
  };

  const placed = autoLayout(graph);

  assert.equal(placed.size, 3);
  assert.equal(new Set([...placed.values()].map((position) => `${position.x}:${position.y}`)).size, 3);
});

test('an empty graph lays out to nothing', () => {
  assert.equal(autoLayout({ nodes: [], edges: [] }).size, 0);
});
