'use client';

import type { DatatableColumn } from '@m8x/core';
import { Plus, Settings2, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import {
  deleteDatatableAction,
  deleteRowAction,
  insertRowAction,
  updateDatatableAction,
  updateRowAction,
} from '@/app/actions/datatables';
import { DatatableColumnEditor } from './datatable-column-editor';
import { Button, EmptyState, Input, PageHeader, formatRelative } from './ui';

interface GridRow {
  id: string;
  data: Record<string, unknown>;
  updatedAt: string;
}

/**
 * One datatable: its columns, and the rows in it.
 *
 * The grid exists because a table nobody can look at or correct by hand is a
 * worse Code node — the point of keeping state here is that you can see it, and
 * fix it when it is wrong. Edits go through the same write path a node uses, so
 * changing a cell starts the workflows watching this table. Bulk work turns that
 * off with the toggle, which is why the toggle is here and not on a node.
 */
export function DatatableView({
  table,
  rows,
  total,
  page,
  pageSize,
  usedBy,
}: {
  table: { id: string; name: string; description: string | null; columns: DatatableColumn[] };
  rows: GridRow[];
  total: number;
  page: number;
  pageSize: number;
  usedBy: Array<{ id: string; name: string }>;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [editingColumns, setEditingColumns] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [silent, setSilent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) setError(result.error ?? 'That did not work.');
      else router.refresh();
    });
  }

  const pages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <Link href="/datatables" className="text-ink-faint hover:text-ink">
              Datatables
            </Link>
            <span className="text-ink-faint">/</span>
            {table.name}
          </span>
        }
        description={table.description ?? undefined}
        actions={
          <>
            <label className="flex cursor-pointer items-center gap-1.5 pr-2 text-xs text-ink-muted">
              <input
                type="checkbox"
                checked={silent}
                onChange={(event) => setSilent(event.target.checked)}
                className="size-3.5 accent-[var(--color-accent)]"
              />
              Don’t trigger workflows
            </label>
            <Button size="sm" onClick={() => setEditingColumns((value) => !value)}>
              <Settings2 className="size-3.5" />
              Columns
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={pending || table.columns.length === 0}
              onClick={() => run(() => insertRowAction(table.id, {}, silent))}
            >
              <Plus className="size-3.5" />
              Add row
            </Button>
          </>
        }
      />

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6">
        {error ? (
          <p className="rounded-md border border-bad/25 bg-bad/10 px-3 py-2 text-xs text-bad">{error}</p>
        ) : null}

        {editingColumns ? (
          <DatatableColumnEditor
            columns={table.columns}
            pending={pending}
            onCancel={() => setEditingColumns(false)}
            onSave={(columns) => {
              setEditingColumns(false);
              run(() => updateDatatableAction(table.id, { columns }));
            }}
          />
        ) : null}

        {table.columns.length === 0 ? (
          <EmptyState
            title="No columns yet"
            description="Columns drive this grid, the filter dropdowns in the editor, and the type each value is stored as. Rows can still hold anything a workflow writes — declaring a column is what makes it filterable."
            action={
              <Button variant="primary" size="sm" onClick={() => setEditingColumns(true)}>
                Add columns
              </Button>
            }
          />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No rows yet"
            description="Add one here, or let a workflow write the first."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left">
                  {table.columns.map((column) => (
                    <th key={column.key} className="px-3 py-2 text-xs font-medium text-ink-muted">
                      {column.name}
                      {column.required ? <span className="text-warn"> *</span> : null}
                    </th>
                  ))}
                  <th className="px-3 py-2 text-xs font-medium text-ink-muted">Updated</th>
                  <th className="w-10" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id} className="border-b border-line last:border-0">
                    {table.columns.map((column) => (
                      <td key={column.key} className="px-1.5 py-1">
                        <Cell
                          value={row.data[column.key]}
                          disabled={pending}
                          onCommit={(value) =>
                            run(() => updateRowAction(table.id, row.id, { [column.key]: value }, silent))
                          }
                        />
                      </td>
                    ))}
                    <td className="whitespace-nowrap px-3 py-1 text-xs text-ink-faint">
                      {formatRelative(row.updatedAt)}
                      <ExtraFields data={row.data} columns={table.columns} />
                    </td>
                    <td className="px-1.5 py-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        aria-label="Delete row"
                        onClick={() => run(() => deleteRowAction(table.id, row.id, silent))}
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {pages > 1 ? (
          <div className="flex items-center justify-between text-xs text-ink-faint">
            <span>
              {total} rows · page {page} of {pages}
            </span>
            <span className="flex gap-2">
              {page > 1 ? (
                <Link href={`/datatables/${table.id}?page=${page - 1}`} className="hover:text-ink">
                  Previous
                </Link>
              ) : null}
              {page < pages ? (
                <Link href={`/datatables/${table.id}?page=${page + 1}`} className="hover:text-ink">
                  Next
                </Link>
              ) : null}
            </span>
          </div>
        ) : null}

        <div className="space-y-2 border-t border-line pt-4">
          {confirmingDelete ? (
            <div className="space-y-2 rounded-lg border border-bad/25 bg-bad/5 p-4">
              <p className="text-sm text-ink">
                Delete “{table.name}” and all {total} of its rows? This cannot be undone.
              </p>
              {usedBy.length > 0 ? (
                <p className="text-xs text-warn">
                  {usedBy.length === 1 ? 'One workflow uses it' : `${usedBy.length} workflows use it`}:{' '}
                  {usedBy.map((workflow) => workflow.name).join(', ')}. Their datatable nodes will fail until they are
                  pointed somewhere else.
                </p>
              ) : (
                <p className="text-xs text-ink-faint">No workflow references it.</p>
              )}
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="danger"
                  disabled={pending}
                  onClick={() =>
                    startTransition(async () => {
                      const result = await deleteDatatableAction(table.id);
                      if (!result.ok) setError(result.error ?? 'That could not be deleted.');
                      else router.push('/datatables');
                    })
                  }
                >
                  Delete datatable
                </Button>
                <Button size="sm" onClick={() => setConfirmingDelete(false)} disabled={pending}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : (
            <Button size="sm" onClick={() => setConfirmingDelete(true)}>
              <Trash2 className="size-3.5" />
              Delete datatable
            </Button>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * One cell.
 *
 * Committed on blur rather than on every keystroke: each write is a real
 * transaction that may start a workflow, and one per character typed is not a
 * thing anyone wants.
 */
function Cell({
  value,
  disabled,
  onCommit,
}: {
  value: unknown;
  disabled: boolean;
  onCommit: (value: string) => void;
}) {
  const stored = value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const [draft, setDraft] = useState(stored);
  const [focused, setFocused] = useState(false);

  // While the field is not being edited it follows the server, so a workflow
  // writing to this row shows up on the next refresh instead of being masked by
  // stale local state.
  const shown = focused ? draft : stored;

  return (
    <Input
      value={shown}
      disabled={disabled}
      onFocus={() => {
        setDraft(stored);
        setFocused(true);
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        setFocused(false);
        if (draft !== stored) onCommit(draft);
      }}
      className="min-w-32 border-transparent bg-transparent hover:border-line focus:bg-surface-2"
    />
  );
}

/** Keys a workflow wrote that no column declares. Shown, never silently lost. */
function ExtraFields({ data, columns }: { data: Record<string, unknown>; columns: DatatableColumn[] }) {
  const declared = new Set(columns.map((column) => column.key));
  const extra = Object.keys(data).filter((key) => !declared.has(key));
  if (extra.length === 0) return null;

  return (
    <span className="block text-[11px] text-ink-faint" title={extra.join(', ')}>
      +{extra.length} undeclared
    </span>
  );
}
