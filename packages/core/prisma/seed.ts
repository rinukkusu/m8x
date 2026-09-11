import { randomUUID } from 'node:crypto';

import type { Graph } from '../src/types.js';
import { hashPassword } from '../src/server/crypto.js';
import { prisma } from '../src/server/db.js';

/**
 * First-run setup: one account, one folder, one workflow that demonstrates the
 * failure view. Running it twice is safe.
 */
async function main(): Promise<void> {
  const email = (process.env.M8X_SEED_EMAIL ?? 'admin@m8x.local').toLowerCase();
  const password = process.env.M8X_SEED_PASSWORD ?? 'changeme';

  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, name: 'Admin', passwordHash: hashPassword(password) },
    select: { id: true, email: true },
  });

  console.info(`user: ${user.email}`);
  if (password === 'changeme') {
    console.warn('The seed password is still "changeme". Set M8X_SEED_PASSWORD before exposing this.');
  }

  const existing = await prisma.workflow.count();
  if (existing > 0) {
    console.info('workflows already exist, leaving them alone');
    return;
  }

  const folder = await prisma.folder.create({ data: { name: 'Examples', path: '/' }, select: { id: true } });

  await prisma.workflow.create({
    data: {
      name: 'Fetch and reshape',
      folderId: folder.id,
      graph: demoGraph() as never,
    },
  });

  // A second workflow that fails on purpose, so the failures page and the
  // fingerprint grouping have something to show on a fresh install.
  await prisma.workflow.create({
    data: {
      name: 'Always fails (for the failures page)',
      folderId: folder.id,
      graph: failingGraph() as never,
    },
  });

  console.info('seeded 1 folder and 2 workflows');
}

function demoGraph(): Graph {
  const trigger = randomUUID();
  const http = randomUUID();
  const split = randomUUID();
  const set = randomUUID();

  return {
    nodes: [
      { id: trigger, type: 'trigger.manual', name: 'When clicking Run', position: { x: 0, y: 0 }, params: {} },
      {
        id: http,
        type: 'action.httpRequest',
        name: 'Get posts',
        position: { x: 280, y: 0 },
        params: { method: 'GET', url: 'https://jsonplaceholder.typicode.com/posts', responseType: 'json' },
      },
      {
        id: split,
        type: 'flow.splitOut',
        name: 'One item per post',
        position: { x: 560, y: 0 },
        params: { field: 'body' },
      },
      {
        id: set,
        type: 'action.set',
        name: 'Keep title only',
        position: { x: 840, y: 0 },
        params: {
          keepOnlySet: true,
          assignments: [
            { key: 'id', value: '{{ $json.id }}' },
            { key: 'title', value: '{{ $json.title }}' },
          ],
        },
      },
    ],
    edges: [
      { id: randomUUID(), source: trigger, sourceOutput: 0, target: http, targetInput: 0 },
      { id: randomUUID(), source: http, sourceOutput: 0, target: split, targetInput: 0 },
      { id: randomUUID(), source: split, sourceOutput: 0, target: set, targetInput: 0 },
    ],
  };
}

function failingGraph(): Graph {
  const trigger = randomUUID();
  const http = randomUUID();

  return {
    nodes: [
      { id: trigger, type: 'trigger.manual', name: 'When clicking Run', position: { x: 0, y: 0 }, params: {} },
      {
        id: http,
        type: 'action.httpRequest',
        name: 'Call an endpoint that 500s',
        position: { x: 280, y: 0 },
        params: { method: 'GET', url: 'https://httpbin.org/status/500', timeoutMs: 10000 },
        retries: 1,
        retryBackoffMs: 500,
      },
    ],
    edges: [{ id: randomUUID(), source: trigger, sourceOutput: 0, target: http, targetInput: 0 }],
  };
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
