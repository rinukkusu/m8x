import { redirect } from 'next/navigation';

import { Button, Field, Input } from '@/components/ui';
import { currentUser, signIn } from '@/lib/auth';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  if (await currentUser()) redirect('/workflows');

  const { error } = await searchParams;

  async function attempt(formData: FormData) {
    'use server';

    const email = String(formData.get('email') ?? '');
    const password = String(formData.get('password') ?? '');

    const user = await signIn(email, password);
    // The message stays vague on purpose: saying which half was wrong turns the
    // form into an account-enumeration tool.
    if (!user) redirect('/login?error=1');
    redirect('/workflows');
  }

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="space-y-1 text-center">
          <p className="text-2xl font-semibold tracking-tight">m8x</p>
          <p className="text-sm text-ink-faint">Sign in to your workspace.</p>
        </div>

        <form action={attempt} className="card space-y-4 p-5">
          <Field label="Email">
            <Input name="email" type="email" autoComplete="username" required autoFocus />
          </Field>

          <Field label="Password">
            <Input name="password" type="password" autoComplete="current-password" required />
          </Field>

          {error ? (
            <p className="rounded-md border border-bad/25 bg-bad/10 px-3 py-2 text-xs text-bad">
              That email and password combination did not work.
            </p>
          ) : null}

          <Button type="submit" variant="primary" className="w-full">
            Sign in
          </Button>
        </form>

        <p className="text-center text-xs text-ink-faint">
          The first account is created by <code className="font-mono">npm run db:seed</code>.
        </p>
      </div>
    </main>
  );
}
