import type { NodeDescriptor, ParamSchema } from '../types.js';

/**
 * What every node looks like, with nothing about how it runs.
 *
 * The editor imports this file and nothing else from the node layer. That is
 * the boundary that keeps `node:child_process` and the HTTP client out of the
 * browser bundle, and it is why the inspector panel can be generated entirely
 * from data.
 */

// ---------------------------------------------------------------------------
// Shared parameter blocks
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

export const manualTrigger: NodeDescriptor = {
  type: 'trigger.manual',
  displayName: 'Manual Trigger',
  description: 'Starts the workflow when you click Run.',
  group: 'trigger',
  icon: 'MousePointerClick',
  color: '#64748b',
  inputs: 0,
  outputs: [''],
  params: [],
};

export const webhookTrigger: NodeDescriptor = {
  type: 'trigger.webhook',
  displayName: 'Webhook',
  description: 'Starts the workflow when an HTTP request arrives.',
  group: 'trigger',
  icon: 'Webhook',
  color: '#0ea5e9',
  inputs: 0,
  outputs: [''],
  params: [
    {
      name: 'path',
      displayName: 'Path',
      type: 'string',
      required: true,
      placeholder: 'orders-created',
      description: 'The URL segment after /api/webhooks/. Letters, digits, dashes. Must be unique.',
      expression: false,
    },
    {
      name: 'method',
      displayName: 'Method',
      type: 'select',
      default: 'POST',
      options: ['POST', 'GET', 'PUT', 'PATCH', 'DELETE', 'ANY'].map((method) => ({
        label: method === 'ANY' ? 'Any' : method,
        value: method,
      })),
      expression: false,
    },
    {
      name: 'respond',
      displayName: 'Respond',
      type: 'select',
      default: 'immediately',
      description:
        'Immediately returns 202 and runs in the background. Waiting holds the request open until the workflow finishes.',
      options: [
        { label: 'Immediately', value: 'immediately' },
        { label: 'When the workflow finishes', value: 'whenFinished' },
      ],
      expression: false,
    },
  ],
};

export const scheduleTrigger: NodeDescriptor = {
  type: 'trigger.schedule',
  displayName: 'Schedule',
  description: 'Starts the workflow on a timer.',
  group: 'trigger',
  icon: 'Clock',
  color: '#8b5cf6',
  inputs: 0,
  outputs: [''],
  params: [
    {
      name: 'mode',
      displayName: 'Mode',
      type: 'select',
      default: 'interval',
      options: [
        { label: 'Every N minutes', value: 'interval' },
        { label: 'Cron expression', value: 'cron' },
      ],
      expression: false,
    },
    {
      name: 'intervalMinutes',
      displayName: 'Interval (minutes)',
      type: 'number',
      default: 15,
      showIf: { mode: ['interval'] },
      expression: false,
    },
    {
      name: 'cron',
      displayName: 'Cron',
      type: 'string',
      default: '0 * * * *',
      placeholder: '0 9 * * 1-5',
      description: 'Standard five-field cron, evaluated in the timezone below.',
      showIf: { mode: ['cron'] },
      expression: false,
    },
    {
      name: 'timezone',
      displayName: 'Timezone',
      type: 'string',
      default: 'UTC',
      placeholder: 'Europe/Berlin',
      showIf: { mode: ['cron'] },
      expression: false,
    },
  ],
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const httpRequest: NodeDescriptor = {
  type: 'action.httpRequest',
  displayName: 'HTTP Request',
  description: 'Calls an HTTP endpoint once per incoming item.',
  group: 'action',
  icon: 'Globe',
  color: '#10b981',
  inputs: 1,
  outputs: [''],
  defaultRetries: 2,
  params: [
    {
      name: 'method',
      displayName: 'Method',
      type: 'select',
      default: 'GET',
      options: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].map((m) => ({ label: m, value: m })),
      expression: false,
    },
    {
      name: 'url',
      displayName: 'URL',
      type: 'string',
      required: true,
      placeholder: 'https://api.example.com/orders/{{ $json.id }}',
    },
    {
      name: 'credential',
      displayName: 'Credential',
      type: 'select',
      credentialType: 'httpAuth',
      description: 'Optional. Adds an auth header without putting the secret in the graph.',
      expression: false,
    },
    { name: 'headers', displayName: 'Headers', type: 'keyValue', default: [] },
    { name: 'query', displayName: 'Query parameters', type: 'keyValue', default: [] },
    {
      name: 'bodyType',
      displayName: 'Body',
      type: 'select',
      default: 'none',
      showIf: { method: HTTP_METHODS_WITH_BODY },
      options: [
        { label: 'None', value: 'none' },
        { label: 'JSON', value: 'json' },
        { label: 'Form data', value: 'form' },
        { label: 'Raw text', value: 'raw' },
      ],
      expression: false,
    },
    {
      name: 'body',
      displayName: 'Body content',
      type: 'json',
      default: '{}',
      showIf: { bodyType: ['json', 'raw'] },
    },
    { name: 'formBody', displayName: 'Form fields', type: 'keyValue', default: [], showIf: { bodyType: ['form'] } },
    { name: 'timeoutMs', displayName: 'Timeout (ms)', type: 'number', default: 30000, expression: false },
    {
      name: 'failOnErrorStatus',
      displayName: 'Fail on 4xx / 5xx',
      type: 'boolean',
      default: true,
      description: 'Turn this off to handle the status code yourself downstream.',
      expression: false,
    },
    {
      name: 'responseType',
      displayName: 'Response',
      type: 'select',
      default: 'auto',
      options: [
        { label: 'Detect from content type', value: 'auto' },
        { label: 'JSON', value: 'json' },
        { label: 'Text', value: 'text' },
      ],
      expression: false,
    },
  ],
};

export const DEFAULT_CODE = `// Runs once with every item on the input.
// Return an array of items, or an array of plain objects.

return $items.map((item) => ({
  json: {
    ...item.json,
  },
}));
`;

export const code: NodeDescriptor = {
  type: 'action.code',
  displayName: 'Code',
  description: 'Runs JavaScript in an isolated process. The escape hatch for anything the other nodes cannot do.',
  group: 'action',
  icon: 'Code2',
  color: '#f59e0b',
  inputs: 1,
  outputs: [''],
  params: [
    {
      name: 'mode',
      displayName: 'Mode',
      type: 'select',
      default: 'allItems',
      options: [
        { label: 'Run once for all items', value: 'allItems' },
        { label: 'Run once for each item', value: 'eachItem' },
      ],
      expression: false,
    },
    {
      name: 'code',
      displayName: 'JavaScript',
      type: 'code',
      default: DEFAULT_CODE,
      // The script is handed to the sandbox verbatim. Resolving `{{ }}` inside
      // it would mangle template literals and object braces.
      expression: false,
    },
    { name: 'timeoutMs', displayName: 'Timeout (ms)', type: 'number', default: 15000, expression: false },
  ],
};

export const setNode: NodeDescriptor = {
  type: 'action.set',
  displayName: 'Set',
  description: 'Adds, overwrites or renames fields on each item.',
  group: 'action',
  icon: 'PenLine',
  color: '#ec4899',
  inputs: 1,
  outputs: [''],
  params: [
    {
      name: 'assignments',
      displayName: 'Fields',
      type: 'keyValue',
      default: [],
      description: 'Values support expressions, and dotted keys write nested fields.',
    },
    {
      name: 'keepOnlySet',
      displayName: 'Keep only these fields',
      type: 'boolean',
      default: false,
      description: 'Drops everything that arrived on the input.',
      expression: false,
    },
  ],
};

// ---------------------------------------------------------------------------
// Flow
// ---------------------------------------------------------------------------

export const ifNode: NodeDescriptor = {
  type: 'flow.if',
  displayName: 'If',
  description: 'Sends each item down one of two branches.',
  group: 'flow',
  icon: 'GitBranch',
  color: '#6366f1',
  inputs: 1,
  outputs: ['true', 'false'],
  params: conditionParams,
};

export const filterNode: NodeDescriptor = {
  type: 'flow.filter',
  displayName: 'Filter',
  description: 'Drops items that do not match. Like If, but without the second branch.',
  group: 'flow',
  icon: 'Filter',
  color: '#6366f1',
  inputs: 1,
  outputs: [''],
  params: conditionParams,
};

export const mergeNode: NodeDescriptor = {
  type: 'flow.merge',
  displayName: 'Merge',
  description: 'Brings two branches back together.',
  group: 'flow',
  icon: 'GitMerge',
  color: '#6366f1',
  inputs: 2,
  outputs: [''],
  params: [
    {
      name: 'mode',
      displayName: 'Mode',
      type: 'select',
      default: 'append',
      options: [
        { label: 'Append: input 2 after input 1', value: 'append' },
        { label: 'Combine by position', value: 'position' },
        { label: 'Combine by matching field', value: 'key' },
      ],
      expression: false,
    },
    {
      name: 'leftKey',
      displayName: 'Field in input 1',
      type: 'string',
      placeholder: 'id',
      showIf: { mode: ['key'] },
      expression: false,
    },
    {
      name: 'rightKey',
      displayName: 'Field in input 2',
      type: 'string',
      placeholder: 'orderId',
      showIf: { mode: ['key'] },
      expression: false,
    },
    {
      name: 'keepUnmatched',
      displayName: 'Keep items with no match',
      type: 'boolean',
      default: false,
      showIf: { mode: ['key'] },
      expression: false,
    },
  ],
};

export const splitOutNode: NodeDescriptor = {
  type: 'flow.splitOut',
  displayName: 'Split Out',
  description: 'Turns an array inside one item into many items.',
  group: 'flow',
  icon: 'Split',
  color: '#6366f1',
  inputs: 1,
  outputs: [''],
  params: [
    {
      name: 'field',
      displayName: 'Field holding the array',
      type: 'string',
      required: true,
      placeholder: 'body.results',
      description: 'Dot notation is supported, e.g. body.data.items.',
      expression: false,
    },
    {
      name: 'keepParent',
      displayName: 'Keep the parent fields',
      type: 'boolean',
      default: false,
      description: 'Merges the original item around each extracted entry.',
      expression: false,
    },
  ],
};

export const NODE_DESCRIPTORS: NodeDescriptor[] = [
  manualTrigger,
  webhookTrigger,
  scheduleTrigger,
  httpRequest,
  code,
  setNode,
  ifNode,
  filterNode,
  mergeNode,
  splitOutNode,
];
