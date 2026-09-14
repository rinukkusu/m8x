'use client';

import { Pin, PinOff } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';

import { Badge, Button, cx, formatDuration, type StatusTone } from './ui';

/**
 * What one node did, on one run.
 *
 * Shared by the execution detail view and the editor, the way the canvas node
 * is: the screen you debug on should be the screen you built on, not a second
 * rendering of it. Everything here is presentation — the pin buttons call back
 * out rather than knowing what a pin is.
 */

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

/** The pin controls, when the surface showing this panel has any. */
export interface PinControls {
  pinned: boolean;
  /** Why this node cannot be pinned, if it cannot. */
  refusal?: string | null;
  busy?: boolean;
  onPin: (nodeRunId: string) => void;
  onUnpin: () => void;
}

export function NodeRunPanel({
  run,
  isLatest,
  showAttempt,
  childExecutionIds,
  pin,
}: {
  run: NodeRunView;
  isLatest: boolean;
  showAttempt: boolean;
  childExecutionIds: string[];
  pin?: PinControls;
}) {
  const [tab, setTab] = useState<'output' | 'input'>(run.status === 'failed' ? 'input' : 'output');
  const error = run.error as
    | { errorType?: string; message?: string; stack?: string; logs?: Array<{ level: string; message: string }> }
    | null;
  const logs = error?.logs ?? [];

  return (
    <div className={cx('border-b border-line', !isLatest && 'opacity-70')}>
      <div className="flex items-center gap-2 px-4 py-2.5">
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{run.nodeName}</span>
        {run.iteration > 0 ? <span className="text-[11px] text-ink-faint">pass {run.iteration}</span> : null}
        {showAttempt ? <span className="text-[11px] text-ink-faint">attempt {run.attempt}</span> : null}
        <Badge tone={toneFor(run.status)}>{run.status}</Badge>
        <span className="text-[11px] text-ink-faint">{formatDuration(run.durationMs)}</span>
      </div>

      {run.status === 'pinned' ? (
        <p className="px-4 pb-2.5 text-xs text-warn">
          This node did not run. These are the items you pinned.
        </p>
      ) : null}

      {childExecutionIds.length > 0 ? (
        <div className="flex flex-wrap items-center gap-2 px-4 pb-2.5 text-[11px] text-ink-faint">
          <span>Ran</span>
          {childExecutionIds.map((id, index) => (
            <Link key={id} href={`/executions/${id}`} className="text-accent hover:underline">
              {childExecutionIds.length > 1 ? `run ${index + 1}` : 'the sub-workflow'}
            </Link>
          ))}
        </div>
      ) : null}

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

      <div className="flex items-center gap-1 px-4">
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

        {pin && isLatest ? <PinButton run={run} pin={pin} /> : null}
      </div>

      <ItemsView
        value={tab === 'input' ? run.input : run.output}
        truncated={tab === 'input' ? run.inputTruncated : run.outputTruncated}
      />
    </div>
  );
}

/**
 * Pinning is offered on the output of a run that happened, and only there.
 *
 * A pin is always something the workflow really produced — there is no way to
 * type one in, which is what makes a pinned run a reasonable thing to trust
 * while you build against it.
 */
function PinButton({ run, pin }: { run: NodeRunView; pin: PinControls }) {
  if (pin.pinned) {
    return (
      <Button size="sm" variant="ghost" className="ml-auto" onClick={pin.onUnpin} disabled={pin.busy}>
        <PinOff className="size-3.5" />
        Unpin
      </Button>
    );
  }

  const nothingToPin = countItems(run.output) === 0;
  const refusal =
    pin.refusal ??
    (run.status === 'pinned'
      ? 'These items came from the pin you already have.'
      : nothingToPin
        ? 'This run produced no items.'
        : run.status !== 'success'
          ? 'Only a node that ran successfully can be pinned.'
          : null);

  return (
    <Button
      size="sm"
      variant="ghost"
      className="ml-auto"
      onClick={() => pin.onPin(run.id)}
      disabled={pin.busy || refusal !== null}
      title={refusal ?? 'Replay these items instead of running this node'}
    >
      <Pin className="size-3.5" />
      Pin
    </Button>
  );
}

export function ItemsView({ value, truncated }: { value: unknown; truncated: boolean }) {
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

/** A wrapper for the "nothing selected" and "did not run" cases, so both views word them the same. */
export function PanelNotice({ children }: { children: ReactNode }) {
  return <div className="p-4 text-sm text-ink-faint">{children}</div>;
}

function countItems(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

/** `pinned` has no tone of its own; it reads as a caveat rather than an outcome. */
function toneFor(status: string): StatusTone {
  return status === 'pinned' ? 'neutral' : (status as StatusTone);
}
