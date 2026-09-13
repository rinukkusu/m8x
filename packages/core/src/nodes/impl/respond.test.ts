import assert from 'node:assert/strict';
import test from 'node:test';

import { edge, node, run } from '../../test-support.js';
import type { Graph } from '../../types.js';

/** Respond to Webhook, whose output is the HTTP response. */

test('Respond to Webhook writes the response as its output', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('respond', 'action.respondToWebhook', {
        status: 201,
        contentType: 'application/json',
        body: '{{ $json }}',
        headers: [{ key: 'X-Order', value: '{{ $json.id }}' }],
      }),
    ],
    edges: [edge('trigger', 'respond')],
  };

  const { result } = await run(graph, [{ json: { id: 7 } }]);
  assert.deepEqual(result.outputs.respond?.[0]?.[0]?.json, {
    status: 201,
    contentType: 'application/json',
    // Header names are lower-cased, because that is how they arrive back.
    headers: { 'x-order': '7' },
    body: { id: 7 },
  });
});

test('a status code outside the range HTTP allows falls back to 200', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('respond', 'action.respondToWebhook', { status: 99, body: 'ok' }),
    ],
    edges: [edge('trigger', 'respond')],
  };

  const { result } = await run(graph);
  assert.equal(result.outputs.respond?.[0]?.[0]?.json.status, 200);
});
