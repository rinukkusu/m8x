'use client';

import { COMPARISON_OPERATORS, UNARY_OPERATORS, type DatatableColumn } from '@m8x/core';
import { Plus, X } from 'lucide-react';

import { Button, Input, Select } from '../ui';

/**
 * The filter rows behind Get, Update and Delete Rows.
 *
 * Its own widget because `keyValue` is two columns and this is three, and
 * because the first column should be the table's own columns rather than a name
 * typed from memory. The stored value is a plain array either way, so a node
 * saved before this existed still reads back.
 */

interface FilterRow {
  field?: string;
  operator?: string;
  value?: unknown;
}

/** Operators that compare against nothing, so the value box would be a lie. */
const UNARY = new Set<string>(UNARY_OPERATORS);

export function DatatableFilterEditor({
  label,
  hint,
  rows,
  columns,
  onChange,
}: {
  label: string;
  hint?: string;
  rows: FilterRow[];
  columns: DatatableColumn[];
  onChange: (value: unknown) => void;
}) {
  function update(index: number, patch: FilterRow) {
    onChange(rows.map((row, position) => (position === index ? { ...row, ...patch } : row)));
  }

  return (
    <div className="space-y-1.5">
      <span className="block text-xs font-medium text-ink-muted">{label}</span>

      {rows.map((row, index) => {
        const operator = row.operator ?? 'equals';
        // A column that no longer exists is still shown, so removing a column
        // does not silently change what a workflow matches.
        const known = columns.some((column) => column.key === row.field);

        return (
          <div key={index} className="space-y-1 rounded-md border border-line bg-surface-2 p-1.5">
            <div className="flex items-center gap-1.5">
              {columns.length > 0 ? (
                <Select
                  value={row.field ?? ''}
                  onChange={(event) => update(index, { field: event.target.value })}
                  className="min-w-0 flex-1"
                >
                  <option value="">Column…</option>
                  {columns.map((column) => (
                    <option key={column.key} value={column.key}>
                      {column.name}
                    </option>
                  ))}
                  {row.field && !known ? <option value={row.field}>{row.field} (gone)</option> : null}
                </Select>
              ) : (
                <Input
                  value={row.field ?? ''}
                  placeholder="column"
                  onChange={(event) => update(index, { field: event.target.value })}
                  className="min-w-0 flex-1"
                />
              )}

              <Button
                variant="ghost"
                size="sm"
                className="shrink-0"
                onClick={() => onChange(rows.filter((_, position) => position !== index))}
                aria-label="Remove condition"
              >
                <X className="size-3.5" />
              </Button>
            </div>

            <div className="flex items-center gap-1.5">
              <Select
                value={operator}
                onChange={(event) => update(index, { operator: event.target.value })}
                className="min-w-0 flex-1"
              >
                {COMPARISON_OPERATORS.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))}
              </Select>

              {UNARY.has(operator) ? null : (
                <Input
                  value={String(row.value ?? '')}
                  placeholder="{{ $json.status }}"
                  onChange={(event) => update(index, { value: event.target.value })}
                  className="min-w-0 flex-1"
                />
              )}
            </div>
          </div>
        );
      })}

      <Button
        size="sm"
        variant="ghost"
        onClick={() => onChange([...rows, { field: '', operator: 'equals', value: '' }])}
      >
        <Plus className="size-3.5" />
        Add condition
      </Button>

      {hint ? <span className="block text-xs leading-relaxed text-ink-faint">{hint}</span> : null}
      {rows.length === 0 ? (
        <span className="block text-xs leading-relaxed text-warn">No conditions: this matches every row.</span>
      ) : null}
    </div>
  );
}
