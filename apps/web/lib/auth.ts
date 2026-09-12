import 'server-only';

import { randomBytes } from 'node:crypto';

import { prisma, verifyPassword } from '@m8x/core/server';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

/**
 * Session handling.
 *
 * Database-backed sessions rather than a signed JWT, because a self-hosted tool
 * needs "log everyone out" to actually work. One team, a handful of accounts,
 * no refresh-token dance.
 */

const COOKIE_NAME = 'm8x_session';
const SESSION_DAYS = 30;

export interface SessionUser {
  id: string;
  email: string;
  name: string | null;
}

export async function signIn(email: string, password: string): Promise<SessionUser | null> {
  const user = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });

  // Run the hash comparison even when the account does not exist, so the
  // response time does not reveal which emails are registered.
  const ok = user
    ? verifyPassword(password, user.passwordHash)
    : verifyPassword(password, 'scrypt.16384.AAAA.AAAA');

  if (!user || !ok) return null;

  const session = await prisma.session.create({
    data: {
      // The id is the cookie, so it is the password to the account and has to
      // be unguessable. The schema's cuid default is not: it is a timestamp, a
      // counter and a short random tail, so seeing one session narrows the
      // search for the next. 32 random bytes instead.
      id: generateToken(),
      userId: user.id,
      expiresAt: new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000),
    },
    select: { id: true, expiresAt: true },
  });

  const store = await cookies();
  store.set(COOKIE_NAME, session.id, {
    httpOnly: true,
    sameSite: 'lax',
    secure: await servingOverHttps(),
    path: '/',
    expires: session.expiresAt,
  });

  return { id: user.id, email: user.email, name: user.name };
}

export async function signOut(): Promise<void> {
  const store = await cookies();
  const sessionId = store.get(COOKIE_NAME)?.value;

  if (sessionId) {
    await prisma.session.deleteMany({ where: { id: sessionId } });
  }
  store.delete(COOKIE_NAME);
}

export async function currentUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const sessionId = store.get(COOKIE_NAME)?.value;
  if (!sessionId) return null;

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    include: { user: { select: { id: true, email: true, name: true } } },
  });

  if (!session) return null;

  if (session.expiresAt < new Date()) {
    await prisma.session.deleteMany({ where: { id: sessionId } });
    return null;
  }

  return session.user;
}

/** For pages and actions that must not run for a signed-out visitor. */
export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect('/login');
  return user;
}

/**
 * Whether to mark the session cookie `secure`.
 *
 * Keying this off NODE_ENV is the obvious thing and it is wrong: a browser
 * will not send a secure cookie over plain HTTP, so a production build reached
 * at http://<lan-ip>:3000 looks permanently signed out. What actually matters
 * is the scheme the browser used, which only a reverse proxy can tell us.
 *
 * Set M8X_FORCE_SECURE_COOKIES=1 when terminating TLS somewhere that does not
 * forward the header.
 */
async function servingOverHttps(): Promise<boolean> {
  if (process.env.M8X_FORCE_SECURE_COOKIES === '1') return true;

  const forwarded = (await headers()).get('x-forwarded-proto');
  // A chain of proxies appends, so the client's own scheme is the first entry.
  return forwarded?.split(',')[0]?.trim() === 'https';
}

/** A secret that goes in a cookie: 32 bytes from the CSPRNG, URL-safe. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}
