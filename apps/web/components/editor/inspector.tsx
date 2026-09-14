'use client';

import { getNodeDescriptor, isParamVisible, type GraphNode } from '@m8x/core';
import type { CredentialType } from '@m8x/core/server';
import { Copy, Play, Trash2, X } from 'lucide-react';
import { useEffect, useState } from 'react';

import { NodeRunPanel, PanelNotice, type NodeRunView, type PinControls } from '../node-run-panel';
import { Button, Field, Input, cx } from '../ui';
import { ParamField, type CredentialOption, type DatatableOption } from './param-field';

/**
 * Results of the last editor run, for the node the panel is open on.
 *
 * Everything here is about one node. The editor owns the run as a whole and
 * hands down only the part this panel can act on.
 */
export interface InspectorResults {
  /** This node's rows from the last run, newest first. */
  runs: NodeRunView[];
  /** True while the run is still going, so an empty list means "not yet". */
  inFlight: boolean;
  pin: PinControls;
  /** Why this node cannot be the starting point of a run, if it cannot. */
  runFromHereRefusal: string | null;
  onRunFromHere: () => void;
}

type Tab = 'settings' | 'failure' | 'results';

/**
 * The right-hand panel.
 *
 * Its whole body comes from the node's parameter schema. The only hand-written
 * parts are the things that are not parameters: the name, the webhook URL, the
 * failure-handling settings that apply to every node, and what the node did on
 * the last run.
 */
export function Inspector({
  node,
  credentials,
  credentialTypes,
  datatables,
  webhookUrl,
  results,
  onChange,
  onDelete,
  onDuplicate,
  onClose,
}: {
  node: GraphNode;
  credentials: CredentialOption[];
  credentialTypes: CredentialType[];
  datatables: DatatableOption[];
  webhookUrl?: string;
  results?: InspectorResults;
  onChange: (patch: Partial<GraphNode>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onClose: () => void;
}) {
  const definition = getNodeDescriptor(node.type);
  const [tab, setTab] = useState<Tab>('settings');

  // A run is something you asked for and then want to look at, so land on it.
  // Only when there is something to see: flipping to an empty panel the moment
  // Run is pressed would take the settings away mid-edit for nothing.
  const hasResults = (results?.runs.length ?? 0) > 0;
  useEffect(() => {
    if (hasResults) setTab('results');
  }, [hasResults, node.id]);

  if (!definition) {
    return (
      <aside className="w-96 shrink-0 overflow-y-auto border-l border-line bg-surface-1 p-4">
        <p className="text-sm text-bad">
          This node has type <code className="font-mono">{node.type}</code>, which this version of m8x does not know
          about.
        </p>
      </aside>
    );
  }

  const visibleParams = definition.params.filter((schema) => isParamVisible(schema, node.params));

  return (
    <aside className="flex w-96 shrink-0 flex-col overflow-hidden border-l border-line bg-surface-1">
      <div className="flex items-start justify-between gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">{definition.displayName}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-ink-faint">{definition.description}</p>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
          <X className="size-3.5" />
        </Button>
      </div>

      <div className="flex gap-1 border-b border-line px-3 py-2">
        {(['settings', 'failure', ...(results ? (['results'] as const) : [])] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={cx(
              'rounded px-2.5 py-1 text-xs font-medium capitalize transition-colors',
              tab === value ? 'bg-surface-3 text-ink' : 'text-ink-faint hover:text-ink',
            )}
          >
            {value === 'failure' ? 'On failure' : value === 'results' ? 'Results' : 'Settings'}
          </button>
        ))}
      </div>

      {tab === 'results' && results ? (
        <ResultsTab node={node} results={results} />
      ) : (
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {/* Not `tab === 'settings'`: the results tab disappears when a surface
            passes no results, and a tab with nowhere to render must fall back
            to something rather than to the failure panel. */}
        {tab !== 'failure' ? (
          <>
            <Field label="Name" hint="Expressions refer to this node by name, so renaming changes them.">
              <Input value={node.name} onChange={(event) => onChange({ name: event.target.value })} />
            </Field>

            {webhookUrl ? (
              <div className="space-y-1.5 rounded-md border border-line bg-surface-0 p-2.5">
                <span className="block text-xs font-medium text-ink-muted">Webhook URL</span>
                <code className="block break-all font-mono text-[11px] text-info">{webhookUrl}</code>
                <span className="block text-xs text-ink-faint">
                  Live only while the workflow is active.
                </span>
              </div>
            ) : null}

            {visibleParams.map((schema) => (
              <ParamField
                key={schema.name}
                schema={schema}
                value={node.params[schema.name] ?? schema.default}
                credentials={credentials}
                credentialTypes={credentialTypes}
                datatables={datatables}
                siblings={node.params}
                onChange={(value) => onChange({ params: { ...node.params, [schema.name]: value } })}
              />
            ))}

            {visibleParams.length === 0 ? (
              <p className="text-xs text-ink-faint">This node has nothing to configure.</p>
            ) : null}
          </>
        ) : (
          <>
            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={node.continueOnFail === true}
                onChange={(event) => onChange({ continueOnFail: event.target.checked })}
                className="mt-0.5 size-4 accent-[var(--color-accent)]"
              />
              <span>
                <span className="block text-xs font-medium text-ink">Carry on if this node fails</span>
                <span className="block text-xs leading-relaxed text-ink-faint">
                  Downstream nodes receive one item holding the error instead of the run stopping.
                </span>
              </span>
            </label>

            <Field
              label="Retries"
              hint="Only failures that could be transient are retried. A bad URL or a syntax error fails immediately."
            >
              <Input
                type="number"
                min={0}
                max={10}
                value={String(node.retries ?? definition.defaultRetries ?? 0)}
                onChange={(event) => onChange({ retries: Math.max(0, Number(event.target.value) || 0) })}
              />
            </Field>

            <Field label="Backoff (ms)" hint="Doubled after each attempt.">
              <Input
                type="number"
                min={0}
                step={500}
                value={String(node.retryBackoffMs ?? 1000)}
                onChange={(event) => onChange({ retryBackoffMs: Math.max(0, Number(event.target.value) || 0) })}
              />
            </Field>

            <label className="flex cursor-pointer items-start gap-2.5">
              <input
                type="checkbox"
                checked={node.disabled === true}
                onChange={(event) => onChange({ disabled: event.target.checked })}
                className="mt-0.5 size-4 accent-[var(--color-accent)]"
              />
              <span>
                <span className="block text-xs font-medium text-ink">Disable this node</span>
                <span className="block text-xs leading-relaxed text-ink-faint">
                  Items pass straight through it, so the rest of the workflow still runs.
                </span>
              </span>
            </label>
          </>
        )}
      </div>
      )}

      <div className="flex gap-2 border-t border-line p-3">
        <Button size="sm" variant="secondary" onClick={onDuplicate} className="flex-1">
          <Copy className="size-3.5" />
          Duplicate
        </Button>
        <Button size="sm" variant="danger" onClick={onDelete} className="flex-1">
          <Trash2 className="size-3.5" />
          Delete
        </Button>
      </div>
    </aside>
  );
}

/**
 * What this node did on the last run started from the editor.
 *
 * The same panel the execution detail view uses, plus the two things only the
 * editor can offer: freezing this output, and starting the next run here.
 */
function ResultsTab({ node, results }: { node: GraphNode; results: InspectorResults }) {
  const { runs, inFlight, pin, runFromHereRefusal, onRunFromHere } = results;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="border-b border-line p-3">
        <Button
          size="sm"
          variant="secondary"
          className="w-full"
          onClick={onRunFromHere}
          disabled={pin.busy || runFromHereRefusal !== null}
          title={runFromHereRefusal ?? 'Run from this node, taking its input from the pins upstream'}
        >
          <Play className="size-3.5" />
          Run from here
        </Button>
        {runFromHereRefusal ? (
          <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">{runFromHereRefusal}</p>
        ) : null}
      </div>

      {runs.length === 0 ? (
        <PanelNotice>
          {inFlight
            ? 'The run has not reached this node yet.'
            : pin.pinned
              ? 'This node is pinned. Run the workflow to see the items it replays.'
              : 'Run the workflow to see what goes in and what comes out of this node.'}
        </PanelNotice>
      ) : (
        runs.map((run, index) => (
          <NodeRunPanel
            key={run.id}
            run={run}
            isLatest={index === 0}
            showAttempt={runs.some((candidate) => candidate.attempt > 1)}
            childExecutionIds={[]}
            pin={pin}
          />
        ))
      )}

      {pin.pinned ? (
        <p className="px-4 py-3 text-[11px] leading-relaxed text-warn">
          {node.name} is pinned. Runs started from this editor replay these items instead of running it; an
          activated workflow ignores the pin and runs it for real.
        </p>
      ) : null}
    </div>
  );
}
