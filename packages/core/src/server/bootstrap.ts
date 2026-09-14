import { hashPassword } from './crypto.js';
import { prisma } from './db.js';

/**
 * First-run account, created by the web server on boot.
 *
 * This lives here rather than in the seed script because the seed script needs
 * tsx and the workspace sources, neither of which the web image carries. The
 * only way to run it against a plain `docker run` deployment was to start a
 * worker container purely to create a user, which is a silly thing to have to
 * do. The web container is already the one that applies the schema, so it is
 * the natural owner of what has to exist immediately after it.
 *
 * Doing nothing once any user exists is what makes it safe to run on every
 * boot: the credentials in the environment are a bootstrap, not a declaration,
 * so changing the password in the UI is not undone by a restart.
 */
export async function ensureSeedUser(log: (message: string) => void = console.info): Promise<void> {
  if ((await prisma.user.count()) > 0) return;

  const email = process.env.M8X_SEED_EMAIL?.trim().toLowerCase();
  const password = process.env.M8X_SEED_PASSWORD;

  if (!email || !password) {
    // There is no sign-up page, so an empty database with no credentials in
    // the environment is an install nobody can log into. Say so loudly rather
    // than inventing a default account, which on an exposed instance would be
    // a published password.
    log(
      '[bootstrap] no users exist and M8X_SEED_EMAIL / M8X_SEED_PASSWORD are not set. ' +
        'Set both and restart to create the first account.',
    );
    return;
  }

  // createMany rather than create so that two web containers starting at once
  // settle on the unique index quietly. A caught exception would do the same,
  // but Prisma logs the constraint violation on its way out and a healthy boot
  // should not put an error in the container log.
  const { count } = await prisma.user.createMany({
    data: [{ email, name: 'Admin', passwordHash: hashPassword(password) }],
    skipDuplicates: true,
  });

  if (count === 0) return;

  log(`[bootstrap] created the first account: ${email}`);
  if (password === 'changeme') {
    log('[bootstrap] the seed password is still "changeme". Change it before exposing this.');
  }
}
