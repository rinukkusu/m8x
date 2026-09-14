import assert from 'node:assert/strict';
import test from 'node:test';

import {
  prunePasses,
  pruneExecutions,
  type PrunePass,
  type RetentionStore,
} from './retention.js';

/**
 * Retention, without a database.
 *
 * The policy decides how old is too old and the loop decides how much work one
 * tick does. Both are where a bug would be quiet: a cutoff off by a factor
 * deletes history nobody meant to lose, and a loop that does not stop holds the
 * worker on a first run against two years of executions.
 */

const NOW = new Date('2026-09-14T12:00:00.000Z');

function daysBefore(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

test('successes and failures age out on their own clocks', () => {
  const passes = prunePasses({ successDays: 7, failureDays: 30 }, NOW);

  assert.equal(passes.length, 2);
  assert.deepEqual(passes[0]!.statuses, ['success']);
  assert.equal(passes[0]!.before.toISOString(), daysBefore(7));
  // Cancelled is a run that did not do what it was asked to, so it keeps the
  // company it is worth as much as.
  assert.deepEqual(passes[1]!.statuses, ['failed', 'cancelled']);
  assert.equal(passes[1]!.before.toISOString(), daysBefore(30));
});

test('keeping forever produces no pass at all, rather than an unreachable cutoff', () => {
  assert.deepEqual(prunePasses({ successDays: null, failureDays: null }, NOW), []);

  const onlyFailures = prunePasses({ successDays: null, failureDays: 14 }, NOW);
  assert.equal(onlyFailures.length, 1);
  assert.deepEqual(onlyFailures[0]!.statuses, ['failed', 'cancelled']);
});

/** A store holding ids per status group, handing them out in batches. */
function fakeStore(perPass: Record<string, string[]>): RetentionStore & { calls: number } {
  const remaining = new Map(Object.entries(perPass).map(([key, ids]) => [key, [...ids]]));

  const key = (pass: PrunePass) => pass.statuses.join(',');

  return {
    calls: 0,
    async findExpired(pass, limit) {
      this.calls++;
      return (remaining.get(key(pass)) ?? []).slice(0, limit);
    },
    async deleteExecutions(ids) {
      for (const [name, list] of remaining) {
        remaining.set(
          name,
          list.filter((id) => !ids.includes(id)),
        );
      }
      return ids.length;
    },
  };
}

function ids(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix}_${index}`);
}

test('a pass keeps going while batches come back full', async () => {
  const store = fakeStore({ success: ids('s', 25) });

  const result = await pruneExecutions({
    now: NOW,
    policy: { successDays: 7, failureDays: null },
    store,
    batchSize: 10,
  });

  assert.equal(result.deleted, 25);
  assert.equal(result.moreToDo, false);
  // Three full-ish batches plus the one that came back empty is not required;
  // what matters is that a short batch ended it rather than another round trip.
  assert.equal(store.calls, 3);
});

test('both clocks are enforced in one pass', async () => {
  const store = fakeStore({ success: ids('s', 3), 'failed,cancelled': ids('f', 2) });

  const result = await pruneExecutions({
    now: NOW,
    policy: { successDays: 7, failureDays: 30 },
    store,
    batchSize: 10,
  });

  assert.equal(result.deleted, 5);
});

test('the budget stops the job and says there is more to do', async () => {
  const store = fakeStore({ success: ids('s', 5_000) });

  const result = await pruneExecutions({
    now: NOW,
    policy: { successDays: 7, failureDays: 30 },
    store,
    batchSize: 100,
    maxPerPass: 250,
  });

  // Bounded, so a first run against a huge instance spreads over ticks instead
  // of holding the worker on one enormous delete.
  assert.equal(result.deleted, 250);
  assert.equal(result.moreToDo, true);
});

test('nothing to delete is no work', async () => {
  const store = fakeStore({});

  const result = await pruneExecutions({
    now: NOW,
    policy: { successDays: 7, failureDays: 30 },
    store,
  });

  assert.equal(result.deleted, 0);
  assert.equal(result.moreToDo, false);
});
