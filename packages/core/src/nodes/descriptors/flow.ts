import type { NodeDescriptor } from '../../types.js';
import { conditionParams } from './shared.js';

/** Branching, batching, merging, and the item-list nodes that feed them. */

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
