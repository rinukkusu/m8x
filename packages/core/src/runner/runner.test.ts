import assert from 'node:assert/strict';
import test from 'node:test';

import { edge, node, run } from '../test-support.js';
import type { Graph } from '../types.js';
import { isRetryable, runWorkflow, type RunEvent } from './index.js';

/**
 * The runner itself: which nodes run, which are skipped, and what happens when
 * one of them fails.
 *
 * Everything a node type does on its own lives beside that node; what is here
 * is the part the runner decides.
 */

test('a node whose upstream branch was not taken is skipped, not run empty', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('if', 'flow.if', { conditionMode: 'comparison', left: '{{ $json.n }}', operator: 'gt', right: 10 }),
      node('yes', 'action.set', { assignments: [{ key: 'ran', value: true }] }),
    ],
    edges: [edge('trigger', 'if'), edge('if', 'yes', 0)],
  };

  const { result, events } = await run(graph, [{ json: { n: 1 } }]);
  assert.equal(result.status, 'success');

  // The true branch is empty, so "yes" still runs with zero items. That is the
  // difference between an empty branch and a branch that was never reached.
  const yesFinish = events.find(
    (event): event is Extract<RunEvent, { type: 'nodeFinish' }> =>
      event.type === 'nodeFinish' && event.nodeId === 'yes',
  );
  assert.equal(yesFinish?.status, 'success');
});

test('a disabled node whose upstream was skipped stays skipped', async () => {
  const graph: Graph = {
    nodes: [
      node('manual', 'trigger.manual', {}, 0, 0),
      node('hook', 'trigger.webhook', { path: 'orders' }, 0, 200),
      { ...node('off', 'action.set', { assignments: [] }), disabled: true },
      node('after', 'action.set', { assignments: [{ key: 'ran', value: true }] }),
    ],
    edges: [edge('hook', 'off'), edge('off', 'after')],
  };

  // The run started at the manual trigger, so the webhook trigger is skipped
  // and nothing reaches the disabled node. Passing an empty input through it
  // would fire the side effects of a branch this run never took.
  const { result } = await run(graph);
  assert.equal(result.status, 'success');
  assert.equal(result.outputs.after, undefined);
});

test('a disabled node still passes its input along', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      { ...node('off', 'action.set', { assignments: [{ key: 'skipped', value: true }] }), disabled: true },
      node('after', 'action.set', { assignments: [{ key: 'ran', value: true }] }),
    ],
    edges: [edge('trigger', 'off'), edge('off', 'after')],
  };

  const { result } = await run(graph, [{ json: { n: 1 } }]);
  assert.equal(result.status, 'success');
  assert.deepEqual(result.outputs.after?.[0]?.[0]?.json, { n: 1, ran: true });
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

test('a failing node stops the run and names itself', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('bad', 'flow.splitOut', { field: 'missing' }),
      node('after', 'action.set', { assignments: [] }),
    ],
    edges: [edge('trigger', 'bad'), edge('bad', 'after')],
  };

  const { result } = await run(graph);
  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.nodeId, 'bad');
  assert.ok(result.failure?.fingerprint);
  assert.equal(result.outputs.after, undefined);
});

test('continueOnFail lets the run carry on with an error item', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      { ...node('bad', 'flow.splitOut', { field: 'missing' }), continueOnFail: true },
      node('after', 'action.set', { assignments: [{ key: 'saw', value: '{{ $json.error.type }}' }] }),
    ],
    edges: [edge('trigger', 'bad'), edge('bad', 'after')],
  };

  const { result } = await run(graph);
  assert.equal(result.status, 'success');
  assert.equal(result.outputs.after?.[0]?.[0]?.json.saw, 'DataError');
});

test('a missing required parameter fails as configuration, before the node runs', async () => {
  const graph: Graph = {
    nodes: [node('trigger', 'trigger.manual'), node('http', 'action.httpRequest', { method: 'GET' })],
    edges: [edge('trigger', 'http')],
  };

  const { result } = await run(graph);
  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.errorType, 'ConfigurationError');
});

test('each retry attempt is reported separately', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      {
        ...node('http', 'action.httpRequest', {
          method: 'GET',
          url: 'http://127.0.0.1:1/never',
          timeoutMs: 200,
        }),
        retries: 2,
        retryBackoffMs: 1,
      },
    ],
    edges: [edge('trigger', 'http')],
  };

  const { result, events } = await run(graph);
  assert.equal(result.status, 'failed');

  const attempts = events.filter(
    (event) => event.type === 'nodeFinish' && event.nodeId === 'http',
  );
  assert.equal(attempts.length, 3, 'one initial attempt plus two retries');
});

test('a configuration error is not retried', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      { ...node('http', 'action.httpRequest', { method: 'GET', url: 'not a url' }), retries: 3, retryBackoffMs: 1 },
    ],
    edges: [edge('trigger', 'http')],
  };

  const { events } = await run(graph);
  const attempts = events.filter((event) => event.type === 'nodeFinish' && event.nodeId === 'http');
  assert.equal(attempts.length, 1);
});

// ---------------------------------------------------------------------------
// Retry from a node
// ---------------------------------------------------------------------------

test('retrying from a node reuses the stored upstream output', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('first', 'action.set', { assignments: [{ key: 'from', value: 'fresh' }] }),
      node('second', 'action.set', { assignments: [{ key: 'seen', value: '{{ $json.from }}' }] }),
    ],
    edges: [edge('trigger', 'first'), edge('first', 'second')],
  };

  const events: RunEvent[] = [];
  const result = await runWorkflow({
    executionId: 'exec_retry',
    workflowId: 'wf_test',
    mode: 'retry',
    graph,
    seedItems: [],
    resumeFromNodeId: 'second',
    restoredOutputs: { first: [[{ json: { from: 'restored' } }]] },
    signal: new AbortController().signal,
    loadCredential: async () => null,
    emit: (event) => {
      events.push(event);
    },
  });

  assert.equal(result.status, 'success');
  assert.equal(result.outputs.second?.[0]?.[0]?.json.seen, 'restored');
  // The upstream node must not run again; its side effects already happened.
  assert.equal(events.some((event) => event.type === 'nodeStart' && event.nodeId === 'first'), false);
});

// ---------------------------------------------------------------------------
// Retry classification
// ---------------------------------------------------------------------------

test('a Telegram 4xx is not retried, a 429 and a 5xx are', () => {
  // Telegram answers with HTTP status codes, so it follows the same rule as
  // the HTTP node: a wrong chat id will still be wrong on the third attempt.
  const failing = (errorType: string) => isRetryable({ errorType, message: 'x' });

  assert.equal(failing('TelegramError400'), false);
  assert.equal(failing('TelegramError403'), false);
  assert.equal(failing('TelegramError429'), true);
  assert.equal(failing('TelegramError500'), true);
  // Reaching Telegram at all is worth another go.
  assert.equal(failing('TelegramNetworkError'), true);
});

// ---------------------------------------------------------------------------
// Choosing the trigger
// ---------------------------------------------------------------------------

/** Two triggers feeding one action, laid out so schedule sits above webhook. */
function twoTriggers(): Graph {
  return {
    nodes: [
      node('schedule', 'trigger.schedule', {}, 0, 0),
      node('webhook', 'trigger.webhook', { path: 'hook' }, 0, 200),
      node('act', 'action.set', { assignments: [{ key: 'ran', value: 'yes' }] }, 200, 100),
    ],
    edges: [edge('schedule', 'act'), edge('webhook', 'act')],
  };
}

test('a run names the trigger it started from, wherever that sits on the canvas', async () => {
  const { result } = await run(twoTriggers(), [{ json: { from: 'the webhook' } }], {
    triggerNodeId: 'webhook',
  });

  assert.equal(result.status, 'success');
  assert.deepEqual(result.outputs.webhook?.[0], [{ json: { from: 'the webhook' } }]);
  // The other trigger did not fire, so it produces nothing rather than a copy
  // of the seed items.
  assert.deepEqual(result.outputs.schedule?.[0] ?? [], []);
});

test('the trigger that did not fire is reported as skipped, not as empty', async () => {
  const { events } = await run(twoTriggers(), [{ json: {} }], { triggerNodeId: 'webhook' });

  const skipped = events.find(
    (event) => event.type === 'nodeFinish' && event.nodeId === 'schedule',
  );
  assert.equal(skipped?.type === 'nodeFinish' && skipped.status, 'skipped');
  assert.match(
    (skipped?.type === 'nodeFinish' && skipped.error?.message) || '',
    /not the trigger for this run/,
  );
});

test('a run that names no trigger starts at the first one on the canvas', async () => {
  // A manual run: nothing fired, so the topmost trigger is taken to be meant.
  const { result } = await run(twoTriggers(), [{ json: { from: 'the run button' } }]);

  assert.equal(result.status, 'success');
  assert.deepEqual(result.outputs.schedule?.[0], [{ json: { from: 'the run button' } }]);
  assert.deepEqual(result.outputs.webhook?.[0] ?? [], []);
});

test('resuming from a node is separate from which trigger fired', async () => {
  const graph = twoTriggers();
  graph.nodes.push(node('after', 'action.set', { assignments: [{ key: 'seen', value: '{{ $json.ran }}' }] }, 400, 100));
  graph.edges.push(edge('act', 'after'));

  const { result, events } = await run(graph, [{ json: {} }], {
    triggerNodeId: 'webhook',
    resumeFromNodeId: 'after',
    restoredOutputs: { act: [[{ json: { ran: 'restored' } }]] },
  });

  assert.equal(result.status, 'success');
  assert.equal(result.outputs.after?.[0]?.[0]?.json.seen, 'restored');
  // Nothing upstream re-ran, the trigger it names included.
  const ran = events.filter((event) => event.type === 'nodeStart').map((event) => event.nodeId);
  assert.deepEqual(ran, ['after']);
});
