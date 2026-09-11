'use client';

import {
  NODE_DESCRIPTORS,
  defaultParams,
  validateGraph,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type NodeDescriptor,
} from '@m8x/core';
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
} from '@xyflow/react';
import { AlertTriangle, ArrowLeft, Play, Plus, Save } from 'lucide-react';
import * as icons from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';

import { runWorkflowAction, saveGraphAction, setActiveAction } from '@/app/actions/workflows';
import { Badge, Button, cx, formatRelative } from '../ui';
import { CanvasNodeView, type CanvasNode } from './canvas-node';
import { Inspector } from './inspector';
import type { CredentialOption } from './param-field';

const nodeTypes = { m8x: CanvasNodeView };

export interface EditorWorkflow {
  id: string;
  name: string;
  active: boolean;
  graph: Graph;
}

export function Editor(props: {
  workflow: EditorWorkflow;
  credentials: CredentialOption[];
  webhookUrls: Record<string, string>;
  lastExecution: { id: string; status: string; at: string } | null;
}) {
  return (
    <ReactFlowProvider>
      <EditorInner {...props} />
    </ReactFlowProvider>
  );
}

function EditorInner({
  workflow,
  credentials,
  webhookUrls,
  lastExecution,
}: {
  workflow: EditorWorkflow;
  credentials: CredentialOption[];
  webhookUrls: Record<string, string>;
  lastExecution: { id: string; status: string; at: string } | null;
}) {
  const router = useRouter();
  const { screenToFlowPosition } = useReactFlow();

  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>(toCanvasNodes(workflow.graph));
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(toCanvasEdges(workflow.graph));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const graph = useMemo(() => toGraph(nodes, edges), [nodes, edges]);
  const warnings = useMemo(() => validateGraph(graph), [graph]);
  const selected = nodes.find((node) => node.id === selectedId)?.data.node ?? null;

  /**
   * Unsaved state is derived by comparing the graph to what was loaded, rather
   * than tracked with a flag. React Flow emits change events of its own during
   * mount, when it measures nodes and runs fitView, and a flag would read those
   * as edits and show "unsaved" on a workflow nobody has touched.
   */
  const savedSignature = useMemo(() => signature(workflow.graph), [workflow.graph]);
  const dirty = signature(graph) !== savedSignature;

  const save = useCallback(
    (then?: () => void) => {
      startTransition(async () => {
        const result = await saveGraphAction(workflow.id, toGraph(nodes, edges));
        if (!result.ok) {
          setMessage({ tone: 'bad', text: result.error ?? 'Saving failed.' });
          return;
        }
        setMessage(result.error ? { tone: 'bad', text: result.error } : { tone: 'ok', text: 'Saved.' });
        then?.();
        router.refresh();
      });
    },
    [workflow.id, nodes, edges, router],
  );

  // Ctrl+S, because everyone tries it and losing an hour of canvas work to a
  // stray refresh is the fastest way to make someone distrust the tool.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        save();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [save]);

  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(null), 4000);
    return () => clearTimeout(timer);
  }, [message]);

  useEffect(() => {
    if (!dirty) return;
    function warn(event: BeforeUnloadEvent) {
      event.preventDefault();
    }
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  function patchNode(nodeId: string, patch: Partial<GraphNode>) {
    setNodes((current) =>
      current.map((node) =>
        node.id === nodeId ? { ...node, data: { ...node.data, node: { ...node.data.node, ...patch } } } : node,
      ),
    );
  }

  function addNode(definition: NodeDescriptor) {
    const id = crypto.randomUUID();
    // Drop it in the middle of what the user is currently looking at, not at
    // the origin, which may be off screen after panning.
    const position = screenToFlowPosition({
      x: window.innerWidth / 2 - 120,
      y: window.innerHeight / 2 - 60,
    });

    setNodes((current) => [
      ...current,
      {
        id,
        type: 'm8x',
        position,
        data: {
          node: {
            id,
            type: definition.type,
            name: uniqueName(definition.displayName, current.map((node) => node.data.node.name)),
            position,
            params: defaultParams(definition),
          },
        },
      },
    ]);

    setSelectedId(id);
    setPaletteOpen(false);
  }

  function duplicateNode(source: GraphNode) {
    const id = crypto.randomUUID();
    const position = { x: source.position.x + 60, y: source.position.y + 60 };

    setNodes((current) => [
      ...current,
      {
        id,
        type: 'm8x',
        position,
        data: {
          node: {
            ...structuredClone(source),
            id,
            position,
            name: uniqueName(source.name, current.map((node) => node.data.node.name)),
          },
        },
      },
    ]);
    setSelectedId(id);
  }

  function removeNode(nodeId: string) {
    setNodes((current) => current.filter((node) => node.id !== nodeId));
    setEdges((current) => current.filter((edge) => edge.source !== nodeId && edge.target !== nodeId));
    setSelectedId(null);
  }

  const onConnect = useCallback(
    (connection: Connection) =>
      setEdges((current) =>
        addEdge({ ...connection, type: 'smoothstep', id: crypto.randomUUID() }, current),
      ),
    [setEdges],
  );

  function run() {
    startTransition(async () => {
      const result = await runWorkflowAction(workflow.id, toGraph(nodes, edges));
      if (!result.ok) {
        setMessage({ tone: 'bad', text: result.error ?? 'The run could not start.' });
        return;
      }
      router.push(`/executions/${result.id}`);
    });
  }

  function toggleActive() {
    startTransition(async () => {
      const result = await setActiveAction(workflow.id, !workflow.active);
      if (!result.ok) {
        setMessage({ tone: 'bad', text: result.error ?? 'That did not work.' });
        return;
      }
      router.refresh();
    });
  }

  const errors = warnings.filter((issue) => issue.level === 'error');

  return (
    <>
      <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
        <Link href="/workflows" className="text-ink-faint transition-colors hover:text-ink" aria-label="Back">
          <ArrowLeft className="size-4" />
        </Link>

        <span className="min-w-0 truncate text-sm font-medium">{workflow.name}</span>

        {dirty ? <Badge tone="neutral">unsaved</Badge> : null}

        <Badge tone={workflow.active ? 'success' : 'neutral'}>{workflow.active ? 'active' : 'inactive'}</Badge>

        {lastExecution ? (
          <Link
            href={`/executions/${lastExecution.id}`}
            className="truncate text-xs text-ink-faint transition-colors hover:text-ink"
          >
            last run {lastExecution.status} {formatRelative(lastExecution.at)}
          </Link>
        ) : null}

        <div className="flex-1" />

        {message ? (
          <span className={cx('text-xs', message.tone === 'ok' ? 'text-ok' : 'text-bad')}>{message.text}</span>
        ) : null}

        <Button size="sm" onClick={() => setPaletteOpen(true)} disabled={pending}>
          <Plus className="size-3.5" />
          Add node
        </Button>

        <Button size="sm" onClick={() => save()} disabled={pending || !dirty}>
          <Save className="size-3.5" />
          Save
        </Button>

        <Button size="sm" onClick={toggleActive} disabled={pending}>
          {workflow.active ? 'Deactivate' : 'Activate'}
        </Button>

        <Button size="sm" variant="primary" onClick={run} disabled={pending || errors.length > 0}>
          <Play className="size-3.5" />
          Run
        </Button>
      </div>

      {errors.length > 0 ? (
        <div className="flex items-center gap-2 border-b border-bad/25 bg-bad/10 px-4 py-2 text-xs text-bad">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span>{errors[0]!.message}</span>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <ReactFlow
            nodes={nodes.map((node) => ({ ...node, selected: node.id === selectedId }))}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeClick={(_, node) => setSelectedId(node.id)}
            onPaneClick={() => setSelectedId(null)}
            nodeTypes={nodeTypes}
            defaultEdgeOptions={{ type: 'smoothstep' }}
            fitView
            proOptions={{ hideAttribution: true }}
            deleteKeyCode={['Backspace', 'Delete']}
          >
            <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#2a3040" />
            <Controls showInteractive={false} />
          </ReactFlow>

          {paletteOpen ? <Palette onPick={addNode} onClose={() => setPaletteOpen(false)} /> : null}
        </div>

        {selected ? (
          <Inspector
            node={selected}
            credentials={credentials}
            webhookUrl={webhookUrls[selected.id]}
            onChange={(patch) => patchNode(selected.id, patch)}
            onDelete={() => removeNode(selected.id)}
            onDuplicate={() => duplicateNode(selected)}
            onClose={() => setSelectedId(null)}
          />
        ) : null}
      </div>
    </>
  );
}

function Palette({ onPick, onClose }: { onPick: (definition: NodeDescriptor) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = NODE_DESCRIPTORS.filter(
      (definition) =>
        needle === '' ||
        definition.displayName.toLowerCase().includes(needle) ||
        definition.description.toLowerCase().includes(needle),
    );

    return (['trigger', 'action', 'flow'] as const)
      .map((group) => ({ group, items: matches.filter((definition) => definition.group === group) }))
      .filter((entry) => entry.items.length > 0);
  }, [query]);

  return (
    <div className="absolute inset-0 z-10 flex items-start justify-center bg-surface-0/70 pt-20" onClick={onClose}>
      <div
        className="card w-full max-w-md overflow-hidden shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search nodes"
          className="w-full border-b border-line bg-transparent px-4 py-3 text-sm text-ink placeholder:text-ink-faint focus:outline-none"
        />

        <div className="max-h-96 overflow-y-auto p-2">
          {groups.map((entry) => (
            <div key={entry.group} className="mb-2">
              <p className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
                {entry.group}
              </p>
              {entry.items.map((definition) => {
                const Icon =
                  (icons as unknown as Record<string, icons.LucideIcon>)[definition.icon] ?? icons.Box;
                return (
                  <button
                    key={definition.type}
                    type="button"
                    onClick={() => onPick(definition)}
                    className="flex w-full items-start gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-surface-2"
                  >
                    <span
                      className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md"
                      style={{ backgroundColor: `${definition.color}22`, color: definition.color }}
                    >
                      <Icon className="size-4" />
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm text-ink">{definition.displayName}</span>
                      <span className="block text-xs leading-relaxed text-ink-faint">{definition.description}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ))}

          {groups.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-ink-faint">Nothing matches that.</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Graph conversion
// ---------------------------------------------------------------------------

function toCanvasNodes(graph: Graph): CanvasNode[] {
  return graph.nodes.map((node) => ({
    id: node.id,
    type: 'm8x' as const,
    position: node.position,
    data: { node },
  }));
}

function toCanvasEdges(graph: Graph): Edge[] {
  return graph.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: String(edge.sourceOutput),
    targetHandle: String(edge.targetInput),
    type: 'smoothstep',
  }));
}

export function toGraph(nodes: CanvasNode[], edges: Edge[]): Graph {
  return {
    // The canvas owns positions while editing, so they are read back from the
    // React Flow node rather than from the stored graph node.
    nodes: nodes.map((node) => ({ ...node.data.node, position: node.position })),
    edges: edges.map(
      (edge): GraphEdge => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceOutput: Number(edge.sourceHandle ?? 0),
        targetInput: Number(edge.targetHandle ?? 0),
      }),
    ),
  };
}

/**
 * A stable string for comparing two graphs. Key order and the exact shape of
 * an unset optional differ between what the database returns and what the
 * canvas builds, so both sides are normalised before comparing.
 */
function signature(graph: Graph): string {
  return JSON.stringify({
    nodes: [...graph.nodes]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((node) => [
        node.id,
        node.type,
        node.name,
        Math.round(node.position.x),
        Math.round(node.position.y),
        node.params,
        node.disabled ?? false,
        node.continueOnFail ?? false,
        node.retries ?? null,
        node.retryBackoffMs ?? null,
      ]),
    edges: [...graph.edges]
      .map((edge) => [edge.source, edge.sourceOutput, edge.target, edge.targetInput].join(':'))
      .sort(),
  });
}

function uniqueName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  let counter = 2;
  while (taken.includes(`${base} ${counter}`)) counter++;
  return `${base} ${counter}`;
}
