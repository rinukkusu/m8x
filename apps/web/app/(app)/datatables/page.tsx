import { countRows, listDatatables } from '@m8x/core/server';

import { DatatableManager } from '@/components/datatable-manager';
import { PageHeader } from '@/components/ui';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function DatatablesPage() {
  await requireUser();

  const tables = await listDatatables();
  const counts = await Promise.all(tables.map((table) => countRows(table.id)));

  return (
    <>
      <PageHeader
        title="Datatables"
        description="Somewhere for a workflow to keep state between runs. Rows written here start the workflows that watch them, exactly as a node's writes do."
      />

      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <DatatableManager
          tables={tables.map((table, index) => ({
            id: table.id,
            name: table.name,
            description: table.description,
            columns: table.columns.length,
            rows: counts[index] ?? 0,
            updatedAt: table.updatedAt.toISOString(),
          }))}
        />
      </div>
    </>
  );
}
