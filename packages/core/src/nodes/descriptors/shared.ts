import type { ParamSchema } from '../../types.js';

/**
 * Parameter blocks and option lists that more than one descriptor uses.
 *
 * The condition rows are the reason this file exists: If, Filter and Switch all
 * ask the same question, and three hand-written copies of the same eight fields
 * would drift apart the first time an operator was added.
 */

export const COMPARISON_OPERATORS = [
  { label: 'is equal to', value: 'equals' },
  { label: 'is not equal to', value: 'notEquals' },
  { label: 'contains', value: 'contains' },
  { label: 'does not contain', value: 'notContains' },
  { label: 'starts with', value: 'startsWith' },
  { label: 'ends with', value: 'endsWith' },
  { label: 'matches regex', value: 'regex' },
  { label: 'is greater than', value: 'gt' },
  { label: 'is greater than or equal to', value: 'gte' },
  { label: 'is less than', value: 'lt' },
  { label: 'is less than or equal to', value: 'lte' },
  { label: 'is empty', value: 'isEmpty' },
  { label: 'is not empty', value: 'isNotEmpty' },
  { label: 'is true', value: 'isTrue' },
  { label: 'is false', value: 'isFalse' },
] as const;

/**
 * The parameter block for every node that asks a yes/no question.
 *
 * Two modes on purpose. The comparison builder covers what most people need
 * without knowing the expression language; the expression mode is there so the
 * builder never becomes a ceiling.
 */
export const conditionParams: ParamSchema[] = [
  {
    name: 'conditionMode',
    displayName: 'Condition',
    type: 'select',
    default: 'comparison',
    options: [
      { label: 'Build a comparison', value: 'comparison' },
      { label: 'Write an expression', value: 'expression' },
    ],
    expression: false,
  },
  {
    name: 'left',
    displayName: 'Value',
    type: 'string',
    placeholder: '{{ $json.status }}',
    showIf: { conditionMode: ['comparison'] },
  },
  {
    name: 'operator',
    displayName: 'Operator',
    type: 'select',
    default: 'equals',
    options: COMPARISON_OPERATORS.map((entry) => ({ label: entry.label, value: entry.value })),
    showIf: { conditionMode: ['comparison'] },
    expression: false,
  },
  {
    name: 'right',
    displayName: 'Compare to',
    type: 'string',
    placeholder: 'shipped',
    showIf: { conditionMode: ['comparison'] },
  },
  {
    name: 'expression',
    displayName: 'Expression',
    type: 'string',
    placeholder: '{{ $json.total > 100 && $json.currency === "EUR" }}',
    description: 'The item passes when this resolves to something truthy.',
    showIf: { conditionMode: ['expression'] },
  },
];

export const HTTP_METHODS_WITH_BODY = ['POST', 'PUT', 'PATCH', 'DELETE'];
