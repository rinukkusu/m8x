'use client';

import { DATATABLE_COLUMN_TYPES, isValidColumnKey, type DatatableColumn } from '@m8x/core';
import { Plus, X } from 'lucide-react';
import { useState } from 'react';

import { Button, Input, Select } from './ui';

/**
 * The column list.
 *
 * Editing it writes one row of metadata and rewrites no data: a row that
 * predates a column simply lacks the key, and a removed column leaves what it
 * held behind, which comes back if the column does. That is worth saying on the
 * screen, because "remove column" reads like a destructive act and here it is
 * not one.
 */
export function DatatableColumnEditor({
  columns,
  pending,
  onSave,
  onCancel,
}: {
  columns: DatatableColumn[];
  pending: boolean;
  onSave: (columns: DatatableColumn[]) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<DatatableColumn[]>(columns);

  const invalid = draft.find((column) => !isValidColumnKey(column.key));
  // Two columns with one key is one column as far as storage is concerned: the
  // second would be dropped on the next read and appear to have vanished.
  const duplicate = draft.find((column, index) => draft.findIndex((other) => other.key === column.key) !== index);

  function update(index: number, patch: Partial<DatatableColumn>) {
    setDraft(draft.map((column, position) => (position === index ? { ...column, ...patch } : column)));
  }

  return (
    <div className="space-y-3 rounded-lg border border-line bg-surface-1 p-4">
      <div className="space-y-2">
        {draft.map((column, index) => (
          <div key={index} className="flex flex-wrap items-center gap-1.5">
            <Input
              value={column.key}
              placeholder="key"
              onChange={(event) => update(index, { key: event.target.value.trim() })}
              className="w-32"
            />
            <Input
              value={column.name}
              placeholder="Label"
              onChange={(event) => update(index, { name: event.target.value })}
              className="w-36"
            />
            <Select
              value={column.type}
              onChange={(event) => update(index, { type: event.target.value as DatatableColumn['type'] })}
              className="w-32"
            >
              {DATATABLE_COLUMN_TYPES.map((type) => (
                <option key={type.value} value={type.value}>
                  {type.label}
                </option>
              ))}
            </Select>

            <Input
              value={column.default === undefined || column.default === null ? '' : String(column.default)}
              placeholder="default"
              title="Filled in when a write leaves this column out."
              onChange={(event) => update(index, { default: event.target.value === '' ? undefined : event.target.value })}
              className="w-28"
            />

            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-muted">
              <input
                type="checkbox"
                checked={column.required === true}
                onChange={(event) => update(index, { required: event.target.checked })}
                className="size-3.5 accent-[var(--color-accent)]"
              />
              Required
            </label>
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-ink-muted">
              <input
                type="checkbox"
                checked={column.unique === true}
                onChange={(event) => update(index, { unique: event.target.checked })}
                className="size-3.5 accent-[var(--color-accent)]"
              />
              Unique
            </label>

            <Button
              variant="ghost"
              size="sm"
              className="shrink-0"
              onClick={() => setDraft(draft.filter((_, position) => position !== index))}
              aria-label="Remove column"
            >
              <X className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>

      <Button
        size="sm"
        variant="ghost"
        onClick={() => setDraft([...draft, { key: '', name: '', type: 'string' }])}
      >
        <Plus className="size-3.5" />
        Add column
      </Button>

      {invalid ? (
        <p className="text-xs text-bad">
          “{invalid.key || 'an empty key'}” is not a usable key: letters, digits and underscores, not starting with a
          digit.
        </p>
      ) : duplicate ? (
        <p className="text-xs text-bad">“{duplicate.key}” is used by two columns. Keys have to be unique.</p>
      ) : (
        <p className="text-xs text-ink-faint">
          Columns are metadata. Adding or removing one rewrites no rows, and a removed column leaves what it held
          behind. A default is filled in whenever a write leaves the column out.
        </p>
      )}

      <div className="flex gap-2">
        <Button
          variant="primary"
          size="sm"
          disabled={pending || invalid !== undefined || duplicate !== undefined}
          onClick={() => onSave(draft.map((column) => ({ ...column, name: column.name || column.key })))}
        >
          Save columns
        </Button>
        <Button size="sm" onClick={onCancel} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
