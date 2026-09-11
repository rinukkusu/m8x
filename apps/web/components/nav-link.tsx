'use client';

import * as icons from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { cx } from './ui';

/**
 * The icon arrives as a name rather than a component, because a server
 * component cannot hand a function across to a client one. The lookup happens
 * here, on the client, where the module is already in the bundle.
 */
export function NavLink({
  href,
  icon,
  badge,
  collapsed,
  children,
}: {
  href: string;
  icon: string;
  badge?: number;
  /** Icons only, on desktop. The drawer always shows labels. */
  collapsed?: boolean;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const active = pathname === href || pathname.startsWith(`${href}/`);
  const Icon = (icons as unknown as Record<string, icons.LucideIcon>)[icon] ?? icons.Box;
  const label = typeof children === 'string' ? children : undefined;

  return (
    <Link
      href={href}
      title={label}
      className={cx(
        'relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors',
        active ? 'bg-surface-3 text-ink' : 'text-ink-muted hover:bg-surface-2 hover:text-ink',
        collapsed && 'md:justify-center md:px-0',
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className={cx('flex-1 truncate', collapsed && 'md:hidden')}>{children}</span>

      {badge ? (
        <>
          <span className={cx('rounded bg-bad/15 px-1.5 text-[11px] font-medium text-bad', collapsed && 'md:hidden')}>
            {badge}
          </span>
          {/* Collapsed to icons there is no room for a count, so the badge
              becomes a dot that still says "something needs attention". */}
          {collapsed ? (
            <span className="absolute right-2 top-1.5 hidden size-1.5 rounded-full bg-bad md:block" />
          ) : null}
        </>
      ) : null}
    </Link>
  );
}
