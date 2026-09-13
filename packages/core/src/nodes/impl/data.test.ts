import assert from 'node:assert/strict';
import test from 'node:test';

import { edge, node, run } from '../../test-support.js';
import type { Graph } from '../../types.js';
import { parseCsv } from './csv.js';

test('a quoted field may hold the separator, a newline and a quote', () => {
  const rows = parseCsv('id,note\n1,"a, b\nc ""quoted"""\n', ',');
  assert.deepEqual(rows, [
    ['id', 'note'],
    ['1', 'a, b\nc "quoted"'],
  ]);
});

test('a file ending without a newline still has its last row', () => {
  assert.deepEqual(parseCsv('a,b\n1,2', ','), [
    ['a', 'b'],
    ['1', '2'],
  ]);
});

test('a trailing newline does not add an empty row', () => {
  assert.deepEqual(parseCsv('a,b\n1,2\n', ','), [
    ['a', 'b'],
    ['1', '2'],
  ]);
});

test('an empty field stays empty rather than disappearing', () => {
  assert.deepEqual(parseCsv('1,,3', ','), [['1', '', '3']]);
});

test('carriage returns from a Windows file are not part of the value', () => {
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n', ','), [
    ['a', 'b'],
    ['1', '2'],
  ]);
});

// ---------------------------------------------------------------------------
// Through a workflow
// ---------------------------------------------------------------------------

test('CSV survives a round trip through both nodes', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('csv', 'action.toCsv', { outputField: 'csv' }),
      node('back', 'action.parseCsv', { text: '{{ $json.csv }}' }),
    ],
    edges: [edge('trigger', 'csv'), edge('csv', 'back')],
  };

  const { result } = await run(graph, [
    { json: { id: '1', note: 'a, b' } },
    { json: { id: '2', note: 'say "hi"' } },
  ]);

  assert.equal(result.status, 'success');
  assert.deepEqual(
    result.outputs.back?.[0]?.map((item) => item.json),
    [
      { id: '1', note: 'a, b' },
      { id: '2', note: 'say "hi"' },
    ],
  );
});

test('Build CSV uses every field that appears, not only the first item\'s', async () => {
  const graph: Graph = {
    nodes: [node('trigger', 'trigger.manual'), node('csv', 'action.toCsv', {})],
    edges: [edge('trigger', 'csv')],
  };

  const { result } = await run(graph, [{ json: { a: 1 } }, { json: { a: 2, b: 3 } }]);
  assert.equal(result.outputs.csv?.[0]?.[0]?.json.csv, 'a,b\n1,\n2,3');
});

test('Extract from HTML reads text and attributes by selector', async () => {
  const html = '<h1 class="title">Hello</h1><a href="/one">1</a><a href="/two">2</a>';

  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('extract', 'action.extractHtml', {
        html: '{{ $json.body }}',
        take: 'text',
        extractions: [{ key: 'title', value: 'h1.title' }],
      }),
      node('links', 'action.extractHtml', {
        html: '{{ $json.body }}',
        take: 'attribute',
        attribute: 'href',
        all: true,
        extractions: [{ key: 'links', value: 'a' }],
      }),
    ],
    edges: [edge('trigger', 'extract'), edge('extract', 'links')],
  };

  const { result } = await run(graph, [{ json: { body: html } }]);
  assert.equal(result.status, 'success');
  assert.equal(result.outputs.links?.[0]?.[0]?.json.title, 'Hello');
  assert.deepEqual(result.outputs.links?.[0]?.[0]?.json.links, ['/one', '/two']);
});

test('a selector that matches nothing gives an empty field rather than a missing one', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('extract', 'action.extractHtml', {
        html: '<p>nothing here</p>',
        take: 'text',
        extractions: [{ key: 'title', value: 'h1' }],
      }),
    ],
    edges: [edge('trigger', 'extract')],
  };

  const { result } = await run(graph);
  assert.equal(result.outputs.extract?.[0]?.[0]?.json.title, null);
});

test('Parse XML keeps attributes apart from child elements', async () => {
  const graph: Graph = {
    nodes: [
      node('trigger', 'trigger.manual'),
      node('xml', 'action.xmlToJson', { xml: '<order id="7"><total>42</total></order>' }),
    ],
    edges: [edge('trigger', 'xml')],
  };

  const { result } = await run(graph);
  assert.deepEqual(result.outputs.xml?.[0]?.[0]?.json, { order: { '@id': 7, total: 42 } });
});

test('Parse XML names what was wrong with the document', async () => {
  const graph: Graph = {
    nodes: [node('trigger', 'trigger.manual'), node('xml', 'action.xmlToJson', { xml: '<order><total></order>' })],
    edges: [edge('trigger', 'xml')],
  };

  const { result } = await run(graph);
  assert.equal(result.status, 'failed');
  assert.equal(result.failure?.errorType, 'DataError');
});
