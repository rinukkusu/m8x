import assert from 'node:assert/strict';
import test from 'node:test';

import { edge, node, run } from '../test-support.js';
import type { Graph, Item } from '../types.js';
import type { RunEvent } from './index.js';

/**
 * Pinned outputs: the editor freezing what a node produced so iterating on the
 * rest of the workflow stops re-firing the trigger and everything under it.
 *
 * What is here is the part the runner decides — when a pin stands in for a node
 * and when it does not. Where pins are stored and who is allowed to supply them
 * lives on the server side, and that is what keeps a live run away from them.
 */

function starts(events: RunEvent[], nodeId: string) {
  return events.filter(
    (event): event is Extract<RunEvent, { type: 'nodeStart' }> =>
      event.type === 'nodeStart' && event.nodeId === nodeId,
  );
}

function finish(events: RunEvent[], nodeId: string) {
  return events.find(
    (event): event is Extract<RunEvent, { type: 'nodeFinish' }> =>
      event.type === 'nodeFinish' && event.nodeId === nodeId,
  );
}

/** trigger -> middle -> after, which is enough to pin anywhere in the chain. */
function chain(): Graph {
  return {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('middle', 'action.set', { assignments: [{ key: 'ran', value: 'really' }] }),
      node('after', 'action.set', { assignments: [{ key: 'saw', value: '{{ $json.ran }}' }] }),
    ],
    edges: [edge('trigger', 'middle'), edge('middle', 'after')],
  };
}

const pin = (items: Item[]) => [items];

test('a pinned node does not run, and downstream gets the pinned items', async () => {
  const { result, events } = await run(chain(), [{ json: {} }], {
    pinnedOutputs: { middle: pin([{ json: { ran: 'from the pin' } }]) },
  });

  assert.equal(result.status, 'success');
  assert.equal(starts(events, 'middle').length, 0, 'the node never started');
  assert.equal(result.outputs.after?.[0]?.[0]?.json.saw, 'from the pin');
});

test('a pin is reported as pinned rather than success', async () => {
  const { events } = await run(chain(), [{ json: {} }], {
    pinnedOutputs: { middle: pin([{ json: { ran: 'from the pin' } }]) },
  });

  const event = finish(events, 'middle');
  assert.equal(event?.status, 'pinned');
  // The items are on the event, so the detail view shows what was replayed
  // rather than an empty panel.
  assert.deepEqual(event?.output, [{ json: { ran: 'from the pin' } }]);
});

test('pinning a trigger replaces the payload the run was seeded with', async () => {
  const { result, events } = await run(chain(), [{ json: { ran: 'the seed' } }], {
    pinnedOutputs: { trigger: pin([{ json: { ran: 'the pin' } }]) },
  });

  assert.equal(result.status, 'success');
  assert.equal(starts(events, 'trigger').length, 0);
  // "middle" overwrites `ran`, so read the value the pin supplied off its input.
  assert.deepEqual(finish(events, 'middle')?.input, [{ json: { ran: 'the pin' } }]);
});

test('a pin does not run on a node the run never reached', async () => {
  const graph: Graph = {
    nodes: [
      node('manual', 'trigger.manual', {}, 0, 0),
      node('hook', 'trigger.webhook', { path: 'orders' }, 0, 200),
      node('never', 'action.set', { assignments: [{ key: 'ran', value: true }] }, 0, 300),
      node('after', 'action.set', { assignments: [{ key: 'ran', value: true }] }, 0, 400),
    ],
    // The run starts at the manual trigger, so nothing downstream of the
    // webhook trigger is reached.
    edges: [edge('hook', 'never'), edge('never', 'after')],
  };

  const { result, events } = await run(graph, [{ json: {} }], {
    pinnedOutputs: { never: pin([{ json: { ran: 'the pin' } }]) },
  });

  assert.equal(result.status, 'success');
  // A pin says what this node produces, not whether it is reached. Letting one
  // stand in here would fire a branch this run never took.
  assert.equal(finish(events, 'never')?.status, 'skipped');
  assert.equal(result.outputs.after, undefined);
});

test('a pin on an empty branch still supplies its items', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('if', 'flow.if', { conditionMode: 'comparison', left: '{{ $json.n }}', operator: 'gt', right: 10 }),
      node('no', 'action.set', { assignments: [{ key: 'ran', value: 'really' }] }, 0, 100),
      node('after', 'action.set', { assignments: [{ key: 'saw', value: '{{ $json.ran }}' }] }, 0, 200),
    ],
    edges: [edge('trigger', 'if'), edge('if', 'no', 1), edge('no', 'after')],
  };

  // The item takes the true branch, so "no" is reached with no items rather
  // than not reached at all — the runner draws that line, and a pin is on the
  // running side of it.
  const { result, events } = await run(graph, [{ json: { n: 99 } }], {
    pinnedOutputs: { no: pin([{ json: { ran: 'the pin' } }]) },
  });

  assert.equal(result.status, 'success');
  assert.equal(finish(events, 'no')?.status, 'pinned');
  assert.equal(result.outputs.after?.[0]?.[0]?.json.saw, 'the pin');
});

test('disabling a node beats pinning it', async () => {
  const graph = chain();
  graph.nodes[1] = { ...graph.nodes[1]!, disabled: true };

  const { result } = await run(graph, [{ json: { ran: 'the input' } }], {
    pinnedOutputs: { middle: pin([{ json: { ran: 'the pin' } }]) },
  });

  assert.equal(result.status, 'success');
  assert.equal(result.outputs.after?.[0]?.[0]?.json.saw, 'the input');
});

test('a pin keeps its branches apart', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('if', 'flow.if', { conditionMode: 'comparison', left: '{{ $json.n }}', operator: 'gt', right: 10 }),
      node('yes', 'action.set', { assignments: [{ key: 'branch', value: 'yes' }] }, 0, 100),
      node('no', 'action.set', { assignments: [{ key: 'branch', value: 'no' }] }, 0, 200),
    ],
    edges: [edge('trigger', 'if'), edge('if', 'yes', 0), edge('if', 'no', 1)],
  };

  const { result } = await run(graph, [{ json: { n: 1 } }], {
    pinnedOutputs: { if: [[{ json: { n: 99 } }], [{ json: { n: 2 } }]] },
  });

  assert.equal(result.status, 'success');
  assert.deepEqual(result.outputs.yes?.[0]?.[0]?.json, { n: 99, branch: 'yes' });
  assert.deepEqual(result.outputs.no?.[0]?.[0]?.json, { n: 2, branch: 'no' });
});

test('a pin on a loop node is ignored, because it would freeze every pass', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('loop', 'flow.loopOverItems', { batchSize: 1 }),
      node('body', 'action.set', { assignments: [{ key: 'seen', value: true }] }, 0, 100),
      node('after', 'flow.noOp', {}, 0, 300),
    ],
    edges: [edge('trigger', 'loop'), edge('loop', 'body', 0), edge('body', 'loop'), edge('loop', 'after', 1)],
  };

  const { result, events } = await run(graph, [{ json: { n: 1 } }, { json: { n: 2 } }], {
    pinnedOutputs: { loop: pin([{ json: { n: 'pinned' } }]) },
  });

  // Two items at a batch size of one, so the body ran twice off the real
  // batches rather than once off a pin that can only describe one of them.
  assert.equal(result.status, 'success');
  assert.equal(starts(events, 'body').length, 2);
});
