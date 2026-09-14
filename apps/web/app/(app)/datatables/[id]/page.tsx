import { countRows, getDatatable, getRows, workflowsUsingDatatable } from '@m8x/core/server';
import { notFound } from 'next/navigation';

import { DatatableView } from '@/components/datatable-view';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/** How many rows the grid shows at once. Paging beats a page that never loads. */
const PAGE_SIZE = 50;

export default async function DatatablePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  await requireUser();

  const { id } = await params;
  const table = await getDatatable(id);
  if (!table) notFound();

  const page = Math.max(1, Number((await searchParams).page ?? '1') || 1);
  const [rows, total, usedBy] = await Promise.all([
    getRows({ datatableId: id, limit: PAGE_SIZE, offset: (page - 1) * PAGE_SIZE }),
    countRows(id),
    workflowsUsingDatatable(id),
  ]);

  return (
    <DatatableView
      table={{ id: table.id, name: table.name, description: table.description, columns: table.columns }}
      rows={rows.map((row) => ({ id: row.id, data: row.data, updatedAt: row.updatedAt.toISOString() }))}
      total={total}
      page={page}
      pageSize={PAGE_SIZE}
      usedBy={usedBy}
    />
  );
}
