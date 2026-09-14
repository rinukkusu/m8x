'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { setRetentionPolicyAction } from '@/app/actions/retention';
import { Button, Field, Input, Select } from './ui';

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
  diskBytes: number;
  /** ISO, or null on an instance that has never run anything. */
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
  // What is in the boxes, as typed. Parsing on the way in would mean a field
  // cleared mid-edit silently kept the old number, and saving the other field
  // would then write something other than what is on screen.
  const [draft, setDraft] = useState<Draft>(() => ({
    successDays: asText(policy.successDays),
    failureDays: asText(policy.failureDays),
  }));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const parsed = {
    successDays: parseDays(draft.successDays),
    failureDays: parseDays(draft.failureDays),
  };
  const valid = parsed.successDays !== 'invalid' && parsed.failureDays !== 'invalid';
  const changed =
    valid &&
    (parsed.successDays !== policy.successDays || parsed.failureDays !== policy.failureDays);

  function save(): void {
    if (!valid) return;
    setError(null);
    setSaved(false);

    startTransition(async () => {
      const result = await setRetentionPolicyAction({
        successDays: parsed.successDays as number | null,
        failureDays: parsed.failureDays as number | null,
      });
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
            <Row label="On disk" value={formatBytes(volume.diskBytes)} />
            {/* The date in full. A relative one loses the year, and "Sep 3"
                for a run from two years ago is the opposite of the point. */}
            <Row label="Oldest run" value={volume.oldest ? volume.oldest.slice(0, 10) : 'None yet'} />
          </dl>

          <p className="text-xs text-ink-faint">
            Row counts are estimates. Counting them exactly means reading every row, which is slow on exactly the
            instance this setting is for.
          </p>
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

          {!valid ? (
            <p className="text-xs text-ink-faint">Both ages need a whole number of days, at least one.</p>
          ) : null}

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
 *
 * The text is handed straight up as typed. Nothing is parsed here: the only
 * place a number is read out of these boxes is the moment of saving, so what is
 * on screen and what gets written cannot come apart.
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
  /** The typed text, or null for "keep forever". */
  value: string | null;
  onChange: (value: string | null) => void;
  disabled: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <Select
          value={value === null ? 'forever' : 'days'}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value === 'forever' ? null : '7')}
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
              value={value}
              disabled={disabled}
              className="w-24"
              onChange={(event) => onChange(event.target.value)}
            />
            <span className="text-xs text-ink-faint">days</span>
          </>
        ) : null}
      </div>
    </Field>
  );
}

/** What is in the two boxes: the text as typed, or null for "keep forever". */
interface Draft {
  successDays: string | null;
  failureDays: string | null;
}

function asText(days: number | null): string | null {
  return days === null ? null : String(days);
}

/**
 * A typed age as it will be sent, or `invalid` while it is not a usable number.
 *
 * Only the shape is checked here, so the box can say something before a round
 * trip. The range is core's to rule on — it is the side that has to agree with
 * the job doing the deleting.
 */
function parseDays(text: string | null): number | null | 'invalid' {
  if (text === null) return null;
  if (text.trim() === '') return 'invalid';
  const parsed = Number(text);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 'invalid';
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
