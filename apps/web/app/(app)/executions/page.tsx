import { prisma, subtreeFolderIds } from '@m8x/core/server';
import type { Prisma } from '@prisma/client';
import Link from 'next/link';

import { Badge, EmptyState, PageHeader, StatusDot, formatDuration, formatRelative, type StatusTone } from '@/components/ui';
import { ExecutionFilters } from '@/components/execution-filters';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

export default async function ExecutionsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    workflow?: string;
    folder?: string;
    since?: string;
    fingerprint?: string;
    page?: string;
  }>;
}) {
  await requireUser();

  const filters = await searchParams;
  const page = Math.max(1, Number(filters.page ?? 1));
  const where = await buildWhere(filters);

  const [executions, total, workflows] = await Promise.all([
    prisma.execution.findMany({
      where,
      orderBy: { queuedAt: 'desc' },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        status: true,
        trigger: true,
        queuedAt: true,
        durationMs: true,
        errorNodeName: true,
        errorType: true,
        errorMessage: true,
        workflow: { select: { id: true, name: true } },
      },
    }),
    prisma.execution.count({ where }),
    prisma.workflow.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
  ]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <PageHeader
        title="Executions"
        description={`${total.toLocaleString()} ${total === 1 ? 'run' : 'runs'} match these filters.`}
      />

      <ExecutionFilters workflows={workflows} />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {executions.length === 0 ? (
          <div className="p-6">
            <EmptyState
              title="No runs match"
              description="Widen the filters, or run a workflow to produce one."
            />
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface-1 text-left text-xs text-ink-faint">
              <tr className="border-b border-line">
                <th className="px-6 py-2 font-medium">Workflow</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 font-medium">Started</th>
                <th className="px-3 py-2 font-medium">Duration</th>
                <th className="px-3 py-2 font-medium">Trigger</th>
                <th className="px-6 py-2 font-medium">Failure</th>
              </tr>
            </thead>
            <tbody>
              {executions.map((execution) => (
                <tr
                  key={execution.id}
                  className="border-b border-line/60 transition-colors hover:bg-surface-1"
                >
                  <td className="max-w-64 px-6 py-2">
                    <Link href={`/executions/${execution.id}`} className="flex items-center gap-2 truncate">
                      <StatusDot tone={execution.status as StatusTone} />
                      <span className="truncate text-ink">{execution.workflow.name}</span>
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <Badge tone={execution.status as StatusTone}>{execution.status}</Badge>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-ink-muted">
                    {formatRelative(execution.queuedAt)}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap text-ink-muted">
                    {formatDuration(execution.durationMs)}
                  </td>
                  <td className="px-3 py-2 text-ink-faint">{execution.trigger}</td>
                  <td className="max-w-96 px-6 py-2">
                    {execution.errorMessage ? (
                      <Link href={`/executions/${execution.id}`} className="block truncate text-xs text-bad">
                        {execution.errorNodeName ? `${execution.errorNodeName}: ` : ''}
                        {execution.errorMessage}
                      </Link>
                    ) : (
                      <span className="text-ink-faint">-</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {pageCount > 1 ? (
        <div className="flex items-center justify-between border-t border-line px-6 py-2 text-xs text-ink-faint">
          <span>
            Page {page} of {pageCount}
          </span>
          <div className="flex gap-2">
            {page > 1 ? (
              <Link href={pageHref(filters, page - 1)} className="hover:text-ink">
                Previous
              </Link>
            ) : null}
            {page < pageCount ? (
              <Link href={pageHref(filters, page + 1)} className="hover:text-ink">
                Next
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  );
}

async function buildWhere(filters: {
  status?: string;
  workflow?: string;
  folder?: string;
  since?: string;
  fingerprint?: string;
}): Promise<Prisma.ExecutionWhereInput> {
  const where: Prisma.ExecutionWhereInput = {};

  if (filters.status && filters.status !== 'all') {
    where.status = filters.status as Prisma.ExecutionWhereInput['status'];
  }

  if (filters.workflow) where.workflowId = filters.workflow;
  if (filters.fingerprint) where.errorFingerprint = filters.fingerprint;

  // Filtering by folder means the whole subtree, which is what the materialised
  // path on Folder is for.
  if (filters.folder) {
    const ids = await subtreeFolderIds(filters.folder);
    where.workflow = { folderId: { in: ids } };
  }

  const hours = Number(filters.since ?? 0);
  if (Number.isFinite(hours) && hours > 0) {
    where.queuedAt = { gte: new Date(Date.now() - hours * 60 * 60 * 1000) };
  }

  return where;
}

function pageHref(filters: Record<string, string | undefined>, page: number): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value && key !== 'page') params.set(key, value);
  }
  params.set('page', String(page));
  return `/executions?${params.toString()}`;
}
