import assert from 'node:assert/strict';
import test from 'node:test';

import { edge, node, run } from '../../test-support.js';
import type { Graph } from '../../types.js';

/** The nodes that reshape a list of items rather than route it. */

test('Limit keeps the end of the list when asked to', async () => {
  const graph: Graph = {
    nodes: [node('trigger', 'trigger.manual'), node('limit', 'flow.limit', { maxItems: 2, keep: 'last' })],
    edges: [edge('trigger', 'limit')],
  };

  const { result } = await run(graph, [{ json: { n: 1 } }, { json: { n: 2 } }, { json: { n: 3 } }]);
  assert.deepEqual(result.outputs.limit?.[0]?.map((item) => item.json.n), [2, 3]);
});

test('Sort orders by several fields, the first breaking ties last', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('sort', 'flow.sort', {
        mode: 'fields',
        fields: [{ key: 'group', value: 'asc' }, { key: 'score', value: 'desc' }],
      }),
    ],
    edges: [edge('trigger', 'sort')],
  };

  const { result } = await run(graph, [
    { json: { group: 'b', score: 1 } },
    { json: { group: 'a', score: 1 } },
    { json: { group: 'a', score: 9 } },
  ]);

  assert.deepEqual(
    result.outputs.sort?.[0]?.map((item) => `${item.json.group}${item.json.score}`),
    ['a9', 'a1', 'b1'],
  );
});

test('Sort compares numbers as numbers, not as text', async () => {
  const graph: Graph = {
    nodes: [node('trigger', 'trigger.manual'), node('sort', 'flow.sort', { mode: 'fields', fields: [{ key: 'n', value: 'asc' }] })],
    edges: [edge('trigger', 'sort')],
  };

  const { result } = await run(graph, [{ json: { n: 10 } }, { json: { n: 9 } }, { json: { n: 100 } }]);
  assert.deepEqual(result.outputs.sort?.[0]?.map((item) => item.json.n), [9, 10, 100]);
});

test('Remove Duplicates ignores the order the fields were written in', async () => {
  const graph: Graph = {
    nodes: [node('trigger', 'trigger.manual'), node('dedupe', 'flow.removeDuplicates', {})],
    edges: [edge('trigger', 'dedupe')],
  };

  const { result } = await run(graph, [{ json: { a: 1, b: 2 } }, { json: { b: 2, a: 1 } }]);
  assert.equal(result.outputs.dedupe?.[0]?.length, 1);
});

test('Remove Duplicates can compare named fields only', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('dedupe', 'flow.removeDuplicates', { mode: 'fields', fields: 'email' }),
    ],
    edges: [edge('trigger', 'dedupe')],
  };

  const { result } = await run(graph, [
    { json: { email: 'a@example.com', seen: 1 } },
    { json: { email: 'a@example.com', seen: 2 } },
    { json: { email: 'b@example.com', seen: 3 } },
  ]);
  assert.equal(result.outputs.dedupe?.[0]?.length, 2);
  // The first occurrence is the one that survives.
  assert.equal(result.outputs.dedupe?.[0]?.[0]?.json.seen, 1);
});

test('Aggregate collects one field from every item into a single item', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('aggregate', 'flow.aggregate', { mode: 'field', field: 'email', outputField: 'emails' }),
    ],
    edges: [edge('trigger', 'aggregate')],
  };

  const { result } = await run(graph, [{ json: { email: 'a' } }, { json: { email: 'b' } }]);
  assert.equal(result.outputs.aggregate?.[0]?.length, 1);
  assert.deepEqual(result.outputs.aggregate?.[0]?.[0]?.json.emails, ['a', 'b']);
});

test('Summarize groups items and works out the numbers', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('summarize', 'flow.summarize', {
        groupBy: 'country',
        aggregations: [{ key: 'total', value: 'sum' }, { key: 'total', value: 'max' }],
      }),
    ],
    edges: [edge('trigger', 'summarize')],
  };

  const { result } = await run(graph, [
    { json: { country: 'DE', total: 10 } },
    { json: { country: 'DE', total: 5 } },
    { json: { country: 'AT', total: 3 } },
  ]);

  const rows = result.outputs.summarize?.[0] ?? [];
  assert.equal(rows.length, 2);
  // Groups come out in the order they were first seen, not sorted.
  assert.deepEqual(rows[0]?.json, { country: 'DE', count: 2, sum_total: 15, max_total: 10 });
  assert.deepEqual(rows[1]?.json, { country: 'AT', count: 1, sum_total: 3, max_total: 3 });
});

test('Summarize leaves out values that are not numbers rather than poisoning the total', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('summarize', 'flow.summarize', { aggregations: [{ key: 'total', value: 'sum' }] }),
    ],
    edges: [edge('trigger', 'summarize')],
  };

  const { result } = await run(graph, [{ json: { total: 10 } }, { json: { total: '' } }, { json: {} }]);
  assert.equal(result.outputs.summarize?.[0]?.[0]?.json.sum_total, 10);
});

test('Summarize names an operation it does not know', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('summarize', 'flow.summarize', { aggregations: [{ key: 'total', value: 'median' }] }),
    ],
    edges: [edge('trigger', 'summarize')],
  };

  const { result } = await run(graph);
  assert.equal(result.status, 'failed');
  assert.match(result.failure!.message, /"median" is not something Summarize can work out/);
});

test('Summarize handles more items than a spread would survive', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('summarize', 'flow.summarize', {
        aggregations: [{ key: 'n', value: 'min' }, { key: 'n', value: 'max' }],
      }),
    ],
    edges: [edge('trigger', 'summarize')],
  };

  // Past the engine's argument limit, which is what `Math.min(...numbers)`
  // would have hit. A full table export is not an unusual thing to summarise.
  const items = Array.from({ length: 200_000 }, (_, index) => ({ json: { n: index } }));

  const { result } = await run(graph, items);

  assert.equal(result.status, 'success');
  assert.equal(result.outputs.summarize?.[0]?.[0]?.json.min_n, 0);
  assert.equal(result.outputs.summarize?.[0]?.[0]?.json.max_n, 199_999);
});
