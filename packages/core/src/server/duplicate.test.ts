import assert from 'node:assert/strict';
import test from 'node:test';

import { node } from '../test-support.js';
import type { Graph } from '../types.js';
import { copyName, reissueTriggerIdentity, webhookPathCandidates } from './duplicate.js';

/**
 * Duplicating a workflow, minus the database.
 *
 * The two parts worth testing on their own are the two a bug would be quiet
 * in: a name that collides or degrades into "(copy) (copy) (copy)", and a copy
 * that carries the original's webhook path — which does not fail loudly, it
 * quietly fights the original for the same ingress.
 */

test('a copy is named after the original', () => {
  assert.equal(copyName('Orders', []), 'Orders (copy)');
});

test('copies of copies count up instead of stacking suffixes', () => {
  // "Orders (copy) (copy)" is what not thinking about it gives you, and it
  // degrades fast.
  assert.equal(copyName('Orders (copy)', ['Orders', 'Orders (copy)']), 'Orders (copy 2)');
  assert.equal(
    copyName('Orders (copy 2)', ['Orders', 'Orders (copy)', 'Orders (copy 2)']),
    'Orders (copy 3)',
  );
});

test('a name already taken by a sibling is skipped, case regardless', () => {
  assert.equal(copyName('Orders', ['orders (COPY)']), 'Orders (copy 2)');
});

function graph(...nodes: Graph['nodes']): Graph {
  return { nodes, edges: [] };
}

/** An issuer that records what it was asked about. */
function issuer(asked: string[]) {
  return async (current: string) => {
    asked.push(current);
    return `${current}-copy`;
  };
}

/**
 * An issuer shaped like the real one: it hands out the first candidate nothing
 * else holds, with no database behind it.
 */
function minting() {
  return async (current: string, claimed: ReadonlySet<string>) =>
    webhookPathCandidates(current).find((candidate) => !claimed.has(candidate)) ?? `${current}-x`;
}

test('a webhook path is reissued rather than shared', async () => {
  const asked: string[] = [];
  const copied = await reissueTriggerIdentity(
    graph(node('hook', 'trigger.webhook', { path: 'orders-created', method: 'POST' })),
    issuer(asked),
  );

  assert.deepEqual(asked, ['orders-created']);
  assert.equal(copied.nodes[0]!.params.path, 'orders-created-copy');
  // Everything else about the node survives.
  assert.equal(copied.nodes[0]!.params.method, 'POST');
});

test('an unconfigured webhook is left alone', async () => {
  // It registers no row, so there is nothing to fight over — and minting a path
  // here would invent an ingress nobody asked for.
  const asked: string[] = [];
  const copied = await reissueTriggerIdentity(
    graph(node('hook', 'trigger.webhook', { path: '   ' })),
    issuer(asked),
  );

  assert.deepEqual(asked, []);
  assert.equal(copied.nodes[0]!.params.path, '   ');
});

test('the trigger kinds that are meant to be shared are left alone', async () => {
  // Telegram and email are shared on purpose: one bot backs several workflows,
  // and a mailbox cursor belongs to the mailbox. A schedule owns nothing.
  const asked: string[] = [];
  const original = graph(
    node('tg', 'trigger.telegram', { credentialId: 'cred_1' }),
    node('mail', 'trigger.email', { credentialId: 'cred_2', folder: 'INBOX' }),
    node('cron', 'trigger.schedule', { mode: 'cron', cron: '0 * * * *' }),
    node('table', 'trigger.datatable', { datatableId: 'dt_1' }),
  );

  const copied = await reissueTriggerIdentity(original, issuer(asked));

  assert.deepEqual(asked, []);
  assert.deepEqual(copied.nodes, original.nodes);
});

test('the original graph is not mutated', async () => {
  const original = graph(node('hook', 'trigger.webhook', { path: 'orders' }));
  await reissueTriggerIdentity(original, issuer([]));

  assert.equal(original.nodes[0]!.params.path, 'orders');
});

test('two webhooks sharing a stem get different paths', async () => {
  // They ask one after another rather than at once: minting reserves nothing,
  // so asking concurrently would hand both the same answer and one of them
  // would silently lose its trigger on the copy.
  const copied = await reissueTriggerIdentity(
    graph(
      node('a', 'trigger.webhook', { path: 'orders' }),
      node('b', 'trigger.webhook', { path: 'orders-copy-3' }),
    ),
    minting(),
  );

  const paths = copied.nodes.map((n) => n.params.path);
  assert.equal(new Set(paths).size, 2, `both nodes got ${paths[0]}`);
});

test('a copy never keeps a path the original already spells', async () => {
  // A disabled webhook registers no Trigger row, so no query rules it out —
  // and "orders-copy" is exactly the path stripping the suffix would hand back.
  const original = graph(
    { ...node('live', 'trigger.webhook', { path: 'orders-copy' }) },
    { ...node('off', 'trigger.webhook', { path: 'orders' }), disabled: true },
  );

  const copied = await reissueTriggerIdentity(original, minting());
  const paths = copied.nodes.map((n) => n.params.path);

  assert.ok(!paths.includes('orders-copy'), 'the copy kept the original path');
  assert.ok(!paths.includes('orders'), 'the copy took the disabled node\'s path');
});

test('path candidates are readable and do not stack -copy', async () => {
  const first = webhookPathCandidates('orders-created');
  assert.equal(first[0], 'orders-created-copy');
  assert.equal(first[1], 'orders-created-copy-2');

  // A copy of a copy counts up rather than growing another suffix, so the URL
  // stays something you can recognise in a log — and the path itself is never
  // offered back, because that is the original's.
  assert.equal(webhookPathCandidates('orders-created-copy')[0], 'orders-created-copy-2');
  assert.ok(!webhookPathCandidates('orders-created-copy').includes('orders-created-copy'));
  assert.ok(!webhookPathCandidates('orders-created-copy-2').includes('orders-created-copy-2'));
});
