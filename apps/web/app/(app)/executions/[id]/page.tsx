import type { Graph } from '@m8x/core';
import { prisma } from '@m8x/core/server';
import { notFound } from 'next/navigation';

import { ExecutionView, type NodeRunView } from '@/components/execution-view';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function ExecutionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();

  const { id } = await params;

  const execution = await prisma.execution.findUnique({
    where: { id },
    include: {
      workflow: { select: { id: true, name: true } },
      workflowVersion: { select: { graph: true, version: true } },
      nodeRuns: { orderBy: [{ sequence: 'asc' }] },
    },
  });

  if (!execution) notFound();

  // How many other runs hit the same problem. This one number is what turns
  // "this run failed" into "this has failed forty times this week".
  const sameFailureCount = execution.errorFingerprint
    ? await prisma.execution.count({ where: { errorFingerprint: execution.errorFingerprint } })
    : 0;

  // A node that ran another workflow gets a link through to it.
  const children = await prisma.execution.findMany({
    where: { parentExecutionId: execution.id },
    orderBy: { queuedAt: 'asc' },
    select: { id: true, parentNodeId: true },
  });

  const childExecutions: Record<string, string[]> = {};
  for (const child of children) {
    if (!child.parentNodeId) continue;
    (childExecutions[child.parentNodeId] ??= []).push(child.id);
  }

  const runs: NodeRunView[] = execution.nodeRuns.map((run) => ({
    id: run.id,
    nodeId: run.nodeId,
    nodeName: run.nodeName,
    nodeType: run.nodeType,
    status: run.status,
    attempt: run.attempt,
    iteration: run.iteration,
    sequence: run.sequence,
    durationMs: run.durationMs,
    startedAt: run.startedAt.toISOString(),
    input: run.input as unknown,
    output: run.output as unknown,
    inputTruncated: run.inputTruncated,
    outputTruncated: run.outputTruncated,
    error: run.error as unknown,
  }));

  return (
    <ExecutionView
      execution={{
        id: execution.id,
        status: execution.status,
        trigger: execution.trigger,
        queuedAt: execution.queuedAt.toISOString(),
        startedAt: execution.startedAt?.toISOString() ?? null,
        durationMs: execution.durationMs,
        errorNodeId: execution.errorNodeId,
        errorNodeName: execution.errorNodeName,
        errorType: execution.errorType,
        errorMessage: execution.errorMessage,
        errorFingerprint: execution.errorFingerprint,
        retryOfId: execution.retryOfId,
        workflow: execution.workflow,
        version: execution.workflowVersion?.version ?? null,
      }}
      graph={(execution.workflowVersion?.graph ?? { nodes: [], edges: [] }) as unknown as Graph}
      runs={runs}
      childExecutions={childExecutions}
      sameFailureCount={sameFailureCount}
    />
  );
}
