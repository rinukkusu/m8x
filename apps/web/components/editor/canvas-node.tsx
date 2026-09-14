'use client';

import { getNodeDescriptor, resolveOutputs, type GraphNode } from '@m8x/core';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { Pin } from 'lucide-react';
import * as icons from 'lucide-react';

import { cx } from '../ui';

export type CanvasNodeData = {
  node: GraphNode;
  /** Outcome of this node in the run being displayed, if any. */
  runStatus?: 'success' | 'failed' | 'skipped' | 'running' | 'pinned';
  /** This node's output is frozen, so a run from the editor replays it. */
  pinned?: boolean;
  /** Set on the node that owns the currently open inspector. */
  selected?: boolean;
};

export type CanvasNode = Node<CanvasNodeData, 'm8x'>;

const RUN_RING = {
  success: 'ring-2 ring-ok/70',
  failed: 'ring-2 ring-bad',
  running: 'ring-2 ring-info animate-pulse',
  skipped: 'opacity-45',
  pinned: 'ring-2 ring-warn/70',
} as const;

/**
 * One node on the canvas.
 *
 * The same component renders the editable canvas and the read-only execution
 * view. Keeping them identical is what makes the failure view legible: you are
 * looking at the workflow you built, with outcomes painted on, not a different
 * diagram of it.
 */
export function CanvasNodeView({ data, selected }: NodeProps<CanvasNode>) {
  const { node, runStatus, pinned } = data;
  const definition = getNodeDescriptor(node.type);

  const Icon = (definition && (icons as unknown as Record<string, icons.LucideIcon>)[definition.icon]) || icons.Box;
  const outputs = definition ? resolveOutputs(definition, node.params) : [''];
  const inputs = definition?.inputs ?? 1;

  return (
    <div
      className={cx(
        'relative w-56 rounded-lg border bg-surface-2 shadow-lg transition-all',
        selected ? 'border-accent' : pinned ? 'border-warn' : 'border-line',
        node.disabled && 'opacity-50',
        runStatus && RUN_RING[runStatus],
      )}
    >
      {Array.from({ length: inputs }).map((_, index) => (
        <Handle
          key={`in-${index}`}
          type="target"
          position={Position.Left}
          id={String(index)}
          // Two-input nodes get their handles spread apart so it is obvious
          // which branch is which without hovering.
          style={inputs > 1 ? { top: spread(index, inputs) } : undefined}
          className="!size-2.5 !border-line-strong !bg-surface-3"
        />
      ))}

      <div className="flex items-center gap-2.5 px-3 py-2.5">
        <span
          className="flex size-7 shrink-0 items-center justify-center rounded-md"
          style={{ backgroundColor: `${definition?.color ?? '#64748b'}22`, color: definition?.color ?? '#64748b' }}
        >
          <Icon className="size-4" />
        </span>

        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium text-ink">{node.name}</span>
          <span className="block truncate text-[11px] text-ink-faint">
            {definition?.displayName ?? 'Unknown node'}
          </span>
        </span>

        {/* Loud on purpose. A pinned trigger is what somebody activates by
            mistake, and the runner refusing to use it there makes that
            confusing rather than damaging — the canvas should not be the
            reason for the confusion. */}
        {pinned ? (
          <Pin className="size-3.5 shrink-0 text-warn" aria-label="Output pinned" />
        ) : null}
      </div>

      {node.disabled ? (
        <div className="border-t border-line px-3 py-1 text-[11px] text-ink-faint">Disabled</div>
      ) : null}

      {pinned && !node.disabled ? (
        <div className="border-t border-warn/25 bg-warn/10 px-3 py-1 text-[11px] text-warn">
          Output pinned
        </div>
      ) : null}

      {outputs.map((label, index) => (
        <Handle
          key={`out-${index}`}
          type="source"
          position={Position.Right}
          id={String(index)}
          style={outputs.length > 1 ? { top: spread(index, outputs.length) } : undefined}
          className="!size-2.5 !border-line-strong !bg-surface-3"
        >
          {label ? (
            <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[10px] text-ink-faint">
              {label}
            </span>
          ) : null}
        </Handle>
      ))}
    </div>
  );
}

/**
 * Where the nth of `total` handles sits down the side of the node.
 *
 * Evenly spaced rather than a fixed step, so a Switch with six rules keeps every
 * handle on the node instead of walking off the bottom of it.
 */
function spread(index: number, total: number): string {
  return `${((index + 1) / (total + 1)) * 100}%`;
}
