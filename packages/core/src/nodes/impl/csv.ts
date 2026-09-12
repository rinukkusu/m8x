import { NodeError, type Item, type NodeExecute } from '../../types.js';
import { readPath } from '../paths.js';

/**
 * CSV in and out, hand-rolled.
 *
 * A parser is a few dozen lines and a dependency is forever, and the format's
 * awkward parts — quotes inside quotes, separators and newlines inside a quoted
 * field — are exactly what a split(',') gets wrong.
 */

export const executeParseCsv: NodeExecute = async (ctx) => {
  const out: Item[] = [];

  for (let i = 0; i < ctx.items.length; i++) {
    const text = ctx.getParam<string>('text', i);
    if (typeof text !== 'string') {
      throw new NodeError('DataError', 'There is no CSV text to parse here.');
    }

    const delimiter = separator(ctx.getParam<string>('delimiter'));
    const rows = parseCsv(text, delimiter);
    if (rows.length === 0) continue;

    const useHeader = ctx.getParam<boolean>('header') !== false;
    const names = useHeader
      ? rows[0]!.map((name, column) => (name.trim() === '' ? `column${column + 1}` : name.trim()))
      : rows[0]!.map((_, column) => `column${column + 1}`);

    for (const row of useHeader ? rows.slice(1) : rows) {
      const json: Record<string, unknown> = {};
      for (let column = 0; column < names.length; column++) json[names[column]!] = row[column] ?? '';
      out.push({ json });
    }
  }

  return [out];
};

export const executeToCsv: NodeExecute = async (ctx) => {
  const delimiter = separator(ctx.getParam<string>('delimiter'));
  const outputField = (ctx.getParam<string>('outputField') || 'csv').trim();

  const named = (ctx.getParam<string>('fields') ?? '')
    .split(',')
    .map((field) => field.trim())
    .filter((field) => field !== '');

  // Every field that appears anywhere, in the order it first showed up, so a
  // row missing an optional field does not shift every column after it.
  const columns = named.length > 0 ? named : [...new Set(ctx.items.flatMap((item) => Object.keys(item.json)))];

  const lines: string[] = [];
  if (ctx.getParam<boolean>('header') !== false) {
    lines.push(columns.map((column) => quote(column, delimiter)).join(delimiter));
  }

  for (const item of ctx.items) {
    lines.push(columns.map((column) => quote(cell(readPath(item.json, column)), delimiter)).join(delimiter));
  }

  return [[{ json: { [outputField]: lines.join('\n') } }]];
};

/** A tab written as \t in a text field is the common case worth handling. */
function separator(value: unknown): string {
  if (typeof value !== 'string' || value === '') return ',';
  if (value === '\\t') return '\t';
  return value[0]!;
}

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

function quote(value: string, delimiter: string): string {
  if (!value.includes(delimiter) && !value.includes('"') && !value.includes('\n') && !value.includes('\r')) {
    return value;
  }
  return `"${value.replaceAll('"', '""')}"`;
}

/** Rows of raw cells. Quoted fields may hold the separator and newlines. */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false;

  const endField = () => {
    row.push(field);
    field = '';
    started = true;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
    started = false;
  };

  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;

    if (quoted) {
      if (char !== '"') {
        field += char;
        continue;
      }
      // A doubled quote inside a quoted field is one literal quote.
      if (text[i + 1] === '"') {
        field += '"';
        i++;
        continue;
      }
      quoted = false;
      continue;
    }

    if (char === '"' && field === '') {
      quoted = true;
      started = true;
      continue;
    }
    if (char === delimiter) {
      endField();
      continue;
    }
    if (char === '\r') continue;
    if (char === '\n') {
      endRow();
      continue;
    }

    field += char;
    started = true;
  }

  // A file ending without a newline still has a last row; one ending with a
  // newline does not have an extra empty one.
  if (started || field !== '' || row.length > 0) endRow();

  return rows;
}
