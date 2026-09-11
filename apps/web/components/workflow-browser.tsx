'use client';

import type { FolderNode } from '@m8x/core/server';
import {
  ChevronDown,
  ChevronRight,
  Folder,
  FolderPlus,
  Inbox,
  MoreHorizontal,
  Plus,
  Workflow as WorkflowIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useTransition } from 'react';

import {
  createFolderAction,
  createWorkflowAction,
  deleteFolderAction,
  deleteWorkflowAction,
  moveFolderAction,
  moveWorkflowAction,
  renameFolderAction,
  renameWorkflowAction,
} from '@/app/actions/workflows';
import { Badge, Button, EmptyState, PageHeader, cx, formatRelative, type StatusTone } from './ui';

export interface WorkflowRow {
  id: string;
  name: string;
  folderId: string | null;
  active: boolean;
  updatedAt: string;
  lastRun: { status: string; at: string; durationMs: number | null } | null;
}

const ROOT = '__root__';

/**
 * The folder tree and the workflow list.
 *
 * Drag and drop uses the native HTML5 API rather than a library. The
 * interaction is one drag type onto one drop target, and a drag-and-drop
 * library would be more code than the feature.
 */
export function WorkflowBrowser({
  tree,
  workflows,
  selectedFolderId,
}: {
  tree: FolderNode[];
  workflows: WorkflowRow[];
  selectedFolderId: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  const folderNames = useMemo(() => flattenNames(tree), [tree]);
  const selectedName = selectedFolderId ? folderNames.get(selectedFolderId) : null;

  const visible = useMemo(
    () => workflows.filter((workflow) => (workflow.folderId ?? null) === selectedFolderId),
    [workflows, selectedFolderId],
  );

  function apply(run: () => Promise<{ ok: boolean; error?: string; id?: string }>, onDone?: (id?: string) => void) {
    setError(null);
    startTransition(async () => {
      const result = await run();
      if (!result.ok) {
        setError(result.error ?? 'That did not work.');
        return;
      }
      onDone?.(result.id);
      router.refresh();
    });
  }

  function select(folderId: string | null) {
    router.push(folderId ? `/workflows?folder=${folderId}` : '/workflows');
  }

  function handleDrop(targetFolderId: string | null, event: React.DragEvent) {
    event.preventDefault();
    setDragOver(null);

    const workflowId = event.dataTransfer.getData('application/x-m8x-workflow');
    if (workflowId) {
      apply(() => moveWorkflowAction(workflowId, targetFolderId));
      return;
    }

    const folderId = event.dataTransfer.getData('application/x-m8x-folder');
    if (folderId && folderId !== targetFolderId) {
      apply(() => moveFolderAction(folderId, targetFolderId));
    }
  }

  return (
    <>
      <PageHeader
        title={selectedName ?? 'All workflows'}
        description={
          selectedFolderId
            ? `${visible.length} ${visible.length === 1 ? 'workflow' : 'workflows'} in this folder.`
            : 'Workflows that are not in a folder.'
        }
        actions={
          <>
            <Button
              size="sm"
              disabled={pending}
              onClick={() => {
                const name = window.prompt('Folder name');
                if (name) apply(() => createFolderAction(name, selectedFolderId));
              }}
            >
              <FolderPlus className="size-3.5" />
              New folder
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={pending}
              onClick={() =>
                apply(
                  () => createWorkflowAction('Untitled workflow', selectedFolderId),
                  (id) => id && router.push(`/workflows/${id}`),
                )
              }
            >
              <Plus className="size-3.5" />
              New workflow
            </Button>
          </>
        }
      />

      {error ? (
        <div className="border-b border-bad/25 bg-bad/10 px-6 py-2 text-xs text-bad">{error}</div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        <div className="w-40 shrink-0 overflow-y-auto border-r border-line p-2 md:w-60">
          <FolderRow
            label="Unfiled"
            icon={Inbox}
            count={workflows.filter((workflow) => !workflow.folderId).length}
            depth={0}
            active={selectedFolderId === null}
            dragOver={dragOver === ROOT}
            onSelect={() => select(null)}
            onDragOver={(event) => {
              event.preventDefault();
              setDragOver(ROOT);
            }}
            onDragLeave={() => setDragOver(null)}
            onDrop={(event) => handleDrop(null, event)}
          />

          <div className="mt-2 space-y-0.5">
            {tree.map((node) => (
              <FolderBranch
                key={node.id}
                node={node}
                depth={0}
                selectedFolderId={selectedFolderId}
                dragOver={dragOver}
                setDragOver={setDragOver}
                onSelect={select}
                onDrop={handleDrop}
                onRename={(id, name) => apply(() => renameFolderAction(id, name))}
                onDelete={(id) => apply(() => deleteFolderAction(id), () => select(null))}
              />
            ))}
          </div>

          {tree.length === 0 ? (
            <p className="px-2 py-3 text-xs leading-relaxed text-ink-faint">
              No folders yet. Create one, then drag workflows into it.
            </p>
          ) : null}
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto p-4 md:p-6">
          {visible.length === 0 ? (
            <EmptyState
              title="Nothing here yet"
              description={
                selectedFolderId
                  ? 'Drag a workflow onto this folder, or create one inside it.'
                  : 'Create a workflow to get started. It opens on a canvas with a manual trigger ready to run.'
              }
              action={
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() =>
                    apply(
                      () => createWorkflowAction('Untitled workflow', selectedFolderId),
                      (id) => id && router.push(`/workflows/${id}`),
                    )
                  }
                >
                  <Plus className="size-3.5" />
                  New workflow
                </Button>
              }
            />
          ) : (
            <ul className="space-y-1.5">
              {visible.map((workflow) => (
                <li key={workflow.id}>
                  <WorkflowCard
                    workflow={workflow}
                    onRename={(name) => apply(() => renameWorkflowAction(workflow.id, name))}
                    onDelete={() => apply(() => deleteWorkflowAction(workflow.id))}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}

function FolderBranch({
  node,
  depth,
  selectedFolderId,
  dragOver,
  setDragOver,
  onSelect,
  onDrop,
  onRename,
  onDelete,
}: {
  node: FolderNode;
  depth: number;
  selectedFolderId: string | null;
  dragOver: string | null;
  setDragOver: (id: string | null) => void;
  onSelect: (id: string | null) => void;
  onDrop: (folderId: string | null, event: React.DragEvent) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(true);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <FolderRow
        label={node.name}
        icon={Folder}
        count={node.workflowCount}
        depth={depth}
        active={selectedFolderId === node.id}
        dragOver={dragOver === node.id}
        expandable={hasChildren}
        expanded={open}
        onToggle={() => setOpen((value) => !value)}
        onSelect={() => onSelect(node.id)}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData('application/x-m8x-folder', node.id);
          event.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(node.id);
        }}
        onDragLeave={() => setDragOver(null)}
        onDrop={(event) => onDrop(node.id, event)}
        onRename={() => {
          const name = window.prompt('Rename folder', node.name);
          if (name) onRename(node.id, name);
        }}
        onDelete={() => {
          if (window.confirm(`Delete "${node.name}"? Its workflows will move to Unfiled.`)) {
            onDelete(node.id);
          }
        }}
      />

      {open && hasChildren ? (
        <div className="space-y-0.5">
          {node.children.map((child) => (
            <FolderBranch
              key={child.id}
              node={child}
              depth={depth + 1}
              selectedFolderId={selectedFolderId}
              dragOver={dragOver}
              setDragOver={setDragOver}
              onSelect={onSelect}
              onDrop={onDrop}
              onRename={onRename}
              onDelete={onDelete}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function FolderRow({
  label,
  icon: Icon,
  count,
  depth,
  active,
  dragOver,
  expandable,
  expanded,
  onToggle,
  onSelect,
  onRename,
  onDelete,
  ...dragProps
}: {
  label: string;
  icon: typeof Folder;
  count: number;
  depth: number;
  active: boolean;
  dragOver: boolean;
  expandable?: boolean;
  expanded?: boolean;
  onToggle?: () => void;
  onSelect: () => void;
  onRename?: () => void;
  onDelete?: () => void;
} & React.HTMLAttributes<HTMLDivElement> & { draggable?: boolean }) {
  return (
    <div
      {...dragProps}
      onClick={onSelect}
      className={cx(
        'group flex cursor-pointer items-center gap-1 rounded-md py-1.5 pr-1.5 text-sm transition-colors',
        active ? 'bg-surface-3 text-ink' : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
        dragOver && 'ring-1 ring-accent',
      )}
      style={{ paddingLeft: `${depth * 12 + 8}px` }}
    >
      {expandable ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onToggle?.();
          }}
          className="shrink-0 text-ink-faint hover:text-ink"
        >
          {expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
      ) : (
        <span className="w-3.5 shrink-0" />
      )}

      <Icon className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>

      {count > 0 ? <span className="shrink-0 text-[11px] text-ink-faint">{count}</span> : null}

      {onRename ? (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            const choice = window.prompt('Type "rename" or "delete"', 'rename');
            if (choice === 'rename') onRename();
            else if (choice === 'delete') onDelete?.();
          }}
          className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
          aria-label={`Options for ${label}`}
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

function WorkflowCard({
  workflow,
  onRename,
  onDelete,
}: {
  workflow: WorkflowRow;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  return (
    <div
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData('application/x-m8x-workflow', workflow.id);
        event.dataTransfer.effectAllowed = 'move';
      }}
      className="group flex items-center gap-3 rounded-lg border border-line bg-surface-1 px-3.5 py-3 transition-colors hover:border-line-strong"
    >
      <WorkflowIcon className="size-4 shrink-0 text-ink-faint" />

      <Link href={`/workflows/${workflow.id}`} className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink">{workflow.name}</span>
        <span className="mt-0.5 block text-xs text-ink-faint">
          Edited {formatRelative(workflow.updatedAt)}
          {workflow.lastRun ? ` · last run ${formatRelative(workflow.lastRun.at)}` : ' · never run'}
        </span>
      </Link>

      {workflow.lastRun ? (
        <Badge tone={workflow.lastRun.status as StatusTone}>{workflow.lastRun.status}</Badge>
      ) : null}

      <Badge tone={workflow.active ? 'success' : 'neutral'}>{workflow.active ? 'active' : 'inactive'}</Badge>

      <button
        type="button"
        onClick={() => {
          const choice = window.prompt('Type "rename" or "delete"', 'rename');
          if (choice === 'rename') {
            const name = window.prompt('Rename workflow', workflow.name);
            if (name) onRename(name);
          } else if (choice === 'delete') {
            if (window.confirm(`Delete "${workflow.name}"? Its run history goes too.`)) onDelete();
          }
        }}
        className="shrink-0 text-ink-faint opacity-0 transition-opacity hover:text-ink group-hover:opacity-100"
        aria-label={`Options for ${workflow.name}`}
      >
        <MoreHorizontal className="size-4" />
      </button>
    </div>
  );
}

function flattenNames(nodes: FolderNode[], into = new Map<string, string>()): Map<string, string> {
  for (const node of nodes) {
    into.set(node.id, node.name);
    flattenNames(node.children, into);
  }
  return into;
}
