import { getFolderTree, prisma, type FolderNode } from '@m8x/core/server';

import { WorkflowBrowser, type WorkflowRow } from '@/components/workflow-browser';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function WorkflowsPage({
  searchParams,
}: {
  searchParams: Promise<{ folder?: string }>;
}) {
  await requireUser();

  const { folder } = await searchParams;

  const [tree, workflows] = await Promise.all([getFolderTree(), loadWorkflows()]);

  return <WorkflowBrowser tree={serialise(tree)} workflows={workflows} selectedFolderId={folder ?? null} />;
}

async function loadWorkflows(): Promise<WorkflowRow[]> {
  const workflows = await prisma.workflow.findMany({
    orderBy: { updatedAt: 'desc' },
    select: {
      id: true,
      name: true,
      folderId: true,
      active: true,
      updatedAt: true,
      // The last run's outcome is the single most useful thing to show next to
      // a workflow's name, so it is worth the extra join.
      executions: {
        orderBy: { queuedAt: 'desc' },
        take: 1,
        select: { status: true, queuedAt: true, durationMs: true },
      },
    },
  });

  return workflows.map((workflow) => ({
    id: workflow.id,
    name: workflow.name,
    folderId: workflow.folderId,
    active: workflow.active,
    updatedAt: workflow.updatedAt.toISOString(),
    lastRun: workflow.executions[0]
      ? {
          status: workflow.executions[0].status,
          at: workflow.executions[0].queuedAt.toISOString(),
          durationMs: workflow.executions[0].durationMs,
        }
      : null,
  }));
}

/** Dates do not survive the server-to-client boundary, so strip them here. */
function serialise(nodes: FolderNode[]): FolderNode[] {
  return nodes.map((node) => ({ ...node, children: serialise(node.children) }));
}
