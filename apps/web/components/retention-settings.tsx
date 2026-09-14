'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { setRetentionPolicyAction } from '@/app/actions/retention';
import { Button, Field, Input, Select, formatRelative } from './ui';

/**
 * The retention policy, and how much history there is right now.
 *
 * On Insights rather than behind a settings page of its own, because this is
 * the page someone is already on when they wonder where last month's runs went
 * — and because the alternative to showing it here is finding out from a disk
 * usage graph.
 */

export interface HistoryVolumeView {
  executions: number;
  nodeRuns: number;
  binaryBytes: number;
  oldest: string | null;
}

export interface RetentionPolicyView {
  successDays: number | null;
  failureDays: number | null;
}

export function RetentionSettings({
  policy,
  volume,
}: {
  policy: RetentionPolicyView;
  volume: HistoryVolumeView;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState(policy);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const changed = draft.successDays !== policy.successDays || draft.failureDays !== policy.failureDays;

  function save(): void {
    setError(null);
    setSaved(false);

    startTransition(async () => {
      const result = await setRetentionPolicyAction(draft);
      if (!result.ok) {
        setError(result.error ?? 'That could not be saved.');
        return;
      }
      setSaved(true);
      router.refresh();
    });
  }

  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-ink">History and retention</h2>
        <p className="mt-0.5 text-xs text-ink-faint">
          Every node run stores the items that went in and came out, so history grows for as long as it is kept.
          Runs past the ages below are deleted by the worker, oldest first, along with their node runs and stored
          files. Runs that have not finished are never deleted.
        </p>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="space-y-3 rounded-lg border border-line bg-surface-1 px-4 py-3">
          <dl className="space-y-1.5 text-sm">
            <Row label="Executions stored" value={volume.executions.toLocaleString()} />
            <Row label="Node runs stored" value={volume.nodeRuns.toLocaleString()} />
            <Row label="Stored files" value={formatBytes(volume.binaryBytes)} />
            <Row label="Oldest run" value={volume.oldest ? formatRelative(volume.oldest) : 'None yet'} />
          </dl>
        </div>

        <div className="space-y-3 rounded-lg border border-line bg-surface-1 px-4 py-3">
          <DaysField
            label="Keep successful runs for"
            hint="Successes are worth reading back for a few days, and they are most of the volume."
            value={draft.successDays}
            onChange={(successDays) => setDraft((current) => ({ ...current, successDays }))}
            disabled={pending}
          />

          <DaysField
            label="Keep failed runs for"
            hint="Failures are the ones you come back to, and there are far fewer of them. Cancelled runs are kept on this clock too."
            value={draft.failureDays}
            onChange={(failureDays) => setDraft((current) => ({ ...current, failureDays }))}
            disabled={pending}
          />

          {error ? (
            <p className="rounded-md border border-bad/25 bg-bad/10 px-3 py-2 text-xs text-bad">{error}</p>
          ) : null}

          <div className="flex items-center gap-3">
            <Button variant="primary" size="sm" onClick={save} disabled={pending || !changed}>
              {pending ? 'Saving…' : 'Save policy'}
            </Button>
            {saved && !changed ? <span className="text-xs text-ink-faint">Saved.</span> : null}
          </div>
        </div>
      </div>
    </section>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs text-ink-faint">{label}</dt>
      <dd className="font-medium text-ink">{value}</dd>
    </div>
  );
}

/**
 * A number of days, or forever.
 *
 * Two controls rather than a magic value in one, because "0 means keep
 * everything" is the kind of thing that gets typed by accident and noticed a
 * quarter later.
 */
function DaysField({
  label,
  hint,
  value,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  value: number | null;
  onChange: (value: number | null) => void;
  disabled: boolean;
}) {
  // Kept while the field is empty mid-typing, so clearing it does not snap back
  // to a number the operator is in the middle of replacing.
  const [text, setText] = useState(value === null ? '' : String(value));

  return (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <Select
          value={value === null ? 'forever' : 'days'}
          disabled={disabled}
          onChange={(event) => {
            if (event.target.value === 'forever') {
              onChange(null);
              return;
            }
            const parsed = Number(text);
            onChange(Number.isInteger(parsed) && parsed > 0 ? parsed : 7);
            if (text === '') setText('7');
          }}
          className="w-36"
        >
          <option value="days">A number of days</option>
          <option value="forever">Keep forever</option>
        </Select>

        {value !== null ? (
          <>
            <Input
              type="number"
              min={1}
              value={text}
              disabled={disabled}
              className="w-24"
              onChange={(event) => {
                setText(event.target.value);
                const parsed = Number(event.target.value);
                if (Number.isInteger(parsed) && parsed > 0) onChange(parsed);
              }}
            />
            <span className="text-xs text-ink-faint">days</span>
          </>
        ) : null}
      </div>
    </Field>
  );
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return 'None';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
