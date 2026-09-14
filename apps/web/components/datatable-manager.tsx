'use client';

import { Plus, Table2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { createDatatableAction } from '@/app/actions/datatables';
import { Button, EmptyState, Field, Input, formatRelative } from './ui';

interface DatatableRow {
  id: string;
  name: string;
  description: string | null;
  columns: number;
  rows: number;
  updatedAt: string;
}

export function DatatableManager({ tables }: { tables: DatatableRow[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  function create() {
    setError(null);
    startTransition(async () => {
      const result = await createDatatableAction({ name });
      if (!result.ok) {
        setError(result.error ?? 'That could not be created.');
        return;
      }
      setName('');
      setCreating(false);
      // Straight into the new table: an empty one is useless until it has
      // columns, and that is the next thing anyone wants to do.
      router.push(`/datatables/${result.id}`);
    });
  }

  return (
    <div className="max-w-2xl space-y-4">
      {error ? (
        <p className="rounded-md border border-bad/25 bg-bad/10 px-3 py-2 text-xs text-bad">{error}</p>
      ) : null}

      {creating ? (
        <div className="space-y-3 rounded-lg border border-line bg-surface-1 p-4">
          <Field label="Name">
            <Input
              autoFocus
              value={name}
              placeholder="Customers"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') create();
                if (event.key === 'Escape') setCreating(false);
              }}
            />
          </Field>
          <div className="flex gap-2">
            <Button variant="primary" size="sm" onClick={create} disabled={pending}>
              Create
            </Button>
            <Button size="sm" onClick={() => setCreating(false)} disabled={pending}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {tables.length === 0 && !creating ? (
        <EmptyState
          title="No datatables yet"
          description="A datatable is where a workflow keeps what it needs to remember between runs: who has already been emailed, what a price was last time, what is still waiting to be processed."
          action={
            <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
              <Plus className="size-3.5" />
              New datatable
            </Button>
          }
        />
      ) : (
        <>
          {creating ? null : (
            <div className="flex justify-end">
              <Button variant="primary" size="sm" onClick={() => setCreating(true)}>
                <Plus className="size-3.5" />
                New datatable
              </Button>
            </div>
          )}

          <ul className="space-y-1.5">
            {tables.map((table) => (
              <li key={table.id}>
                <Link
                  href={`/datatables/${table.id}`}
                  className="flex items-center gap-3 rounded-lg border border-line bg-surface-1 px-4 py-3 transition-colors hover:border-line-strong"
                >
                  <Table2 className="size-4 shrink-0 text-ink-faint" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">{table.name}</span>
                    <span className="block text-xs text-ink-faint">
                      {table.rows} {table.rows === 1 ? 'row' : 'rows'} · {table.columns}{' '}
                      {table.columns === 1 ? 'column' : 'columns'} · updated {formatRelative(table.updatedAt)}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
