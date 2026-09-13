import assert from 'node:assert/strict';
import test from 'node:test';

import { analyseLoops, findCycle, topologicalOrder } from './graph.js';
import { edge, node, run } from './test-support.js';
import type { Graph } from './types.js';

/** Ordering, cycle detection, and which cycles count as a loop. */

test('topological order respects dependencies', () => {
  const graph: Graph = {
    nodes: [node('c', 'action.set'), node('a', 'trigger.manual'), node('b', 'action.set')],
    edges: [edge('a', 'b'), edge('b', 'c')],
  };

  const order = topologicalOrder(graph).map((entry) => entry.id);
  assert.deepEqual(order, ['a', 'b', 'c']);
});

test('independent branches run in canvas order, not insertion order', () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual', {}, 0, 100),
      node('lower', 'action.set', {}, 200, 300),
      node('upper', 'action.set', {}, 200, 0),
    ],
    edges: [edge('trigger', 'lower'), edge('trigger', 'upper')],
  };

  const order = topologicalOrder(graph).map((entry) => entry.id);
  assert.deepEqual(order, ['trigger', 'upper', 'lower']);
});

test('a cycle is detected and named', () => {
  const graph: Graph = {
    nodes: [node('a', 'trigger.manual'), node('b', 'action.set'), node('c', 'action.set')],
    edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'b')],
  };

  const cycle = findCycle(graph);
  assert.ok(cycle, 'expected a cycle');
  assert.ok(cycle.includes('b') && cycle.includes('c'));
});

test('a workflow with a cycle fails before running anything', async () => {
  const graph: Graph = {
    nodes: [node('a', 'trigger.manual'), node('b', 'action.set'), node('c', 'action.set')],
    edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'b')],
  };

  const { result, events } = await run(graph);
  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.errorType, 'GraphError');
  assert.equal(events.length, 0);
});

// ---------------------------------------------------------------------------
// Loop validation
// ---------------------------------------------------------------------------

test('only a loop node may close a cycle', async () => {
  const graph: Graph = {
    nodes: [node('a', 'trigger.manual'), node('b', 'action.set'), node('c', 'action.set')],
    edges: [edge('a', 'b'), edge('b', 'c'), edge('c', 'b')],
  };

  const { result, events } = await run(graph);
  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.errorType, 'GraphError');
  assert.match(result.failure!.message, /Only a Loop Over Items node can close a loop/);
  assert.equal(events.length, 0);
});

test('the Done branch may not lead back into the loop', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('loop', 'flow.loopOverItems', { batchSize: 1 }),
      node('report', 'action.set', { assignments: [] }, 0, 100),
    ],
    edges: [edge('trigger', 'loop'), edge('loop', 'report', 1), edge('report', 'loop')],
  };

  const { result } = await run(graph);
  assert.equal(result.status, 'failed');
  assert.match(result.failure!.message, /is on the Done branch of "loop" and leads back into it/);
});

test('a loop inside a loop is refused by name', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('outer', 'flow.loopOverItems', { batchSize: 1 }),
      node('inner', 'flow.loopOverItems', { batchSize: 1 }, 0, 100),
      node('body', 'action.set', { assignments: [] }, 0, 200),
    ],
    edges: [
      edge('trigger', 'outer'),
      edge('outer', 'inner', 0),
      edge('inner', 'body', 0),
      edge('body', 'inner'),
      edge('inner', 'outer', 1),
    ],
  };

  const { result } = await run(graph);
  assert.equal(result.status, 'failed');
  assert.match(result.failure!.message, /Loops inside loops are not supported yet/);
});

test('a loop region holds what the Loop branch reaches, minus what Done reaches', () => {
  const graph: Graph = {
    nodes: [
      node('loop', 'flow.loopOverItems'),
      node('body', 'action.set', {}, 0, 100),
      node('join', 'flow.merge', {}, 0, 300),
      node('report', 'action.set', {}, 0, 400),
    ],
    edges: [
      edge('loop', 'body', 0),
      edge('body', 'loop'),
      // Fed by both branches, so it is where the loop rejoins the workflow and
      // belongs outside the region.
      edge('body', 'join', 0, 0),
      edge('loop', 'join', 1, 1),
      edge('join', 'report'),
    ],
  };

  const analysis = analyseLoops(graph);
  assert.deepEqual([...(analysis.regions.get('loop') ?? [])].sort(), ['body']);
  assert.equal(analysis.backEdges.size, 1);
});
