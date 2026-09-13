import type { Graph } from '@m8x/core';
import { CREDENTIAL_TYPES, listCredentials, prisma, webhookUrlFor } from '@m8x/core/server';
import { notFound } from 'next/navigation';

import { Editor } from '@/components/editor/editor';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export default async function WorkflowEditorPage({ params }: { params: Promise<{ id: string }> }) {
  await requireUser();

  const { id } = await params;

  const workflow = await prisma.workflow.findUnique({
    where: { id },
    select: { id: true, name: true, graph: true, active: true, folderId: true },
  });

  if (!workflow) notFound();

  const [credentials, triggers, lastExecution] = await Promise.all([
    listCredentials(),
    prisma.trigger.findMany({
      where: { workflowId: id, kind: 'webhook' },
      select: { nodeId: true, webhookPath: true },
    }),
    prisma.execution.findFirst({
      where: { workflowId: id },
      orderBy: { queuedAt: 'desc' },
      select: { id: true, status: true, queuedAt: true },
    }),
  ]);

  return (
    <Editor
      workflow={{
        id: workflow.id,
        name: workflow.name,
        active: workflow.active,
        graph: workflow.graph as unknown as Graph,
      }}
      credentials={credentials.map((credential) => ({
        id: credential.id,
        name: credential.name,
        type: credential.type,
      }))}
      credentialTypes={CREDENTIAL_TYPES}
      webhookUrls={Object.fromEntries(
        triggers
          .filter((trigger) => trigger.webhookPath)
          .map((trigger) => [trigger.nodeId, webhookUrlFor(trigger.webhookPath!)]),
      )}
      lastExecution={
        lastExecution
          ? {
              id: lastExecution.id,
              status: lastExecution.status,
              at: lastExecution.queuedAt.toISOString(),
            }
          : null
      }
    />
  );
}
