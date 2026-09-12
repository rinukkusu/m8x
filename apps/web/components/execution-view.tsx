'use client';

import type { Graph } from '@m8x/core';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
} from '@xyflow/react';
import { AlertTriangle, ArrowLeft, RotateCcw } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState, useTransition } from 'react';

import { retryExecutionAction } from '@/app/actions/workflows';
import { CanvasNodeView, type CanvasNode } from './editor/canvas-node';
import { Badge, Button, cx, formatDuration, formatRelative, type StatusTone } from './ui';

const nodeTypes = { m8x: CanvasNodeView };

export interface NodeRunView {
  id: string;
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: string;
  attempt: number;
  /** Which pass of a loop this row is. 0 outside any loop. */
  iteration: number;
  sequence: number;
  durationMs: number | null;
  startedAt: string;
  input: unknown;
  output: unknown;
  inputTruncated: boolean;
  outputTruncated: boolean;
  error: unknown;
}

export interface ExecutionSummary {
  id: string;
  status: string;
  trigger: string;
  queuedAt: string;
  startedAt: string | null;
  durationMs: number | null;
  errorNodeId: string | null;
  errorNodeName: string | null;
  errorType: string | null;
  errorMessage: string | null;
  errorFingerprint: string | null;
  retryOfId: string | null;
  workflow: { id: string; name: string };
  version: number | null;
}

/**
 * The execution detail view.
 *
 * The same canvas as the editor, with outcomes painted onto the nodes, and the
 * exact items that went in and came out of whichever node you click. This is
 * the screen the whole project is for: it is the difference between knowing a
 * workflow broke and knowing which step broke, on what payload.
 */
export function ExecutionView(props: {
  execution: ExecutionSummary;
  graph: Graph;
  runs: NodeRunView[];
  sameFailureCount: number;
}) {
  return (
    <ReactFlowProvider>
      <ExecutionViewInner {...props} />
    </ReactFlowProvider>
  );
}

function ExecutionViewInner({
  execution,
  graph,
  runs,
  sameFailureCount,
}: {
  execution: ExecutionSummary;
  graph: Graph;
  runs: NodeRunView[];
  sameFailureCount: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(execution.errorNodeId);
  const [error, setError] = useState<string | null>(null);

  const inFlight = execution.status === 'queued' || execution.status === 'running';

  // Poll while the run is live. A websocket would be nicer, but a three-second
  // refresh on a page nobody leaves open for hours is not worth the machinery.
  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(timer);
  }, [inFlight, router]);

  /**
   * The last run of each node, which is the one whose outcome the canvas shows.
   *
   * Last by sequence rather than by attempt: a node inside a loop has one row
   * per pass, every one of them attempt 1, and the canvas should paint the pass
   * that ran most recently.
   */
  const latestByNode = useMemo(() => {
    const map = new Map<string, NodeRunView>();
    for (const run of runs) {
      const current = map.get(run.nodeId);
      if (!current || run.sequence >= current.sequence) map.set(run.nodeId, run);
    }
    return map;
  }, [runs]);

  const nodes: CanvasNode[] = useMemo(
    () =>
      graph.nodes.map((node) => ({
        id: node.id,
        type: 'm8x' as const,
        position: node.position,
        selected: node.id === selectedNodeId,
        data: {
          node,
          runStatus: latestByNode.get(node.id)?.status as CanvasNode['data']['runStatus'],
        },
      })),
    [graph.nodes, latestByNode, selectedNodeId],
  );

  const edges: Edge[] = useMemo(
    () =>
      graph.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: String(edge.sourceOutput),
        targetHandle: String(edge.targetInput),
        type: 'smoothstep',
      })),
    [graph.edges],
  );

  // Newest first, which for a loop means the last pass rather than an arbitrary
  // one: every pass carries the same attempt number.
  const selectedRuns = runs
    .filter((run) => run.nodeId === selectedNodeId)
    .sort((a, b) => b.sequence - a.sequence);

  function retry(fromFailedNode: boolean) {
    setError(null);
    startTransition(async () => {
      const result = await retryExecutionAction(execution.id, fromFailedNode);
      if (!result.ok) {
        setError(result.error ?? 'The retry could not be queued.');
        return;
      }
      router.push(`/executions/${result.id}`);
    });
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2.5">
        <Link href="/executions" className="text-ink-faint transition-colors hover:text-ink" aria-label="Back">
          <ArrowLeft className="size-4" />
        </Link>

        <Link href={`/workflows/${execution.workflow.id}`} className="truncate text-sm font-medium hover:underline">
          {execution.workflow.name}
        </Link>

        <Badge tone={execution.status as StatusTone}>{execution.status}</Badge>

        <span className="text-xs text-ink-faint">
          {execution.trigger} · {formatRelative(execution.queuedAt)} · {formatDuration(execution.durationMs)}
          {execution.version ? ` · v${execution.version}` : ''}
        </span>

        {execution.retryOfId ? (
          <Link href={`/executions/${execution.retryOfId}`} className="text-xs text-ink-faint hover:text-ink">
            retry of an earlier run
          </Link>
        ) : null}

        <div className="flex-1" />

        {error ? <span className="text-xs text-bad">{error}</span> : null}

        {execution.status === 'failed' ? (
          <>
            <Button size="sm" onClick={() => retry(true)} disabled={pending}>
              <RotateCcw className="size-3.5" />
              Retry from failure
            </Button>
            <Button size="sm" variant="secondary" onClick={() => retry(false)} disabled={pending}>
              Re-run all
            </Button>
          </>
        ) : null}
      </div>

      {execution.errorMessage ? (
        <div className="border-b border-bad/25 bg-bad/10 px-4 py-2.5">
          <div className="flex items-start gap-2 text-xs text-bad">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <div className="min-w-0">
              <p>
                <span className="font-medium">{execution.errorNodeName ?? 'The workflow'}</span> failed with{' '}
                <code className="font-mono">{execution.errorType}</code>: {execution.errorMessage}
              </p>
              {sameFailureCount > 1 ? (
                <Link
                  href={`/executions?fingerprint=${execution.errorFingerprint}`}
                  className="mt-1 inline-block underline underline-offset-2"
                >
                  {sameFailureCount} runs have failed this same way
                </Link>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            onNodeClick={(_, node) => setSelectedNodeId(node.id)}
            nodesDraggable={false}
            nodesConnectable={false}
            edgesFocusable={false}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#2a3040" />
            <Controls showInteractive={false} />
          </ReactFlow>
        </div>

        <aside className="flex w-[26rem] shrink-0 flex-col overflow-hidden border-l border-line bg-surface-1">
          {selectedRuns.length === 0 ? (
            <div className="p-4 text-sm text-ink-faint">
              {selectedNodeId
                ? 'This node did not run. Its branch was not taken, or the run stopped before reaching it.'
                : 'Click a node to see what went in and what came out.'}
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto">
              {selectedRuns.map((run, index) => (
                <NodeRunPanel
                    key={run.id}
                    run={run}
                    isLatest={index === 0}
                    showAttempt={selectedRuns.some((candidate) => candidate.attempt > 1)}
                  />
              ))}
            </div>
          )}
        </aside>
      </div>
    </>
  );
}

function NodeRunPanel({
  run,
  isLatest,
  showAttempt,
}: {
  run: NodeRunView;
  isLatest: boolean;
  showAttempt: boolean;
}) {
  const [tab, setTab] = useState<'output' | 'input'>(run.status === 'failed' ? 'input' : 'output');
  const error = run.error as { errorType?: string; message?: string; stack?: string; logs?: Array<{ level: string; message: string }> } | null;
  const logs = error?.logs ?? [];

  return (
    <div className={cx('border-b border-line', !isLatest && 'opacity-70')}>
      <div className="flex items-center gap-2 px-4 py-2.5">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{run.nodeName}</span>
        {run.iteration > 0 ? (
          <span className="text-[11px] text-ink-faint">pass {run.iteration}</span>
        ) : null}
        {showAttempt ? <span className="text-[11px] text-ink-faint">attempt {run.attempt}</span> : null}
        <Badge tone={run.status as StatusTone}>{run.status}</Badge>
        <span className="text-[11px] text-ink-faint">{formatDuration(run.durationMs)}</span>
      </div>

      {run.status === 'failed' && error?.message ? (
        <div className="mx-4 mb-2.5 rounded-md border border-bad/25 bg-bad/10 p-2.5">
          <p className="font-mono text-[11px] text-bad">{error.errorType}</p>
          <p className="mt-1 text-xs leading-relaxed text-bad">{error.message}</p>
          {error.stack ? (
            <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap font-mono text-[10px] text-bad/75">
              {error.stack}
            </pre>
          ) : null}
        </div>
      ) : null}

      {run.status === 'skipped' ? (
        <p className="px-4 pb-2.5 text-xs text-ink-faint">{error?.message ?? 'Skipped.'}</p>
      ) : null}

      {logs.length > 0 ? (
        <div className="mx-4 mb-2.5 max-h-32 overflow-y-auto rounded-md border border-line bg-surface-0 p-2">
          {logs.map((entry, index) => (
            <p
              key={index}
              className={cx(
                'font-mono text-[10px] leading-relaxed',
                entry.level === 'error' ? 'text-bad' : entry.level === 'warn' ? 'text-warn' : 'text-ink-muted',
              )}
            >
              {entry.message}
            </p>
          ))}
        </div>
      ) : null}

      <div className="flex gap-1 px-4">
        {(['input', 'output'] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={cx(
              'rounded px-2 py-1 text-xs capitalize transition-colors',
              tab === value ? 'bg-surface-3 text-ink' : 'text-ink-faint hover:text-ink',
            )}
          >
            {value} ({countItems(value === 'input' ? run.input : run.output)})
          </button>
        ))}
      </div>

      <ItemsView
        value={tab === 'input' ? run.input : run.output}
        truncated={tab === 'input' ? run.inputTruncated : run.outputTruncated}
      />
    </div>
  );
}

function ItemsView({ value, truncated }: { value: unknown; truncated: boolean }) {
  const items = Array.isArray(value) ? value : [];

  if (items.length === 0) {
    return <p className="px-4 py-3 text-xs text-ink-faint">No items.</p>;
  }

  return (
    <div className="px-4 py-2">
      {truncated ? (
        <p className="mb-1.5 text-[11px] text-warn">
          Only part of this payload was stored. The full data went through the workflow.
        </p>
      ) : null}
      <pre className="max-h-80 overflow-auto rounded-md border border-line bg-surface-0 p-2.5 font-mono text-[11px] leading-relaxed text-ink-muted">
        {JSON.stringify(items.map((item) => (item as { json?: unknown })?.json ?? item), null, 2)}
      </pre>
    </div>
  );
}

function countItems(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}
