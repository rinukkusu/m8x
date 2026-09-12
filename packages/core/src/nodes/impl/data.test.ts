import assert from 'node:assert/strict';
import test from 'node:test';

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
