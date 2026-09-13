'use client';

import { getNodeDescriptor, isParamVisible, type GraphNode } from '@m8x/core';
import type { CredentialType } from '@m8x/core/server';
import { Copy, Trash2, X } from 'lucide-react';
import { useState } from 'react';

import { Button, Field, Input, cx } from '../ui';
import { ParamField, type CredentialOption } from './param-field';

/**
 * The right-hand panel.
 *
 * Its whole body comes from the node's parameter schema. The only hand-written
 * parts are the things that are not parameters: the name, the webhook URL, and
 * the failure-handling settings that apply to every node.
 */
export function Inspector({
  node,
  credentials,
  credentialTypes,
  webhookUrl,
  onChange,
  onDelete,
  onDuplicate,
  onClose,
}: {
  node: GraphNode;
  credentials: CredentialOption[];
  credentialTypes: CredentialType[];
  webhookUrl?: string;
  onChange: (patch: Partial<GraphNode>) => void;
  onDelete: () => void;
  onDuplicate: () => void;
  onClose: () => void;
}) {
  const definition = getNodeDescriptor(node.type);
  const [tab, setTab] = useState<'settings' | 'failure'>('settings');

  if (!definition) {
    return (
      <aside className="w-80 shrink-0 overflow-y-auto border-l border-line bg-surface-1 p-4">
        <p className="text-sm text-bad">
          This node has type <code className="font-mono">{node.type}</code>, which this version of m8x does not know
          about.
        </p>
      </aside>
    );
  }

  const visibleParams = definition.params.filter((schema) => isParamVisible(schema, node.params));

  return (
    <aside className="flex w-80 shrink-0 flex-col overflow-hidden border-l border-line bg-surface-1">
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
        {(['settings', 'failure'] as const).map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={cx(
              'rounded px-2.5 py-1 text-xs font-medium capitalize transition-colors',
              tab === value ? 'bg-surface-3 text-ink' : 'text-ink-faint hover:text-ink',
            )}
          >
            {value === 'failure' ? 'On failure' : 'Settings'}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
        {tab === 'settings' ? (
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
