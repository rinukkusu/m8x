import assert from 'node:assert/strict';
import test from 'node:test';

import { edge, node, run } from '../../test-support.js';
import type { Graph } from '../../types.js';

/** Set: building fields, including the ones it refuses to build. */

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

test('Set refuses a key that would write to the prototype', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('set', 'action.set', { assignments: [{ key: '__proto__.polluted', value: 'yes' }] }),
    ],
    edges: [edge('trigger', 'set')],
  };

  const { result } = await run(graph);
  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.errorType, 'ConfigurationError');
  // The real damage would be here rather than in the item: writing that path
  // lands on Object.prototype and changes every other execution in the worker.
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});
