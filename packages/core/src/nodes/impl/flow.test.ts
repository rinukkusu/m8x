import assert from 'node:assert/strict';
import test from 'node:test';

import { edge, node, run } from '../../test-support.js';
import type { Graph } from '../../types.js';

/** The branching nodes: If, Split Out, Merge, Switch, Wait, Stop and Error. */

test('If splits items across two branches', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('if', 'flow.if', { conditionMode: 'comparison', left: '{{ $json.n }}', operator: 'gt', right: 2 }),
      node('yes', 'action.set', { assignments: [{ key: 'branch', value: 'yes' }] }, 0, 0),
      node('no', 'action.set', { assignments: [{ key: 'branch', value: 'no' }] }, 0, 200),
    ],
    edges: [edge('trigger', 'if'), edge('if', 'yes', 0), edge('if', 'no', 1)],
  };

  const { result } = await run(graph, [{ json: { n: 1 } }, { json: { n: 3 } }, { json: { n: 5 } }]);
  assert.equal(result.status, 'success');
  assert.equal(result.outputs.yes?.[0]?.length, 2);
  assert.equal(result.outputs.no?.[0]?.length, 1);
});

test('Split Out turns an array field into items', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('split', 'flow.splitOut', { field: 'body.results' }),
    ],
    edges: [edge('trigger', 'split')],
  };

  const { result } = await run(graph, [{ json: { body: { results: [{ id: 1 }, { id: 2 }] } } }]);
  assert.equal(result.outputs.split?.[0]?.length, 2);
  assert.equal(result.outputs.split?.[0]?.[1]?.json.id, 2);
});

test('Split Out names the actual type when the field is not an array', async () => {
  const graph: Graph = {
    nodes: [node('trigger', 'trigger.manual'), node('split', 'flow.splitOut', { field: 'body' })],
    edges: [edge('trigger', 'split')],
  };

  const { result } = await run(graph, [{ json: { body: 'oops' } }]);
  assert.equal(result.status, 'failed');
  assert.match(result.failure!.message, /not an array/);
});

test('Merge combines two inputs by a matching field', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('left', 'action.set', { assignments: [{ key: 'id', value: 1 }, { key: 'a', value: 'x' }] }, 0, 0),
      node('right', 'action.set', { assignments: [{ key: 'id', value: 1 }, { key: 'b', value: 'y' }] }, 0, 200),
      node('merge', 'flow.merge', { mode: 'key', leftKey: 'id', rightKey: 'id' }, 0, 400),
    ],
    edges: [
      edge('trigger', 'left'),
      edge('trigger', 'right'),
      edge('left', 'merge', 0, 0),
      edge('right', 'merge', 0, 1),
    ],
  };

  const { result } = await run(graph);
  assert.equal(result.status, 'success');
  const merged = result.outputs.merge?.[0]?.[0]?.json;
  assert.equal(merged?.a, 'x');
  assert.equal(merged?.b, 'y');
});

test('Switch sends each item down the first branch that matches', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('switch', 'flow.switch', {
        rules: [
          { key: 'big', value: '{{ $json.n > 10 }}' },
          { key: 'small', value: '{{ $json.n > 0 }}' },
        ],
      }),
    ],
    edges: [edge('trigger', 'switch')],
  };

  const { result } = await run(graph, [{ json: { n: 50 } }, { json: { n: 5 } }, { json: { n: -1 } }]);
  assert.equal(result.status, 'success');
  assert.equal(result.outputs.switch?.[0]?.length, 1);
  // 5 matches the second rule only; 50 matches both but stops at the first.
  assert.equal(result.outputs.switch?.[1]?.[0]?.json.n, 5);
  // Nothing matched -1 and there is no fallback branch, so it is dropped.
  assert.equal(result.outputs.switch?.length, 2);
});

test('Switch can send an item to every matching branch', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('switch', 'flow.switch', {
        allMatches: true,
        rules: [
          { key: 'big', value: '{{ $json.n > 10 }}' },
          { key: 'positive', value: '{{ $json.n > 0 }}' },
        ],
      }),
    ],
    edges: [edge('trigger', 'switch')],
  };

  const { result } = await run(graph, [{ json: { n: 50 } }]);
  assert.equal(result.outputs.switch?.[0]?.length, 1);
  assert.equal(result.outputs.switch?.[1]?.length, 1);
});

test('the Switch fallback branch collects what nothing matched', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('switch', 'flow.switch', {
        fallback: true,
        rules: [{ key: 'paid', value: '{{ $json.status === "paid" }}' }],
      }),
    ],
    edges: [edge('trigger', 'switch')],
  };

  const { result } = await run(graph, [{ json: { status: 'refunded' } }]);
  assert.equal(result.outputs.switch?.[0]?.length, 0);
  assert.equal(result.outputs.switch?.[1]?.[0]?.json.status, 'refunded');
});

test('a Switch rule resolving to the string "false" does not match', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('switch', 'flow.switch', { fallback: true, rules: [{ key: 'yes', value: '{{ $json.flag }}' }] }),
    ],
    edges: [edge('trigger', 'switch')],
  };

  const { result } = await run(graph, [{ json: { flag: 'false' } }]);
  assert.equal(result.outputs.switch?.[0]?.length, 0);
  assert.equal(result.outputs.switch?.[1]?.length, 1);
});

test('Stop and Error fails the run with the message it was given', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('stop', 'flow.stopAndError', { message: 'Order {{ $json.id }} has no address' }),
    ],
    edges: [edge('trigger', 'stop')],
  };

  const { result } = await run(graph, [{ json: { id: 7 } }]);
  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.errorType, 'WorkflowError');
  assert.equal(result.failure?.message, 'Order 7 has no address');
});

test('Wait refuses a wait longer than a run should be held open for', async () => {
  const graph: Graph = {
    nodes: [node('trigger', 'trigger.manual'), node('wait', 'flow.wait', { amount: 30, unit: 'minutes' })],
    edges: [edge('trigger', 'wait')],
  };

  const { result } = await run(graph);
  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.errorType, 'ConfigurationError');
});

test('Wait passes its items through', async () => {
  const graph: Graph = {
    nodes: [node('trigger', 'trigger.manual'), node('wait', 'flow.wait', { amount: 0, unit: 'seconds' })],
    edges: [edge('trigger', 'wait')],
  };

  const { result } = await run(graph, [{ json: { n: 1 } }]);
  assert.equal(result.status, 'success');
  assert.equal(result.outputs.wait?.[0]?.[0]?.json.n, 1);
});
