import type { NodeDescriptor, ParamSchema } from '../../types.js';
import { COMPARISON_OPERATORS } from './shared.js';

/**
 * The datatable family: five actions and the trigger that watches them.
 *
 * One descriptor per operation rather than one node with an operation dropdown,
 * matching the Telegram set: the palette then answers "can m8x remember this
 * row?" by having a node called Insert Row in it, and each inspector shows only
 * the fields that operation takes.
 *
 * See docs/datatables.md.
 */

/** Amber, so the family reads as one block and not as flow control. */
const DATATABLE_COLOR = '#d97706';

const datatableId: ParamSchema = {
  name: 'datatableId',
  displayName: 'Datatable',
  type: 'select',
  datatableSource: true,
  required: true,
  expression: false,
};

/**
 * The question get, update and delete all ask.
 *
 * One block rather than three, for the same reason `conditionParams` is shared
 * by If, Filter and Switch: three copies drift apart the first time an operator
 * is added. `filterCombinator` sits beside it rather than inside the rows,
 * because it is one choice about the whole filter.
 */
export const datatableFilterParams: ParamSchema[] = [
  {
    name: 'filter',
    displayName: 'Filter',
    type: 'json',
    default: [],
    datatableFilterFrom: 'datatableId',
    description: `Rows of column, operator and value. Operators: ${COMPARISON_OPERATORS.map((entry) => entry.label).join(', ')}.`,
  },
  {
    name: 'filterCombinator',
    displayName: 'Match',
    type: 'select',
    default: 'and',
    options: [
      { label: 'All of the conditions', value: 'and' },
      { label: 'Any of the conditions', value: 'or' },
    ],
    expression: false,
  },
];

/** How a row's fields are built from the item, shared by insert and upsert. */
const rowSourceParams: ParamSchema[] = [
  {
    name: 'mode',
    displayName: 'Row contents',
    type: 'select',
    default: 'item',
    options: [
      { label: 'Everything in the item', value: 'item' },
      { label: 'Only the fields below', value: 'fields' },
    ],
    expression: false,
  },
  {
    name: 'fields',
    displayName: 'Fields',
    type: 'keyValue',
    default: [],
    keyPlaceholder: 'column',
    valuePlaceholder: '{{ $json.email }}',
    showIf: { mode: ['fields'] },
  },
];

const scopeParam: ParamSchema = {
  name: 'scope',
  displayName: 'Apply to',
  type: 'select',
  default: 'all',
  options: [
    { label: 'Every matching row', value: 'all' },
    { label: 'The first matching row', value: 'first' },
  ],
  expression: false,
};

export const datatableInsert: NodeDescriptor = {
  type: 'action.datatable.insert',
  displayName: 'Insert Row',
  description: 'Stores one row per item, and returns them with their ids.',
  group: 'action',
  icon: 'ListPlus',
  color: DATATABLE_COLOR,
  inputs: 1,
  outputs: [''],
  params: [datatableId, ...rowSourceParams],
};

export const datatableGet: NodeDescriptor = {
  type: 'action.datatable.get',
  displayName: 'Get Rows',
  description: 'Reads matching rows, one item per row. No match returns nothing.',
  group: 'action',
  icon: 'Search',
  color: DATATABLE_COLOR,
  inputs: 1,
  outputs: [''],
  params: [
    datatableId,
    ...datatableFilterParams,
    {
      name: 'sortField',
      displayName: 'Sort by',
      type: 'select',
      datatableColumnsFrom: 'datatableId',
      description: 'Newest first when left empty.',
      expression: false,
    },
    {
      name: 'sortDirection',
      displayName: 'Direction',
      type: 'select',
      default: 'asc',
      options: [
        { label: 'Ascending', value: 'asc' },
        { label: 'Descending', value: 'desc' },
      ],
      expression: false,
    },
    {
      name: 'limit',
      displayName: 'Most rows to return',
      type: 'number',
      default: 50,
      description: 'Capped at 1000. A larger number is clamped, not refused.',
      expression: false,
    },
  ],
};

export const datatableUpdate: NodeDescriptor = {
  type: 'action.datatable.update',
  displayName: 'Update Rows',
  description: 'Sets fields on matching rows, and returns what they became.',
  group: 'action',
  icon: 'TableProperties',
  color: DATATABLE_COLOR,
  inputs: 1,
  outputs: [''],
  params: [
    datatableId,
    ...datatableFilterParams,
    scopeParam,
    {
      name: 'fields',
      displayName: 'Set',
      type: 'keyValue',
      default: [],
      required: true,
      keyPlaceholder: 'column',
      valuePlaceholder: '{{ $json.status }}',
      description: 'Fields left out keep the value they already had.',
    },
  ],
};

export const datatableDelete: NodeDescriptor = {
  type: 'action.datatable.delete',
  displayName: 'Delete Rows',
  description: 'Removes matching rows. They are returned, then they are gone.',
  group: 'action',
  icon: 'TableRowsSplit',
  color: DATATABLE_COLOR,
  inputs: 1,
  outputs: [''],
  params: [
    datatableId,
    ...datatableFilterParams,
    scopeParam,
    {
      name: 'allowEmptyFilter',
      displayName: 'Allow deleting every row',
      type: 'boolean',
      default: false,
      description:
        'An empty filter matches the whole table. This node refuses to run with one unless this is on.',
      expression: false,
    },
  ],
};

export const datatableUpsert: NodeDescriptor = {
  type: 'action.datatable.upsert',
  displayName: 'Upsert Row',
  description: 'Updates the row matching the key columns, or inserts one.',
  group: 'action',
  icon: 'TableCellsMerge',
  color: DATATABLE_COLOR,
  inputs: 1,
  outputs: [''],
  params: [
    datatableId,
    {
      name: 'matchOn',
      displayName: 'Match on',
      type: 'select',
      multiple: true,
      datatableColumnsFrom: 'datatableId',
      required: true,
      description:
        'Columns that identify the row. Two runs of this node cannot both insert; two different nodes keying the same table on different columns still can.',
      expression: false,
    },
    ...rowSourceParams,
  ],
};

export const datatableTrigger: NodeDescriptor = {
  type: 'trigger.datatable',
  displayName: 'On Datatable Change',
  description: 'Runs when rows in a datatable are inserted, updated or deleted.',
  group: 'trigger',
  icon: 'TableCellsSplit',
  color: DATATABLE_COLOR,
  inputs: 0,
  outputs: [''],
  params: [
    datatableId,
    {
      name: 'events',
      displayName: 'Run on',
      type: 'select',
      multiple: true,
      default: ['insert', 'update', 'delete'],
      options: [
        { label: 'Rows inserted', value: 'insert' },
        { label: 'Rows updated', value: 'update' },
        { label: 'Rows deleted', value: 'delete' },
      ],
      expression: false,
    },
    {
      name: 'watchColumns',
      displayName: 'Only when these columns change',
      type: 'select',
      multiple: true,
      datatableColumnsFrom: 'datatableId',
      description: 'Applies to updates. Leave empty to run on any change.',
      expression: false,
    },
    {
      name: 'perRow',
      displayName: 'One execution per row',
      type: 'boolean',
      default: false,
      description:
        'Off, a change of five hundred rows is one run holding five hundred items. On, it is five hundred runs.',
      expression: false,
    },
    {
      name: 'includeOwnWrites',
      displayName: 'Also run on writes from this workflow',
      type: 'boolean',
      default: false,
      description:
        'Off by default, because a workflow writing to the table it watches would otherwise never stop.',
      expression: false,
    },
  ],
};
