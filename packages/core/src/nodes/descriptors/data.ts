import type { NodeDescriptor } from '../../types.js';

/** Reading and writing the shapes data arrives in: CSV, HTML, XML. */

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
