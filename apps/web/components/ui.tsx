import type { ComponentProps, ReactNode } from 'react';

/**
 * The handful of primitives the rest of the app is built from. Small enough to
 * own outright, which beats pulling a component library for nine components.
 */

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

const BUTTON_VARIANTS = {
  primary: 'bg-accent text-white hover:bg-accent-soft border-transparent',
  secondary: 'bg-surface-2 text-ink hover:bg-surface-3 border-line',
  ghost: 'bg-transparent text-ink-muted hover:text-ink hover:bg-surface-2 border-transparent',
  danger: 'bg-transparent text-bad hover:bg-bad/10 border-line',
} as const;

/**
 * Heights are a thumb's business below `md` and a pointer's above it. 44px is
 * the number both Apple and the WCAG target-size rule land on, and a 28px
 * button is not a near miss on a phone — it is a button you hit by accident or
 * not at all.
 */
const BUTTON_SIZES = {
  sm: 'h-11 px-3 text-xs gap-1.5 md:h-7 md:px-2.5',
  md: 'h-11 px-4 text-sm gap-2 md:h-9 md:px-3.5',
} as const;

export function Button({
  variant = 'secondary',
  size = 'md',
  className,
  ...props
}: ComponentProps<'button'> & {
  variant?: keyof typeof BUTTON_VARIANTS;
  size?: keyof typeof BUTTON_SIZES;
}) {
  return (
    <button
      {...props}
      className={cx(
        'inline-flex items-center justify-center rounded-md border font-medium whitespace-nowrap',
        'transition-colors disabled:opacity-45 disabled:pointer-events-none',
        BUTTON_VARIANTS[variant],
        BUTTON_SIZES[size],
        className,
      )}
    />
  );
}

/**
 * The hit area for a bare icon control — a back arrow, a drawer toggle, a row
 * menu. A 16px icon is a 16px target, and padding is the only thing standing
 * between that and a miss. Desktop keeps the icon as it was.
 */
export const iconTarget = 'inline-flex size-11 items-center justify-center rounded-md md:size-auto';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      {...props}
      className={cx(
        'h-11 w-full rounded-md border border-line bg-surface-0 px-2.5 text-base text-ink',
        'md:h-9 md:text-sm',
        'placeholder:text-ink-faint focus:border-accent focus:outline-none',
        className,
      )}
    />
  );
}

export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      {...props}
      className={cx(
        'w-full rounded-md border border-line bg-surface-0 px-2.5 py-2 text-base text-ink md:text-sm',
        'placeholder:text-ink-faint focus:border-accent focus:outline-none font-mono',
        className,
      )}
    />
  );
}

export function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      {...props}
      className={cx(
        'h-11 w-full rounded-md border border-line bg-surface-0 px-2 text-base text-ink',
        'md:h-9 md:text-sm',
        'focus:border-accent focus:outline-none',
        className,
      )}
    />
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-ink-muted">{label}</span>
      {children}
      {hint ? <span className="block text-xs leading-relaxed text-ink-faint">{hint}</span> : null}
    </label>
  );
}

const STATUS_TONE = {
  success: 'text-ok bg-ok/12 border-ok/25',
  failed: 'text-bad bg-bad/12 border-bad/25',
  running: 'text-info bg-info/12 border-info/25',
  queued: 'text-ink-muted bg-surface-3 border-line',
  cancelled: 'text-ink-muted bg-surface-3 border-line',
  skipped: 'text-ink-faint bg-surface-2 border-line',
  neutral: 'text-ink-muted bg-surface-2 border-line',
} as const;

export type StatusTone = keyof typeof STATUS_TONE;

export function Badge({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: StatusTone;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-[11px] font-medium capitalize',
        STATUS_TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function StatusDot({ tone }: { tone: StatusTone }) {
  const colour =
    tone === 'success' ? 'bg-ok'
    : tone === 'failed' ? 'bg-bad'
    : tone === 'running' ? 'bg-info animate-pulse'
    : 'bg-ink-faint';
  return <span className={cx('size-1.5 shrink-0 rounded-full', colour)} />;
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-line px-6 py-14 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      <p className="max-w-md text-sm text-ink-faint">{description}</p>
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: ReactNode;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-6 py-4">
      <div className="min-w-0">
        <h1 className="truncate text-base font-semibold text-ink">{title}</h1>
        {description ? <p className="mt-0.5 text-sm text-ink-faint">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** Durations are read at a glance, so the unit changes rather than the number. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatRelative(date: Date | string | null | undefined): string {
  if (!date) return '-';
  const value = typeof date === 'string' ? new Date(date) : date;
  const seconds = Math.round((Date.now() - value.getTime()) / 1000);

  if (seconds < 45) return 'just now';
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  if (seconds < 604_800) return `${Math.round(seconds / 86_400)}d ago`;

  return value.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
