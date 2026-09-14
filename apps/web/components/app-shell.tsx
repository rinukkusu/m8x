'use client';

import { AlertTriangle, Menu, PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Button, cx } from './ui';
import { NavLink } from './nav-link';

const NAV = [
  { href: '/workflows', icon: 'Workflow', label: 'Workflows' },
  { href: '/executions', icon: 'ListChecks', label: 'Executions' },
  { href: '/insights', icon: 'ChartNoAxesColumn', label: 'Insights' },
  { href: '/datatables', icon: 'Table2', label: 'Datatables' },
  { href: '/credentials', icon: 'KeyRound', label: 'Credentials' },
] as const;

const COLLAPSE_KEY = 'm8x.sidebar.collapsed';

/**
 * The application frame.
 *
 * Two different behaviours behind one piece of state, because a phone and a
 * desktop want opposite things from a sidebar. Narrow screens get a drawer that
 * sits over the content and closes when you navigate, since there is no room to
 * give it permanently. Wide screens get a rail that collapses to icons, which
 * is what you want while dragging nodes around a canvas.
 */
export function AppShell({
  email,
  failuresToday,
  onSignOut,
  children,
}: {
  email: string;
  failuresToday: number;
  onSignOut: () => Promise<void>;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);

  // Restore the desktop preference after mount rather than during render, so
  // the server and client markup agree on the first paint.
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === '1');
    } catch {
      // Private windows and blocked site data both throw here. The default is
      // fine; this is a convenience, not state worth recovering.
    }
  }, []);

  function toggleCollapsed() {
    setCollapsed((value) => {
      const next = !value;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        // Ignore: the preference just will not survive a reload.
      }
      return next;
    });
  }

  // Navigating inside a drawer that stays open would hide the page you just
  // asked for.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setDrawerOpen(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [drawerOpen]);

  const current = NAV.find((entry) => pathname === entry.href || pathname.startsWith(`${entry.href}/`));

  return (
    <div className="flex h-dvh overflow-hidden">
      {drawerOpen ? (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setDrawerOpen(false)}
          className="fixed inset-0 z-30 bg-surface-0/70 md:hidden"
        />
      ) : null}

      <aside
        className={cx(
          'fixed inset-y-0 left-0 z-40 flex w-56 flex-col border-r border-line bg-surface-1',
          'transition-transform duration-200 md:static md:translate-x-0 md:transition-[width]',
          drawerOpen ? 'translate-x-0' : '-translate-x-full',
          collapsed ? 'md:w-14' : 'md:w-56',
        )}
      >
        <div className="flex items-center justify-between px-4 py-4">
          <Link
            href="/workflows"
            className={cx('text-base font-semibold tracking-tight', collapsed && 'md:hidden')}
          >
            m8x
          </Link>
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            className="text-ink-faint transition-colors hover:text-ink md:hidden"
            aria-label="Close menu"
          >
            <X className="size-4" />
          </button>
        </div>

        <nav className="flex-1 space-y-0.5 px-2">
          {NAV.map((entry) => (
            <NavLink
              key={entry.href}
              href={entry.href}
              icon={entry.icon}
              collapsed={collapsed}
              badge={entry.href === '/insights' ? failuresToday || undefined : undefined}
            >
              {entry.label}
            </NavLink>
          ))}
        </nav>

        {failuresToday > 0 ? (
          <Link
            href="/insights"
            title={`${failuresToday} failed runs in the last 24 hours`}
            className={cx(
              'mx-2 mb-2 flex items-start gap-2 rounded-md border border-bad/25 bg-bad/10 px-2.5 py-2 text-xs text-bad transition-colors hover:bg-bad/15',
              collapsed && 'md:justify-center md:px-0',
            )}
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span className={cx(collapsed && 'md:hidden')}>
              {failuresToday} failed {failuresToday === 1 ? 'run' : 'runs'} in the last 24 hours.
            </span>
          </Link>
        ) : null}

        <div className="border-t border-line p-2">
          <button
            type="button"
            onClick={toggleCollapsed}
            className="mb-1 hidden w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm text-ink-muted transition-colors hover:bg-surface-2 hover:text-ink md:flex"
            title={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'}
          >
            {collapsed ? (
              <PanelLeftOpen className="size-4 shrink-0" />
            ) : (
              <PanelLeftClose className="size-4 shrink-0" />
            )}
            <span className={cx(collapsed && 'hidden')}>Collapse</span>
          </button>

          <form action={onSignOut}>
            <div className={cx('truncate px-2 pb-1.5 text-xs text-ink-faint', collapsed && 'md:hidden')}>
              {email}
            </div>
            <Button
              type="submit"
              variant="ghost"
              size="sm"
              className={cx('w-full justify-start', collapsed && 'md:justify-center')}
              title="Sign out"
            >
              <span className={cx(collapsed && 'md:hidden')}>Sign out</span>
              <span className={cx('hidden', collapsed && 'md:inline')}>&#x23FB;</span>
            </Button>
          </form>
        </div>
      </aside>

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2 md:hidden">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="text-ink-muted transition-colors hover:text-ink"
            aria-label="Open menu"
          >
            <Menu className="size-5" />
          </button>
          <span className="text-sm font-semibold tracking-tight">m8x</span>
          {current ? <span className="text-sm text-ink-faint">/ {current.label}</span> : null}

          {failuresToday > 0 ? (
            <Link href="/insights" className="ml-auto rounded bg-bad/15 px-1.5 text-[11px] font-medium text-bad">
              {failuresToday}
            </Link>
          ) : null}
        </div>

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
      </main>
    </div>
  );
}
