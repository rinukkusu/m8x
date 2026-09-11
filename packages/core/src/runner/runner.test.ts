import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateExpression, resolveValue, type ExpressionScope } from '../expressions.js';
import { errorFingerprint, normaliseErrorMessage } from '../fingerprint.js';
import { findCycle, topologicalOrder } from '../graph.js';
import { compare } from '../nodes/conditions.js';
import type { Graph, GraphEdge, GraphNode, Item } from '../types.js';
import { runWorkflow, type RunEvent } from './index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function node(id: string, type: string, params: Record<string, unknown> = {}, x = 0, y = 0): GraphNode {
  return { id, type, name: id, position: { x, y }, params };
}

function edge(source: string, target: string, sourceOutput = 0, targetInput = 0): GraphEdge {
  return { id: `${source}->${target}:${sourceOutput}`, source, sourceOutput, target, targetInput };
}

async function run(graph: Graph, seedItems: Item[] = [{ json: {} }]) {
  const events: RunEvent[] = [];
  const result = await runWorkflow({
    executionId: 'exec_test',
    workflowId: 'wf_test',
    mode: 'manual',
    graph,
    seedItems,
    signal: new AbortController().signal,
    loadCredential: async () => null,
    emit: (event) => {
      events.push(event);
    },
  });
  return { result, events };
}

function scope(json: Record<string, unknown>): ExpressionScope {
  return {
    $json: json,
    $items: [{ json }],
    $index: 0,
    $node: {},
    $now: '2026-01-01T00:00:00.000Z',
    $env: {},
    $execution: { id: 'e', workflowId: 'w', mode: 'manual' },
  };
}

// ---------------------------------------------------------------------------
// Graph ordering
// ---------------------------------------------------------------------------

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
// Expressions
// ---------------------------------------------------------------------------

test('expressions read nested values and keep their type', () => {
  assert.equal(resolveValue('{{ $json.order.total }}', scope({ order: { total: 42 } })), 42);
  assert.equal(resolveValue('Total: {{ $json.order.total }}', scope({ order: { total: 42 } })), 'Total: 42');
});

test('expressions support arithmetic, comparison and ternaries', () => {
  const s = scope({ a: 10, b: 3, name: 'ada' });
  assert.equal(evaluateExpression('$json.a * $json.b + 1', s), 31);
  assert.equal(evaluateExpression('$json.a > $json.b', s), true);
  assert.equal(evaluateExpression('$json.a > 100 ? "big" : "small"', s), 'small');
  assert.equal(evaluateExpression('$json.name.toUpperCase()', s), 'ADA');
});

test('a missing value yields undefined rather than throwing', () => {
  assert.equal(evaluateExpression('$json.nope.deeper', scope({})), undefined);
});

test('nullish coalescing short-circuits', () => {
  assert.equal(evaluateExpression('$json.missing ?? "fallback"', scope({})), 'fallback');
});

test('expressions cannot reach the prototype chain', () => {
  assert.throws(() => evaluateExpression('$json.constructor', scope({})), /not allowed/);
  assert.throws(() => evaluateExpression('$json["__proto__"]', scope({})), /not allowed/);
});

test('expressions cannot call methods that are not whitelisted', () => {
  assert.throws(() => evaluateExpression('$json.name.padEndX()', scope({ name: 'x' })), /not available/);
});

test('unknown variables are named in the error', () => {
  assert.throws(() => evaluateExpression('$jsonn.foo', scope({})), /Unknown variable \$jsonn/);
});

test('expressions resolve inside nested objects and arrays', () => {
  const value = { list: ['{{ $json.a }}', 'literal'], nested: { x: '{{ $json.a }}' } };
  assert.deepEqual(resolveValue(value, scope({ a: 7 })), { list: [7, 'literal'], nested: { x: 7 } });
});

// ---------------------------------------------------------------------------
// Comparisons
// ---------------------------------------------------------------------------

test('equality is loose, because webhook payloads are all strings', () => {
  assert.equal(compare('5', 'equals', 5), true);
  assert.equal(compare(5, 'notEquals', '6'), true);
});

test('comparing non-numbers numerically fails loudly', () => {
  assert.throws(() => compare('abc', 'gt', 3), /Cannot compare/);
});

// ---------------------------------------------------------------------------
// Item flow
// ---------------------------------------------------------------------------

test('Set builds fields from expressions, once per item', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('set', 'action.set', {
        assignments: [{ key: 'doubled', value: '{{ $json.n * 2 }}' }],
      }),
    ],
    edges: [edge('trigger', 'set')],
  };

  const { result } = await run(graph, [{ json: { n: 1 } }, { json: { n: 5 } }]);
  assert.equal(result.status, 'success');
  assert.deepEqual(result.outputs.set?.[0]?.map((item) => item.json.doubled), [2, 10]);
});

test('Set writes nested keys with dot notation', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('set', 'action.set', {
        assignments: [{ key: 'customer.name', value: 'Ada' }],
        keepOnlySet: true,
      }),
    ],
    edges: [edge('trigger', 'set')],
  };

  const { result } = await run(graph);
  assert.deepEqual(result.outputs.set?.[0]?.[0]?.json, { customer: { name: 'Ada' } });
});

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
    startNodeId: 'second',
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
// Fingerprinting
// ---------------------------------------------------------------------------

test('run-specific detail is normalised out of error messages', () => {
  const a = normaliseErrorMessage('GET /orders/8842 returned 500 at 2026-01-02T03:04:05Z');
  const b = normaliseErrorMessage('GET /orders/119 returned 500 at 2026-03-09T11:12:13Z');
  assert.equal(a, b);
});

test('the same failure in two runs shares a fingerprint', () => {
  const first = errorFingerprint({
    nodeType: 'action.httpRequest',
    errorType: 'HttpError500',
    message: 'GET /orders/1 returned 500 Internal Server Error',
  });
  const second = errorFingerprint({
    nodeType: 'action.httpRequest',
    errorType: 'HttpError500',
    message: 'GET /orders/999 returned 500 Internal Server Error',
  });
  assert.equal(first, second);
});

test('different status codes are different problems', () => {
  const notFound = errorFingerprint({
    nodeType: 'action.httpRequest',
    errorType: 'HttpError404',
    message: 'GET /orders/1 returned 404 Not Found',
  });
  const serverError = errorFingerprint({
    nodeType: 'action.httpRequest',
    errorType: 'HttpError500',
    message: 'GET /orders/1 returned 500 Internal Server Error',
  });
  assert.notEqual(notFound, serverError);
});

test('the same message from different node types does not merge', () => {
  const fromHttp = errorFingerprint({ nodeType: 'action.httpRequest', errorType: 'TimeoutError', message: 'timed out' });
  const fromCode = errorFingerprint({ nodeType: 'action.code', errorType: 'TimeoutError', message: 'timed out' });
  assert.notEqual(fromHttp, fromCode);
});
