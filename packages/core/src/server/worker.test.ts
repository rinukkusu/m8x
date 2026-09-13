import assert from 'node:assert/strict';
import test from 'node:test';

import { node } from '../test-support.js';
import type { Graph } from '../types.js';
import { manualTriggerId } from './worker.js';

/**
 * Where a run started by an Execute Workflow node enters the child.
 *
 * Everything else in the worker needs a database and a queue to reach, so this
 * is the one piece worth testing on its own — and it is the piece that decides
 * whether a child holding two triggers runs the right half of itself.
 */

function graph(...nodes: Graph['nodes']): Graph {
  return { nodes, edges: [] };
}

test('a child is entered at its manual trigger, not at whatever is first', () => {
  // The webhook comes first in the graph, which is what the run would have
  // fallen back to. Being called by another workflow is the manual trigger's
  // job, so it wins whatever the canvas order says.
  const child = graph(
    node('hook', 'trigger.webhook', { path: 'orders' }),
    node('manual', 'trigger.manual'),
    node('work', 'flow.noOp'),
  );

  assert.equal(manualTriggerId(child), 'manual');
});

test('a child with only a manual trigger names it too, rather than relying on the fallback', () => {
  assert.equal(manualTriggerId(graph(node('manual', 'trigger.manual'))), 'manual');
});

test('a child with no manual trigger names nothing and falls back', () => {
  // A workflow built around a webhook and also called directly. The first
  // trigger on the canvas is the only sensible answer, and the runner's own
  // fallback is what gives it.
  const child = graph(node('hook', 'trigger.webhook', { path: 'orders' }), node('work', 'flow.noOp'));

  assert.equal(manualTriggerId(child), undefined);
});

test('a manual trigger that is switched off is not an entry point', () => {
  const disabled = { ...node('manual', 'trigger.manual'), disabled: true };
  const child = graph(node('hook', 'trigger.webhook', { path: 'orders' }), disabled);

  assert.equal(manualTriggerId(child), undefined);
});
