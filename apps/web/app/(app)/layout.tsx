import { prisma } from '@m8x/core/server';

import { AppShell } from '@/components/app-shell';
import { requireUser, signOut } from '@/lib/auth';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  // A failure count in the sidebar is the cheapest possible version of the
  // whole insights feature, and it is the thing that makes people look.
  const failuresToday = await prisma.execution.count({
    where: {
      status: 'failed',
      queuedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    },
  });

  async function endSession() {
    'use server';
    await signOut();
  }

  return (
    <AppShell email={user.email} failuresToday={failuresToday} onSignOut={endSession}>
      {children}
    </AppShell>
  );
}
