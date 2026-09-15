'use client';

import { X } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';

import { Button, Select, cx } from './ui';

/**
 * The filter bar above the executions table.
 *
 * State lives in the URL rather than in component state, so a filtered view is
 * a link. Sending someone "here is the failure I mean" should not require
 * describing which dropdowns to set.
 */
export function ExecutionFilters({ workflows }: { workflows: Array<{ id: string; name: string }> }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  function set(key: string, value: string) {
    const next = new URLSearchParams(params.toString());
    if (value === '' || value === 'all') next.delete(key);
    else next.set(key, value);
    next.delete('page');
    router.push(`${pathname}?${next.toString()}`);
  }

  const fingerprint = params.get('fingerprint');
  const active = ['status', 'workflow', 'since', 'fingerprint'].filter((key) => params.get(key));

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5 md:px-6">
      <Select
        value={params.get('status') ?? 'all'}
        onChange={(event) => set('status', event.target.value)}
        className="h-11 w-auto text-sm md:h-8 md:text-xs"
      >
        <option value="all">Any status</option>
        <option value="failed">Failed</option>
        <option value="success">Succeeded</option>
        <option value="running">Running</option>
        <option value="queued">Queued</option>
        <option value="cancelled">Cancelled</option>
      </Select>

      <Select
        value={params.get('workflow') ?? ''}
        onChange={(event) => set('workflow', event.target.value)}
        className="h-11 w-auto max-w-56 text-sm md:h-8 md:text-xs"
      >
        <option value="">Any workflow</option>
        {workflows.map((workflow) => (
          <option key={workflow.id} value={workflow.id}>
            {workflow.name}
          </option>
        ))}
      </Select>

      <Select
        value={params.get('since') ?? ''}
        onChange={(event) => set('since', event.target.value)}
        className="h-11 w-auto text-sm md:h-8 md:text-xs"
      >
        <option value="">Any time</option>
        <option value="1">Last hour</option>
        <option value="24">Last 24 hours</option>
        <option value="168">Last 7 days</option>
        <option value="720">Last 30 days</option>
      </Select>

      {fingerprint ? (
        <span className="inline-flex items-center gap-1.5 rounded border border-accent/40 bg-accent/10 px-2 py-1 text-xs text-accent-soft">
          One failure group
          <button type="button" onClick={() => set('fingerprint', '')} aria-label="Clear">
            <X className="size-3" />
          </button>
        </span>
      ) : null}

      <div className="flex-1" />

      <Button
        size="sm"
        variant="ghost"
        className={cx(active.length === 0 && 'invisible')}
        onClick={() => router.push(pathname)}
      >
        Clear filters
      </Button>
    </div>
  );
}
