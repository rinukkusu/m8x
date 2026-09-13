import assert from 'node:assert/strict';
import test from 'node:test';

import { edge, node, run } from '../test-support.js';
import type { Graph } from '../types.js';
import { isRetryable, type RunEvent } from './index.js';

/** Running a loop region: batching, per-pass isolation, and the limit. */

/** trigger -> loop, loop branch -> body -> back to loop, done branch -> after. */
function loopGraph(batchSize: number, bodyParams: Record<string, unknown> = {}): Graph {
  return {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('loop', 'flow.loopOverItems', { batchSize }),
      node('body', 'action.set', { assignments: [{ key: 'seen', value: true }], ...bodyParams }, 0, 100),
      // No Operation rather than Set: Set makes an item out of an empty input,
      // which would hide a loop that produced nothing.
      node('after', 'flow.noOp', {}, 0, 300),
    ],
    edges: [
      edge('trigger', 'loop'),
      edge('loop', 'body', 0),
      edge('body', 'loop'),
      edge('loop', 'after', 1),
    ],
  };
}

function starts(events: RunEvent[], nodeId: string) {
  return events.filter(
    (event): event is Extract<RunEvent, { type: 'nodeStart' }> =>
      event.type === 'nodeStart' && event.nodeId === nodeId,
  );
}

test('a loop runs its branch once per batch', async () => {
  const { result, events } = await run(loopGraph(1), [{ json: { n: 1 } }, { json: { n: 2 } }, { json: { n: 3 } }]);

  assert.equal(result.status, 'success');
  assert.equal(starts(events, 'body').length, 3);
  // Done carries everything the branch produced, not the original input.
  assert.equal(result.outputs.after?.[0]?.length, 3);
  assert.equal(result.outputs.after?.[0]?.[0]?.json.seen, true);
});

test('a loop batches by the size it was given', async () => {
  const { result, events } = await run(
    loopGraph(2),
    [1, 2, 3, 4, 5].map((n) => ({ json: { n } })),
  );

  // 2, 2, then 1.
  assert.equal(starts(events, 'body').length, 3);
  assert.equal(result.outputs.after?.[0]?.length, 5);
});

test('a batch larger than the input is one pass', async () => {
  const { events } = await run(loopGraph(100), [{ json: { n: 1 } }, { json: { n: 2 } }]);
  assert.equal(starts(events, 'body').length, 1);
});

test('a loop over nothing never starts its branch', async () => {
  const graph = loopGraph(1);
  const { result, events } = await run(graph, []);

  assert.equal(result.status, 'success');
  assert.equal(starts(events, 'body').length, 0);
  assert.equal(result.outputs.after?.[0]?.length, 0);
});

test('each pass sees only its own batch', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('loop', 'flow.loopOverItems', { batchSize: 1 }),
      node('body', 'action.set', { assignments: [{ key: 'doubled', value: '{{ $json.n * 2 }}' }] }, 0, 100),
      node('after', 'flow.noOp', {}, 0, 300),
    ],
    edges: [edge('trigger', 'loop'), edge('loop', 'body', 0), edge('body', 'loop'), edge('loop', 'after', 1)],
  };

  const { result } = await run(graph, [{ json: { n: 1 } }, { json: { n: 2 } }, { json: { n: 3 } }]);

  // Done holds one item per pass, in the order the passes ran, and each one was
  // worked out from that pass's batch rather than the whole input.
  assert.deepEqual(result.outputs.after?.[0]?.map((item) => item.json.doubled), [2, 4, 6]);
});

test('events say which iteration they belong to', async () => {
  const { events } = await run(loopGraph(1), [{ json: { n: 1 } }, { json: { n: 2 } }]);

  assert.deepEqual(starts(events, 'body').map((event) => event.iteration), [1, 2]);
  // A node outside any loop is iteration 0.
  assert.deepEqual(starts(events, 'trigger').map((event) => event.iteration), [0]);

  const sequences = events.filter((event) => event.type !== 'log').map((event) => event.sequence);
  assert.deepEqual(sequences, [...sequences].sort((a, b) => a - b));
});

test('a loop whose upstream was skipped skips its whole region', async () => {
  const graph: Graph = {
    nodes: [
      node('manual', 'trigger.manual', {}, 0, 0),
      node('hook', 'trigger.webhook', { path: 'orders' }, 0, 200),
      node('loop', 'flow.loopOverItems', { batchSize: 1 }, 0, 300),
      node('body', 'action.set', { assignments: [{ key: 'seen', value: true }] }, 0, 400),
    ],
    edges: [edge('hook', 'loop'), edge('loop', 'body', 0), edge('body', 'loop')],
  };

  // The run started at the manual trigger, so the webhook trigger never fires
  // and nothing reaches the loop. The region has to go with it, or the nodes
  // inside would look like they ran and produced nothing.
  const { result, events } = await run(graph);
  assert.equal(result.status, 'success');

  const skipped = events
    .filter((event) => event.type === 'nodeFinish' && event.status === 'skipped')
    .map((event) => ('nodeId' in event ? event.nodeId : ''));
  assert.deepEqual(skipped.sort(), ['body', 'hook', 'loop']);
});

test('a failure inside a loop stops the run', async () => {
  const graph = loopGraph(1, { assignments: [{ key: '__proto__.polluted', value: 'yes' }] });
  const { result } = await run(graph, [{ json: { n: 1 } }, { json: { n: 2 } }]);

  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.nodeId, 'body');
});

test('a loop limit is not something to retry', () => {
  assert.equal(isRetryable({ errorType: 'LoopLimitError', message: 'ran too long' }), false);
});
