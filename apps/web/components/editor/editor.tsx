'use client';

import {
  NODE_DESCRIPTORS,
  autoLayout,
  defaultParams,
  getNodeDescriptor,
  pinRefusal,
  resolveOutputs,
  resumeRefusal,
  validateGraph,
  type Graph,
  type GraphEdge,
  type GraphNode,
  type NodeDescriptor,
} from '@m8x/core';
import type { CredentialType } from '@m8x/core/server';
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
import { AlertTriangle, ArrowLeft, Copy, ExternalLink, Pin, Play, Plus, Save, Wand2 } from 'lucide-react';
import * as icons from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState, useTransition } from 'react';

import {
  duplicateWorkflowAction,
  pinNodeOutputAction,
  runStateAction,
  runWorkflowAction,
  saveGraphAction,
  setActiveAction,
  unpinNodeAction,
  type RunStateView,
} from '@/app/actions/workflows';
import type { NodeRunView } from '../node-run-panel';
import { Badge, Button, cx, formatRelative, iconTarget, type StatusTone } from '../ui';
import { CanvasNodeView, type CanvasNode } from './canvas-node';
import { Inspector, type InspectorResults } from './inspector';
import type { CredentialOption, DatatableOption } from './param-field';

const nodeTypes = { m8x: CanvasNodeView };

export interface EditorWorkflow {
  id: string;
  name: string;
  active: boolean;
  graph: Graph;
}

/** One node's pin, as the editor needs to know about it. */
export interface EditorPin {
  nodeId: string;
  truncated: boolean;
  createdAt: string;
}

export function Editor(props: {
  workflow: EditorWorkflow;
  credentials: CredentialOption[];
  credentialTypes: CredentialType[];
  datatables: DatatableOption[];
  webhookUrls: Record<string, string>;
  pins: EditorPin[];
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
  credentialTypes,
  datatables,
  webhookUrls,
  pins,
  lastExecution,
}: {
  workflow: EditorWorkflow;
  credentials: CredentialOption[];
  credentialTypes: CredentialType[];
  datatables: DatatableOption[];
  webhookUrls: Record<string, string>;
  pins: EditorPin[];
  lastExecution: { id: string; status: string; at: string } | null;
}) {
  const router = useRouter();
  const { screenToFlowPosition, fitView } = useReactFlow();

  const [nodes, setNodes, onNodesChange] = useNodesState<CanvasNode>(toCanvasNodes(workflow.graph));
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(toCanvasEdges(workflow.graph));
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [run, setRun] = useState<RunStateView | null>(null);
  const [pending, startTransition] = useTransition();

  const graph = useMemo(() => toGraph(nodes, edges), [nodes, edges]);
  const pinnedIds = useMemo(() => new Set(pins.map((entry) => entry.nodeId)), [pins]);
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

  /**
   * Follow the run while it is going.
   *
   * Polling rather than a socket, the same as the execution detail view: three
   * seconds is fine for a page nobody leaves open for hours, and it keeps the
   * two screens on one mechanism.
   */
  const runInFlight = run !== null && (run.status === 'queued' || run.status === 'running');
  const runId = run?.id ?? null;

  useEffect(() => {
    if (!runInFlight || !runId) return;
    let cancelled = false;
    // A slow answer must not stack another request behind it: a workflow that
    // makes the database crawl is exactly when this would pile up.
    let asking = false;

    const timer = setInterval(async () => {
      if (asking) return;
      asking = true;
      try {
        const next = await runStateAction(runId);
        // A run that has vanished leaves the last state on screen rather than
        // blanking it: what it did before it was pruned is still the answer.
        if (!cancelled && next) setRun(next);
      } finally {
        asking = false;
      }
    }, 3000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [runInFlight, runId]);

  /**
   * The last row per node, which is the outcome the canvas shows.
   *
   * Last by sequence rather than by attempt, so a node inside a loop paints the
   * pass that ran most recently instead of an arbitrary one.
   */
  const latestByNode = useMemo(() => {
    const map = new Map<string, NodeRunView>();
    for (const entry of run?.runs ?? []) {
      const current = map.get(entry.nodeId);
      if (!current || entry.sequence >= current.sequence) map.set(entry.nodeId, entry);
    }
    return map;
  }, [run]);

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

    // A node whose branches follow its parameters (a Switch losing a rule) can
    // leave an edge hanging off a handle that no longer exists, which renders as
    // a wire to nowhere. Drop those rather than let the canvas lie.
    if (patch.params === undefined) return;
    setEdges((current) => {
      const node = nodes.find((candidate) => candidate.id === nodeId);
      const definition = node && getNodeDescriptor(node.data.node.type);
      if (!definition) return current;
      const branches = resolveOutputs(definition, patch.params!).length;
      return current.filter((edge) => edge.source !== nodeId || Number(edge.sourceHandle ?? 0) < branches);
    });
  }

  function addNode(definition: NodeDescriptor) {
    const id = newId();
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

  /**
   * Lay the canvas out along its edges.
   *
   * Left as an unsaved change like any other drag, so Save is still the step
   * that commits it and a reload undoes a tidy nobody wanted.
   */
  function tidy() {
    const placed = autoLayout(toGraph(nodes, edges));
    setNodes((current) =>
      current.map((node) => ({ ...node, position: placed.get(node.id) ?? node.position })),
    );
    // React Flow measures on the next frame; fitting before that would frame
    // the positions the nodes are leaving.
    requestAnimationFrame(() => fitView({ padding: 0.2, duration: 300 }));
  }

  function duplicateNode(source: GraphNode) {
    const id = newId();
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
        addEdge({ ...connection, type: 'smoothstep', id: newId() }, current),
      ),
    [setEdges],
  );

  /**
   * Run, and stay here.
   *
   * Pinned data is replayed, so iterating does not re-fire the trigger and
   * everything under it. `resumeFromNodeId` starts partway down, taking that
   * node's input from the pins upstream.
   */
  function startRun(resumeFromNodeId?: string) {
    startTransition(async () => {
      setRun(null);
      const result = await runWorkflowAction(workflow.id, toGraph(nodes, edges), {
        usePinnedData: true,
        resumeFromNodeId,
      });
      if (!result.ok || !result.id) {
        setMessage({ tone: 'bad', text: result.error ?? 'The run could not start.' });
        return;
      }
      setRun(await runStateAction(result.id));
      router.refresh();
    });
  }

  function pinNode(nodeId: string, nodeRunId: string) {
    startTransition(async () => {
      const result = await pinNodeOutputAction(workflow.id, nodeId, nodeRunId);
      if (!result.ok) {
        setMessage({ tone: 'bad', text: result.error ?? 'That could not be pinned.' });
        return;
      }
      setMessage(result.error ? { tone: 'bad', text: result.error } : { tone: 'ok', text: 'Pinned.' });
      router.refresh();
    });
  }

  function unpinNode(nodeId: string) {
    startTransition(async () => {
      await unpinNodeAction(workflow.id, nodeId);
      setMessage({ tone: 'ok', text: 'Unpinned.' });
      router.refresh();
    });
  }

  /**
   * Copy this workflow and open the copy.
   *
   * Saves first when the canvas is ahead of what is stored, for the same reason
   * Run does: copying the saved graph while the screen shows something else is
   * the kind of surprise you only notice later.
   *
   * The copy is always inactive, so it cannot answer the original's schedule or
   * webhook. If its reissued path was taken in the race between minting and
   * saving, the copy's own Activate says so — which is the moment it matters.
   */
  function duplicate() {
    const go = () =>
      startTransition(async () => {
        const result = await duplicateWorkflowAction(workflow.id);
        if (!result.ok || !result.id) {
          setMessage({ tone: 'bad', text: result.error ?? 'That could not be copied.' });
          return;
        }
        router.push(`/workflows/${result.id}`);
      });

    if (dirty) save(go);
    else go();
  }

  function toggleActive() {
    startTransition(async () => {
      const result = await setActiveAction(workflow.id, !workflow.active);
      if (!result.ok) {
        setMessage({ tone: 'bad', text: result.error ?? 'That did not work.' });
        return;
      }
      // A warning rather than a failure: activating with pins left on works,
      // it just does not do what the last run in this editor did.
      if (result.error) setMessage({ tone: 'bad', text: result.error });
      router.refresh();
    });
  }

  const errors = warnings.filter((issue) => issue.level === 'error');

  return (
    <>
      <div className="flex items-center gap-3 border-b border-line px-4 py-2.5">
        <Link
          href="/workflows"
          className={cx(iconTarget, '-ml-2 text-ink-faint transition-colors hover:text-ink')}
          aria-label="Back"
        >
          <ArrowLeft className="size-4" />
        </Link>

        <span className="min-w-0 truncate text-sm font-medium">{workflow.name}</span>

        {dirty ? <Badge tone="neutral">unsaved</Badge> : null}

        <Badge tone={workflow.active ? 'success' : 'neutral'}>{workflow.active ? 'active' : 'inactive'}</Badge>

        {run ? (
          <>
            <Badge tone={run.status as StatusTone}>{run.status}</Badge>
            <Link
              href={`/executions/${run.id}`}
              className="flex items-center gap-1 text-xs text-ink-faint transition-colors hover:text-ink"
            >
              open the full run
              <ExternalLink className="size-3" />
            </Link>
          </>
        ) : lastExecution ? (
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

        <Button size="sm" onClick={tidy} disabled={pending || nodes.length === 0}>
          <Wand2 className="size-3.5" />
          Tidy up
        </Button>

        <Button size="sm" onClick={() => save()} disabled={pending || !dirty}>
          <Save className="size-3.5" />
          Save
        </Button>

        <Button size="sm" onClick={duplicate} disabled={pending}>
          <Copy className="size-3.5" />
          Duplicate
        </Button>

        <Button size="sm" onClick={toggleActive} disabled={pending}>
          {workflow.active ? 'Deactivate' : 'Activate'}
        </Button>

        <Button size="sm" variant="primary" onClick={() => startRun()} disabled={pending || errors.length > 0}>
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

      {run?.errorMessage ? (
        <button
          type="button"
          onClick={() => run.errorNodeId && setSelectedId(run.errorNodeId)}
          className="flex w-full items-start gap-2 border-b border-bad/25 bg-bad/10 px-4 py-2 text-left text-xs text-bad"
        >
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            <span className="font-medium">{run.errorNodeName ?? 'The workflow'}</span> failed with{' '}
            <code className="font-mono">{run.errorType}</code>: {run.errorMessage}
          </span>
        </button>
      ) : null}

      {pins.length > 0 ? (
        <div className="flex items-center gap-2 border-b border-warn/25 bg-warn/10 px-4 py-2 text-xs text-warn">
          <Pin className="size-3.5 shrink-0" />
          <span>
            {pins.length === 1 ? 'One node is' : `${pins.length} nodes are`} pinned. Runs started here replay
            those items; an activated workflow runs them for real.
          </span>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          <ReactFlow
            nodes={nodes.map((node) => ({
              ...node,
              selected: node.id === selectedId,
              data: {
                ...node.data,
                pinned: pinnedIds.has(node.id),
                runStatus: latestByNode.get(node.id)?.status as CanvasNode['data']['runStatus'],
              },
            }))}
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
            credentialTypes={credentialTypes}
            datatables={datatables}
            webhookUrl={webhookUrls[selected.id]}
            results={{
              runs: (run?.runs ?? [])
                .filter((entry) => entry.nodeId === selected.id)
                .sort((a, b) => b.sequence - a.sequence),
              inFlight: runInFlight,
              pin: {
                pinned: pinnedIds.has(selected.id),
                refusal: pinRefusal(graph, selected.id),
                busy: pending,
                onPin: (nodeRunId) => pinNode(selected.id, nodeRunId),
                onUnpin: () => unpinNode(selected.id),
              },
              runFromHereRefusal: resumeRefusal(graph, selected.id, pinnedIds),
              onRunFromHere: () => startRun(selected.id),
            }}
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

// `crypto.randomUUID` is only exposed in a secure context, so it is missing when
// the editor is opened over plain HTTP on a LAN address — a phone reaching the
// box by IP. Without a fallback every id call throws inside a click handler and
// the editor silently does nothing. `getRandomValues` is not gated that way.
function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();

  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function uniqueName(base: string, taken: string[]): string {
  if (!taken.includes(base)) return base;
  let counter = 2;
  while (taken.includes(`${base} ${counter}`)) counter++;
  return `${base} ${counter}`;
}
