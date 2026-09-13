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
        'Immediately returns 202 and runs in the background. The other two hold the request open until the workflow finishes.',
      options: [
        { label: 'Immediately', value: 'immediately' },
        { label: 'When the workflow finishes', value: 'whenFinished' },
        { label: 'With a Respond to Webhook node', value: 'usingRespondNode' },
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

/** The indigo every flow node shares, so the group reads as one block. */
const FLOW_COLOR = '#6366f1';

export const switchNode: NodeDescriptor = {
  type: 'flow.switch',
  displayName: 'Switch',
  description: 'Routes each item down one of several branches.',
  group: 'flow',
  icon: 'Route',
  color: FLOW_COLOR,
  inputs: 1,
  // Until it has rules there is one branch, so a freshly dropped node can still
  // be wired up. `outputsFrom` takes over the moment the first rule is written.
  outputs: [''],
  outputsFrom: 'rules',
  params: [
    {
      name: 'rules',
      displayName: 'Branches',
      type: 'keyValue',
      default: [{ key: '', value: '' }],
      keyPlaceholder: 'branch name',
      valuePlaceholder: '{{ $json.status === "paid" }}',
      description: 'One branch per row. The item takes the branch whose expression is true.',
    },
    {
      name: 'allMatches',
      displayName: 'Send to every matching branch',
      type: 'boolean',
      default: false,
      description: 'Off means the first match wins, which is what a Switch usually means.',
      expression: false,
    },
    {
      name: 'fallback',
      displayName: 'Add a branch for everything else',
      type: 'boolean',
      default: false,
      description: 'Without it, an item matching no rule is dropped.',
      expression: false,
    },
  ],
};

export const loopOverItemsNode: NodeDescriptor = {
  type: 'flow.loopOverItems',
  displayName: 'Loop Over Items',
  description: 'Runs the Loop branch once per batch, then carries on from Done with everything the branch produced.',
  group: 'flow',
  icon: 'Repeat',
  color: FLOW_COLOR,
  inputs: 1,
  outputs: ['loop', 'done'],
  params: [
    {
      name: 'batchSize',
      displayName: 'Items per batch',
      type: 'number',
      default: 1,
      required: true,
      description: 'How many items the Loop branch sees at a time.',
      expression: false,
    },
  ],
};

export const waitNode: NodeDescriptor = {
  type: 'flow.wait',
  displayName: 'Wait',
  description: 'Pauses before carrying on. The run stays in flight, so this is for seconds and minutes, not hours.',
  group: 'flow',
  icon: 'Timer',
  color: FLOW_COLOR,
  inputs: 1,
  outputs: [''],
  params: [
    { name: 'amount', displayName: 'Wait for', type: 'number', default: 5, required: true },
    {
      name: 'unit',
      displayName: 'Unit',
      type: 'select',
      default: 'seconds',
      options: [
        { label: 'Seconds', value: 'seconds' },
        { label: 'Minutes', value: 'minutes' },
      ],
      expression: false,
    },
  ],
};

export const noOpNode: NodeDescriptor = {
  type: 'flow.noOp',
  displayName: 'No Operation',
  description: 'Passes its input straight through. Useful for tidying up a join, or standing in for a node you have not written yet.',
  group: 'flow',
  icon: 'CircleSlash',
  color: FLOW_COLOR,
  inputs: 1,
  outputs: [''],
  params: [],
};

export const stopAndErrorNode: NodeDescriptor = {
  type: 'flow.stopAndError',
  displayName: 'Stop and Error',
  description: 'Fails the run on purpose, so a guard clause does not need a Code node.',
  group: 'flow',
  icon: 'OctagonAlert',
  color: '#ef4444',
  inputs: 1,
  // Nothing follows a deliberate failure.
  outputs: [],
  params: [
    {
      name: 'message',
      displayName: 'Message',
      type: 'text',
      required: true,
      placeholder: 'Order {{ $json.id }} has no shipping address',
      description: 'What the failures page will show.',
    },
  ],
};

export const limitNode: NodeDescriptor = {
  type: 'flow.limit',
  displayName: 'Limit',
  description: 'Keeps only the first or last few items.',
  group: 'flow',
  icon: 'List',
  color: FLOW_COLOR,
  inputs: 1,
  outputs: [''],
  params: [
    { name: 'maxItems', displayName: 'Keep', type: 'number', default: 10, required: true },
    {
      name: 'keep',
      displayName: 'From',
      type: 'select',
      default: 'first',
      options: [
        { label: 'The start', value: 'first' },
        { label: 'The end', value: 'last' },
      ],
      expression: false,
    },
  ],
};

export const sortNode: NodeDescriptor = {
  type: 'flow.sort',
  displayName: 'Sort',
  description: 'Reorders items by one or more fields.',
  group: 'flow',
  icon: 'ArrowDownNarrowWide',
  color: FLOW_COLOR,
  inputs: 1,
  outputs: [''],
  params: [
    {
      name: 'mode',
      displayName: 'Order',
      type: 'select',
      default: 'fields',
      options: [
        { label: 'By field', value: 'fields' },
        { label: 'Shuffle', value: 'random' },
      ],
      expression: false,
    },
    {
      name: 'fields',
      displayName: 'Sort by',
      type: 'keyValue',
      default: [{ key: '', value: 'asc' }],
      keyPlaceholder: 'field',
      valuePlaceholder: 'asc or desc',
      description: 'Applied in order, so the first row is the primary sort. Dot notation is supported.',
      showIf: { mode: ['fields'] },
      expression: false,
    },
  ],
};

export const removeDuplicatesNode: NodeDescriptor = {
  type: 'flow.removeDuplicates',
  displayName: 'Remove Duplicates',
  description: 'Keeps the first item of each kind and drops the rest.',
  group: 'flow',
  icon: 'CopyX',
  color: FLOW_COLOR,
  inputs: 1,
  outputs: [''],
  params: [
    {
      name: 'mode',
      displayName: 'Compare',
      type: 'select',
      default: 'allFields',
      options: [
        { label: 'The whole item', value: 'allFields' },
        { label: 'Selected fields', value: 'fields' },
        { label: 'An expression', value: 'expression' },
      ],
      expression: false,
    },
    {
      name: 'fields',
      displayName: 'Fields',
      type: 'string',
      required: true,
      placeholder: 'email, orderId',
      description: 'Comma separated. Dot notation is supported.',
      showIf: { mode: ['fields'] },
      expression: false,
    },
    {
      name: 'key',
      displayName: 'Key',
      type: 'string',
      required: true,
      placeholder: '{{ $json.email.toLowerCase() }}',
      description: 'Two items with the same result are duplicates.',
      showIf: { mode: ['expression'] },
    },
  ],
};

export const aggregateNode: NodeDescriptor = {
  type: 'flow.aggregate',
  displayName: 'Aggregate',
  description: 'Folds every item into one, the opposite of Split Out.',
  group: 'flow',
  icon: 'Layers',
  color: FLOW_COLOR,
  inputs: 1,
  outputs: [''],
  params: [
    {
      name: 'mode',
      displayName: 'Collect',
      type: 'select',
      default: 'field',
      options: [
        { label: 'One field into a list', value: 'field' },
        { label: 'Every item into a list', value: 'allItems' },
      ],
      expression: false,
    },
    {
      name: 'field',
      displayName: 'Field',
      type: 'string',
      required: true,
      placeholder: 'email',
      showIf: { mode: ['field'] },
      expression: false,
    },
    {
      name: 'outputField',
      displayName: 'Put it in',
      type: 'string',
      default: 'data',
      description: 'The field on the single item that comes out.',
      expression: false,
    },
  ],
};

export const summarizeNode: NodeDescriptor = {
  type: 'flow.summarize',
  displayName: 'Summarize',
  description: 'Groups items and counts, sums or averages them. A pivot table in one node.',
  group: 'flow',
  icon: 'Sigma',
  color: FLOW_COLOR,
  inputs: 1,
  outputs: [''],
  params: [
    {
      name: 'groupBy',
      displayName: 'Group by',
      type: 'string',
      placeholder: 'country, status',
      description: 'Comma separated. Leave empty to summarise everything as one group.',
      expression: false,
    },
    {
      name: 'aggregations',
      displayName: 'Work out',
      type: 'keyValue',
      default: [],
      keyPlaceholder: 'field',
      valuePlaceholder: 'sum, avg, min, max, count or concat',
      description: 'Each row adds a field named after the operation, e.g. sum_total. Every group is counted anyway.',
      expression: false,
    },
  ],
};

export const respondToWebhookNode: NodeDescriptor = {
  type: 'action.respondToWebhook',
  displayName: 'Respond to Webhook',
  description: 'Decides what the caller gets back. Put it last, and set the trigger to respond with a node.',
  group: 'action',
  icon: 'Reply',
  color: '#22c55e',
  inputs: 1,
  // What comes out is the response itself, which is why this belongs at the end
  // of its branch rather than in the middle of one.
  outputs: [''],
  params: [
    {
      name: 'body',
      displayName: 'Body',
      type: 'text',
      placeholder: '{{ $json }}',
      description: 'Sent as it is. A JSON content type is written out as JSON.',
    },
    {
      name: 'contentType',
      displayName: 'Send as',
      type: 'select',
      default: 'application/json',
      options: [
        { label: 'JSON', value: 'application/json' },
        { label: 'Plain text', value: 'text/plain' },
        { label: 'HTML', value: 'text/html' },
        { label: 'XML', value: 'application/xml' },
      ],
      expression: false,
    },
    { name: 'status', displayName: 'Status code', type: 'number', default: 200, expression: false },
    {
      name: 'headers',
      displayName: 'Extra headers',
      type: 'keyValue',
      default: [],
      keyPlaceholder: 'header',
      valuePlaceholder: 'value',
    },
  ],
};

/** The slate the data-shaping nodes share. */
const DATA_COLOR = '#0ea5e9';

export const parseCsvNode: NodeDescriptor = {
  type: 'action.parseCsv',
  displayName: 'Parse CSV',
  description: 'Turns CSV text into one item per row.',
  group: 'action',
  icon: 'Table',
  color: DATA_COLOR,
  inputs: 1,
  outputs: [''],
  params: [
    {
      name: 'text',
      displayName: 'CSV',
      type: 'text',
      required: true,
      placeholder: '{{ $json.body }}',
    },
    {
      name: 'delimiter',
      displayName: 'Separator',
      type: 'string',
      default: ',',
      description: 'Use \\t for a tab.',
      expression: false,
    },
    {
      name: 'header',
      displayName: 'The first row holds the column names',
      type: 'boolean',
      default: true,
      description: 'Off names the fields column1, column2, and so on.',
      expression: false,
    },
  ],
};

export const toCsvNode: NodeDescriptor = {
  type: 'action.toCsv',
  displayName: 'Build CSV',
  description: 'Turns every item into one row of CSV text, in a single item.',
  group: 'action',
  icon: 'FileSpreadsheet',
  color: DATA_COLOR,
  inputs: 1,
  outputs: [''],
  params: [
    {
      name: 'fields',
      displayName: 'Columns',
      type: 'string',
      placeholder: 'id, email, total',
      description: 'Comma separated. Leave empty to use every field that appears.',
      expression: false,
    },
    { name: 'delimiter', displayName: 'Separator', type: 'string', default: ',', expression: false },
    {
      name: 'header',
      displayName: 'Write a header row',
      type: 'boolean',
      default: true,
      expression: false,
    },
    {
      name: 'outputField',
      displayName: 'Put it in',
      type: 'string',
      default: 'csv',
      expression: false,
    },
  ],
};

export const extractHtmlNode: NodeDescriptor = {
  type: 'action.extractHtml',
  displayName: 'Extract from HTML',
  description: 'Pulls values out of an HTML page with CSS selectors.',
  group: 'action',
  icon: 'CodeXml',
  color: DATA_COLOR,
  inputs: 1,
  outputs: [''],
  params: [
    { name: 'html', displayName: 'HTML', type: 'text', required: true, placeholder: '{{ $json.body }}' },
    {
      name: 'extractions',
      displayName: 'Take',
      type: 'keyValue',
      default: [{ key: '', value: '' }],
      keyPlaceholder: 'field name',
      valuePlaceholder: 'h1.title',
      description: 'A CSS selector per field.',
      expression: false,
    },
    {
      name: 'take',
      displayName: 'From each match',
      type: 'select',
      default: 'text',
      options: [
        { label: 'The text', value: 'text' },
        { label: 'The inner HTML', value: 'html' },
        { label: 'An attribute', value: 'attribute' },
      ],
      expression: false,
    },
    {
      name: 'attribute',
      displayName: 'Attribute',
      type: 'string',
      required: true,
      placeholder: 'href',
      showIf: { take: ['attribute'] },
      expression: false,
    },
    {
      name: 'all',
      displayName: 'Keep every match, not just the first',
      type: 'boolean',
      default: false,
      description: 'On gives each field an array.',
      expression: false,
    },
  ],
};

export const xmlToJsonNode: NodeDescriptor = {
  type: 'action.xmlToJson',
  displayName: 'Parse XML',
  description: 'Turns XML into ordinary fields you can read with expressions.',
  group: 'action',
  icon: 'CodeXml',
  color: DATA_COLOR,
  inputs: 1,
  outputs: [''],
  params: [
    { name: 'xml', displayName: 'XML', type: 'text', required: true, placeholder: '{{ $json.body }}' },
    {
      name: 'outputField',
      displayName: 'Put it in',
      type: 'string',
      description: 'Leave empty to replace the item with what the XML held.',
      expression: false,
    },
    {
      name: 'attributes',
      displayName: 'Keep attributes',
      type: 'boolean',
      default: true,
      description: 'They arrive prefixed with @ so they cannot collide with a child element.',
      expression: false,
    },
  ],
};

export const executeWorkflowNode: NodeDescriptor = {
  type: 'action.executeWorkflow',
  displayName: 'Execute Workflow',
  description: 'Runs another workflow and carries on with what it produced.',
  group: 'action',
  icon: 'Workflow',
  color: '#8b5cf6',
  inputs: 1,
  outputs: [''],
  // Re-running a whole workflow on a hiccup repeats every side effect it
  // managed to fire, so this one does not retry by itself.
  defaultRetries: 0,
  params: [
    {
      name: 'workflowId',
      displayName: 'Workflow',
      type: 'string',
      required: true,
      placeholder: 'clx0a1b2c3d4e5f6g7h8',
      description: 'The id of the workflow to run. It is in the address bar when you open it.',
    },
    {
      name: 'mode',
      displayName: 'Run it',
      type: 'select',
      default: 'once',
      options: [
        { label: 'Once, with every item', value: 'once' },
        { label: 'Once per item', value: 'perItem' },
      ],
      expression: false,
    },
    {
      name: 'waitForCompletion',
      displayName: 'Wait for it to finish',
      type: 'boolean',
      default: true,
      description: 'Off queues it and carries on, handing you its execution id instead of its output.',
      expression: false,
    },
  ],
};

// ---------------------------------------------------------------------------
// Telegram
//
// One descriptor per Bot API method rather than one node with an operation
// dropdown. The palette then answers "can m8x send a photo?" by having a node
// called Send Photo in it, and each node's inspector shows only the fields that
// method actually takes.
// ---------------------------------------------------------------------------

/** Telegram's own blue, so the family reads as one block in the palette. */
const TELEGRAM_COLOR = '#229ED9';

const telegramCredential: ParamSchema = {
  name: 'credential',
  displayName: 'Bot',
  type: 'select',
  credentialType: 'telegramApi',
  required: true,
  description: 'Several workflows can share one bot. They all receive its messages.',
  expression: false,
};

const telegramChatId: ParamSchema = {
  name: 'chatId',
  displayName: 'Chat',
  type: 'string',
  required: true,
  placeholder: '{{ $json.chatId }}',
  description: 'A numeric chat id, or @username for a public channel.',
};

/**
 * The credential and the chat, which every send node needs.
 *
 * Shared the way `conditionParams` is shared by If and Filter, so the two
 * fields cannot drift apart across eight nodes.
 */
export const telegramTarget: ParamSchema[] = [telegramCredential, telegramChatId];

const telegramParseMode: ParamSchema = {
  name: 'parseMode',
  displayName: 'Format',
  type: 'select',
  default: 'none',
  options: [
    { label: 'Plain text', value: 'none' },
    { label: 'Markdown', value: 'Markdown' },
    { label: 'MarkdownV2', value: 'MarkdownV2' },
    { label: 'HTML', value: 'HTML' },
  ],
  description:
    'MarkdownV2 rejects an unescaped . - ( ) ! and more, so text pasted in from an expression usually needs escaping. HTML is the forgiving one.',
  expression: false,
};

const telegramDisableNotification: ParamSchema = {
  name: 'disableNotification',
  displayName: 'Send silently',
  type: 'boolean',
  default: false,
  description: 'Delivers the message without a notification sound.',
  expression: false,
};

const telegramReplyTo: ParamSchema = {
  name: 'replyToMessageId',
  displayName: 'Reply to message',
  type: 'string',
  placeholder: '{{ $json.messageId }}',
  description: 'Optional. Threads this message under an existing one.',
};

const telegramReplyMarkup: ParamSchema = {
  name: 'replyMarkup',
  displayName: 'Reply markup',
  type: 'json',
  description:
    'Optional. An inline keyboard or a custom keyboard, as Telegram\'s reply_markup object. Pair it with an Answer Button node.',
  // Expressions are on so callback_data can carry the id the button acts on.
  expression: true,
};

export const telegramTrigger: NodeDescriptor = {
  type: 'trigger.telegram',
  displayName: 'Telegram Trigger',
  description: 'Starts the workflow when the bot receives a message.',
  group: 'trigger',
  icon: 'MessageCircle',
  color: TELEGRAM_COLOR,
  inputs: 0,
  outputs: [''],
  params: [
    telegramCredential,
    {
      name: 'updates',
      displayName: 'Listen for',
      type: 'select',
      default: 'message',
      options: [
        { label: 'Messages', value: 'message' },
        { label: 'Messages and edits', value: 'messageAndEdited' },
        { label: 'Button presses', value: 'callback_query' },
        { label: 'Channel posts', value: 'channel_post' },
        { label: 'Everything', value: 'all' },
      ],
      expression: false,
    },
    {
      name: 'chatIds',
      displayName: 'Only these chats',
      type: 'string',
      placeholder: '123456789, -1001234567890',
      description: 'Optional. A comma-separated allowlist of chat ids. Empty means every chat.',
      expression: false,
    },
    {
      name: 'command',
      displayName: 'Only this command',
      type: 'string',
      placeholder: '/status',
      description:
        'Optional. Fires only when the text starts with this. Point a second workflow at the same bot with a different command here.',
      expression: false,
    },
  ],
};

export const telegramSendMessage: NodeDescriptor = {
  type: 'action.telegram.sendMessage',
  displayName: 'Telegram Send Message',
  description: 'Sends a text message, once per incoming item.',
  group: 'action',
  icon: 'Send',
  color: TELEGRAM_COLOR,
  inputs: 1,
  outputs: [''],
  defaultRetries: 2,
  params: [
    ...telegramTarget,
    { name: 'text', displayName: 'Text', type: 'text', required: true, placeholder: 'Order {{ $json.id }} shipped' },
    telegramParseMode,
    {
      name: 'disableLinkPreview',
      displayName: 'Hide link previews',
      type: 'boolean',
      default: false,
      expression: false,
    },
    telegramDisableNotification,
    telegramReplyTo,
    telegramReplyMarkup,
  ],
};

export const telegramSendPhoto: NodeDescriptor = {
  type: 'action.telegram.sendPhoto',
  displayName: 'Telegram Send Photo',
  description: 'Sends a photo by URL or by a file id Telegram already holds.',
  group: 'action',
  icon: 'Image',
  color: TELEGRAM_COLOR,
  inputs: 1,
  outputs: [''],
  defaultRetries: 2,
  params: [
    ...telegramTarget,
    {
      name: 'photo',
      displayName: 'Photo',
      type: 'string',
      required: true,
      placeholder: 'https://example.com/chart.png',
      description: 'A public https URL, or a file_id from an earlier Telegram message.',
    },
    { name: 'caption', displayName: 'Caption', type: 'text' },
    telegramParseMode,
    telegramDisableNotification,
    telegramReplyTo,
  ],
};

export const telegramSendDocument: NodeDescriptor = {
  type: 'action.telegram.sendDocument',
  displayName: 'Telegram Send Document',
  description: 'Sends a file by URL or by a file id Telegram already holds.',
  group: 'action',
  icon: 'FileText',
  color: TELEGRAM_COLOR,
  inputs: 1,
  outputs: [''],
  defaultRetries: 2,
  params: [
    ...telegramTarget,
    {
      name: 'document',
      displayName: 'Document',
      type: 'string',
      required: true,
      placeholder: 'https://example.com/report.pdf',
      description: 'A public https URL, or a file_id from an earlier Telegram message.',
    },
    { name: 'caption', displayName: 'Caption', type: 'text' },
    telegramParseMode,
    telegramDisableNotification,
  ],
};

export const telegramEditMessageText: NodeDescriptor = {
  type: 'action.telegram.editMessageText',
  displayName: 'Telegram Edit Message',
  description: 'Rewrites a message the bot already sent.',
  group: 'action',
  icon: 'SquarePen',
  color: TELEGRAM_COLOR,
  inputs: 1,
  outputs: [''],
  defaultRetries: 2,
  params: [
    ...telegramTarget,
    { name: 'messageId', displayName: 'Message', type: 'string', required: true, placeholder: '{{ $json.message_id }}' },
    { name: 'text', displayName: 'Text', type: 'text', required: true },
    telegramParseMode,
    telegramReplyMarkup,
  ],
};

export const telegramDeleteMessage: NodeDescriptor = {
  type: 'action.telegram.deleteMessage',
  displayName: 'Telegram Delete Message',
  description: 'Deletes a message. Telegram only allows this for the last 48 hours.',
  group: 'action',
  icon: 'Trash2',
  color: TELEGRAM_COLOR,
  inputs: 1,
  outputs: [''],
  defaultRetries: 2,
  params: [
    ...telegramTarget,
    { name: 'messageId', displayName: 'Message', type: 'string', required: true, placeholder: '{{ $json.messageId }}' },
  ],
};

export const telegramAnswerCallbackQuery: NodeDescriptor = {
  type: 'action.telegram.answerCallbackQuery',
  displayName: 'Telegram Answer Button',
  description: 'Acknowledges a button press. Without this the button spins until it times out.',
  group: 'action',
  icon: 'MousePointerClick',
  color: TELEGRAM_COLOR,
  inputs: 1,
  outputs: [''],
  defaultRetries: 2,
  params: [
    telegramCredential,
    {
      name: 'callbackQueryId',
      displayName: 'Callback query',
      type: 'string',
      required: true,
      placeholder: '{{ $json.callbackQueryId }}',
    },
    { name: 'text', displayName: 'Notice', type: 'string', description: 'Optional. Shown briefly to the person who pressed.' },
    {
      name: 'showAlert',
      displayName: 'Show as a dialog',
      type: 'boolean',
      default: false,
      description: 'A dialog they must dismiss, rather than a toast.',
      expression: false,
    },
  ],
};

export const telegramApi: NodeDescriptor = {
  type: 'action.telegram.api',
  displayName: 'Telegram API',
  description: 'Calls any Bot API method. The escape hatch for what the other nodes do not cover.',
  group: 'action',
  icon: 'Terminal',
  color: TELEGRAM_COLOR,
  inputs: 1,
  outputs: [''],
  defaultRetries: 2,
  params: [
    telegramCredential,
    {
      name: 'method',
      displayName: 'Method',
      type: 'string',
      required: true,
      placeholder: 'sendPoll',
      description: 'A Bot API method name, e.g. sendPoll or getChat.',
    },
    {
      name: 'payload',
      displayName: 'Payload',
      type: 'json',
      default: '{}',
      description: "The method's arguments, exactly as Telegram documents them.",
      expression: true,
    },
  ],
};

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

const EMAIL_COLOR = '#e8a33d';

export const emailTrigger: NodeDescriptor = {
  type: 'trigger.email',
  displayName: 'Email Trigger (IMAP)',
  description: 'Starts the workflow when a message arrives in a mailbox folder.',
  group: 'trigger',
  icon: 'Mail',
  color: EMAIL_COLOR,
  inputs: 0,
  outputs: [''],
  params: [
    {
      name: 'credential',
      displayName: 'IMAP account',
      type: 'string',
      credentialType: 'imap',
      required: true,
    },
    {
      name: 'folder',
      displayName: 'Folder',
      type: 'string',
      default: 'INBOX',
      placeholder: 'INBOX',
      description: 'Exactly as the server names it, e.g. INBOX, or INBOX/Invoices on some servers.',
      expression: false,
    },
    {
      name: 'unseenOnly',
      displayName: 'Only unread messages',
      type: 'boolean',
      default: false,
      description: 'Skips anything already marked read, including mail you opened yourself.',
    },
    {
      name: 'fromContains',
      displayName: 'Only from',
      type: 'string',
      placeholder: 'billing@',
      description: 'Optional. Matches part of the sender name or address.',
      expression: false,
    },
    {
      name: 'subjectContains',
      displayName: 'Only subjects containing',
      type: 'string',
      placeholder: 'Invoice',
      description: 'Optional.',
      expression: false,
    },
    {
      name: 'attachments',
      displayName: 'Attachments',
      type: 'select',
      default: 'store',
      options: [
        { label: 'Keep the files', value: 'store' },
        { label: 'Names and sizes only', value: 'ignore' },
      ],
      description: 'Metadata always arrives. Keeping the files stores them for nodes downstream to use.',
      expression: false,
    },
    {
      name: 'afterProcessing',
      displayName: 'After handling',
      type: 'select',
      default: 'nothing',
      options: [
        { label: 'Leave the mailbox alone', value: 'nothing' },
        { label: 'Mark the message read', value: 'seen' },
      ],
      description: 'A message is only ever handled once either way; this is about what your mail client shows.',
      expression: false,
    },
  ],
};

export const emailSend: NodeDescriptor = {
  type: 'action.email.send',
  displayName: 'Send Email',
  description: 'Sends a message over SMTP, once per incoming item.',
  group: 'action',
  icon: 'Send',
  color: EMAIL_COLOR,
  inputs: 1,
  outputs: [''],
  defaultRetries: 2,
  params: [
    {
      name: 'credential',
      displayName: 'SMTP account',
      type: 'string',
      credentialType: 'smtp',
      required: true,
    },
    {
      name: 'from',
      displayName: 'From',
      type: 'string',
      placeholder: 'Falls back to the credential default',
    },
    { name: 'to', displayName: 'To', type: 'string', required: true, placeholder: 'someone@example.com' },
    { name: 'cc', displayName: 'Cc', type: 'string' },
    { name: 'bcc', displayName: 'Bcc', type: 'string' },
    { name: 'replyTo', displayName: 'Reply-To', type: 'string' },
    { name: 'subject', displayName: 'Subject', type: 'string', placeholder: 'Order {{ $json.id }} shipped' },
    { name: 'text', displayName: 'Text body', type: 'text' },
    {
      name: 'html',
      displayName: 'HTML body',
      type: 'text',
      description: 'Optional. Sent alongside the text body, which stays the fallback for clients that want it.',
    },
    {
      name: 'attach',
      displayName: 'Attach files',
      type: 'string',
      placeholder: '* for all, or attachment_0, attachment_1',
      description:
        'Which of the incoming item\'s files to attach. Blank sends none. The Email Trigger names them attachment_0 upwards.',
    },
  ],
};

export const NODE_DESCRIPTORS: NodeDescriptor[] = [
  manualTrigger,
  webhookTrigger,
  scheduleTrigger,
  telegramTrigger,
  emailTrigger,
  httpRequest,
  code,
  setNode,
  executeWorkflowNode,
  respondToWebhookNode,
  parseCsvNode,
  toCsvNode,
  extractHtmlNode,
  xmlToJsonNode,
  telegramSendMessage,
  telegramSendPhoto,
  telegramSendDocument,
  telegramEditMessageText,
  telegramDeleteMessage,
  telegramAnswerCallbackQuery,
  telegramApi,
  emailSend,
  ifNode,
  filterNode,
  switchNode,
  mergeNode,
  splitOutNode,
  loopOverItemsNode,
  aggregateNode,
  summarizeNode,
  sortNode,
  limitNode,
  removeDuplicatesNode,
  waitNode,
  noOpNode,
  stopAndErrorNode,
];
