import assert from 'node:assert/strict';
import test from 'node:test';

import { edge, node, run } from '../test-support.js';
import type { Graph } from '../types.js';
import {
  MAX_SUBWORKFLOW_DEPTH,
  assertCanCall,
  isRetryable,
  terminalOutputs,
  type SubWorkflowRequest,
} from './index.js';

/** One workflow calling another: what comes back, and what is refused. */

function callerGraph(params: Record<string, unknown> = {}): Graph {
  return {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('child', 'action.executeWorkflow', { workflowId: 'wf_child', ...params }),
    ],
    edges: [edge('trigger', 'child')],
  };
}

test('a sub-workflow hands back the items it ended with', async () => {
  const seen: SubWorkflowRequest[] = [];
  const { result } = await run(callerGraph(), [{ json: { n: 1 } }], {
    runWorkflowById: async (request) => {
      seen.push(request);
      return { executionId: 'exec_child', status: 'success', items: [{ json: { done: true } }] };
    },
  });

  assert.equal(result.status, 'success');
  assert.deepEqual(result.outputs.child?.[0]?.[0]?.json, { done: true });
  assert.equal(seen[0]?.workflowId, 'wf_child');
  assert.equal(seen[0]?.wait, true);
  // The chain the child must not call back into.
  assert.deepEqual(seen[0]?.stack, ['wf_test']);
  assert.equal(seen[0]?.depth, MAX_SUBWORKFLOW_DEPTH);
});

test('running once per item calls the child once per item', async () => {
  let calls = 0;
  const { result } = await run(callerGraph({ mode: 'perItem' }), [{ json: { n: 1 } }, { json: { n: 2 } }], {
    runWorkflowById: async (request) => {
      calls++;
      assert.equal(request.items.length, 1);
      return { executionId: `exec_${calls}`, status: 'success', items: request.items };
    },
  });

  assert.equal(calls, 2);
  assert.deepEqual(result.outputs.child?.[0]?.map((item) => item.json.n), [1, 2]);
});

test('not waiting returns the execution id rather than any output', async () => {
  const { result } = await run(callerGraph({ waitForCompletion: false }), [{ json: {} }], {
    runWorkflowById: async () => ({ executionId: 'exec_child', status: 'queued', items: [] }),
  });

  assert.deepEqual(result.outputs.child?.[0]?.[0]?.json, { executionId: 'exec_child', queued: true });
});

test('a failed sub-workflow names the node inside it that failed', async () => {
  const { result } = await run(callerGraph(), [{ json: {} }], {
    runWorkflowById: async () => ({
      executionId: 'exec_child',
      status: 'failed',
      items: [],
      workflowName: 'Order sync',
      failure: {
        nodeId: 'send',
        nodeName: 'Send email',
        nodeType: 'action.httpRequest',
        errorType: 'HttpError500',
        message: 'the server said no',
        fingerprint: 'f',
      },
    }),
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.errorType, 'SubWorkflowError');
  assert.match(result.failure!.message, /"Order sync" failed at "Send email": the server said no/);
});

test('a workflow with nowhere to run a sub-workflow says so rather than hanging', async () => {
  const { result } = await run(callerGraph());
  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.errorType, 'SubWorkflowError');
  assert.match(result.failure!.message, /not available here/);
});

test('a sub-workflow failure is not retried', () => {
  assert.equal(isRetryable({ errorType: 'SubWorkflowError', message: 'child blew up' }), false);
});

test('a workflow may not call one that is already running above it', () => {
  assert.throws(
    () => assertCanCall(['wf_a', 'wf_b'], 5, 'wf_a'),
    /already running further up this chain/,
  );
  assert.doesNotThrow(() => assertCanCall(['wf_a'], 5, 'wf_b'));
});

test('nesting stops at the depth budget', () => {
  assert.throws(() => assertCanCall(['wf_a'], 0, 'wf_b'), /nested more than/);
});

test('a sub-workflow returns what its leaf nodes produced', () => {
  const graph: Graph = {
    nodes: [node('trigger', 'trigger.manual'), node('middle', 'action.set'), node('leaf', 'action.set')],
    edges: [edge('trigger', 'middle'), edge('middle', 'leaf')],
  };

  const items = terminalOutputs(graph, {
    trigger: [[{ json: { a: 1 } }]],
    middle: [[{ json: { b: 2 } }]],
    leaf: [[{ json: { c: 3 } }]],
  });

  assert.deepEqual(items, [{ json: { c: 3 } }]);
});

test('a node that never ran contributes nothing to the sub-workflow output', () => {
  const graph: Graph = {
    nodes: [node('trigger', 'trigger.manual'), node('a', 'action.set', {}, 0, 0), node('b', 'action.set', {}, 0, 100)],
    edges: [edge('trigger', 'a'), edge('trigger', 'b')],
  };

  assert.deepEqual(terminalOutputs(graph, { trigger: [[{ json: {} }]], a: [[{ json: { a: 1 } }]] }), [
    { json: { a: 1 } },
  ]);
});
