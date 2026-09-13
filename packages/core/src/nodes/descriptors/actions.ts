import type { NodeDescriptor } from '../../types.js';
import { HTTP_METHODS_WITH_BODY } from './shared.js';

/** The general-purpose actions: talk to something, run some code, set a field. */

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
