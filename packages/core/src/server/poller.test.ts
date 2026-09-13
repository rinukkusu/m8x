import assert from 'node:assert/strict';
import test from 'node:test';

import { createPoller, type PollerSpec, type TargetGroup } from './poller.js';

/**
 * The loop every polled integration runs on.
 *
 * Worth testing directly, and awkward to test through either integration: the
 * interesting behaviour is what happens when a target fails, and reaching that
 * through Telegram or IMAP means a fake server as well as a database. The parts
 * these tests cover — one slow or broken target not holding up the others, a
 * failure backing off instead of hammering, a shutdown not being mistaken for a
 * failure — are the ones a bug would be quietest in.
 */

interface Config {
  name: string;
}

function group(target: string, count = 1): TargetGroup<string, Config> {
  return {
    target,
    triggers: Array.from({ length: count }, (_, index) => ({
      workflowId: `wf_${target}_${index}`,
      nodeId: `node_${index}`,
      config: { name: target },
    })),
  };
}

function targets(...names: string[]): Map<string, TargetGroup<string, Config>> {
  return new Map(names.map((name) => [name, group(name)]));
}

/** A spec with everything set fast, so a test is not waiting on real intervals. */
function spec(overrides: Partial<PollerSpec<string, Config>>): PollerSpec<string, Config> {
  return {
    name: 'test',
    idleMs: 2,
    intervalMs: 2,
    minBackoffMs: 10_000,
    maxBackoffMs: 60_000,
    describe: (target) => `target ${target}`,
    listTargets: async () => targets('a'),
    poll: async () => true,
    ...overrides,
  };
}

/** Wait for something the loop does in its own time, rather than for a delay. */
async function waitFor(condition: () => boolean, message: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

/** Run a poller for the length of one test, and always shut it down after. */
async function withPoller(
  options: Partial<PollerSpec<string, Config>>,
  body: (log: string[]) => Promise<void>,
): Promise<void> {
  const log: string[] = [];
  const poller = createPoller(spec(options));
  poller.start((message) => log.push(message));

  try {
    await body(log);
  } finally {
    await poller.stop();
  }
}

test('every target is polled, pass after pass', async () => {
  const polled = new Map<string, number>();

  await withPoller(
    {
      listTargets: async () => targets('a', 'b', 'c'),
      poll: async ({ target }) => {
        polled.set(target, (polled.get(target) ?? 0) + 1);
        return true;
      },
    },
    async () => {
      await waitFor(
        () => ['a', 'b', 'c'].every((name) => (polled.get(name) ?? 0) >= 2),
        'every target to be polled twice',
      );
    },
  );
});

test('a target is polled with its own triggers, not everyone else\'s', async () => {
  const seen = new Map<string, string[]>();

  await withPoller(
    {
      listTargets: async () => new Map([['a', group('a', 3)], ['b', group('b', 1)]]),
      poll: async ({ target, triggers }) => {
        seen.set(target, triggers.map((trigger) => trigger.workflowId));
        return true;
      },
    },
    async () => {
      await waitFor(() => seen.size === 2, 'both targets to be polled');
      assert.deepEqual(seen.get('a'), ['wf_a_0', 'wf_a_1', 'wf_a_2']);
      assert.deepEqual(seen.get('b'), ['wf_b_0']);
    },
  );
});

test('one target failing does not stop the others being polled', async () => {
  const polled = new Map<string, number>();

  await withPoller(
    {
      listTargets: async () => targets('broken', 'fine'),
      poll: async ({ target }) => {
        polled.set(target, (polled.get(target) ?? 0) + 1);
        if (target === 'broken') throw new Error('nope');
        return true;
      },
    },
    async (log) => {
      await waitFor(() => (polled.get('fine') ?? 0) >= 3, 'the healthy target to keep polling');
      // And the broken one is not being hammered while it waits.
      assert.equal(polled.get('broken'), 1);
      assert.equal(
        log.some((line) => line.includes('target broken failed, retrying in')),
        true,
      );
    },
  );
});

test('a failure names the target and the reason it gave', async () => {
  await withPoller(
    {
      minBackoffMs: 30_000,
      poll: async () => {
        throw new Error('the mailbox is on fire');
      },
    },
    async (log) => {
      await waitFor(() => log.length > 0, 'the failure to be logged');
      assert.match(log[0]!, /^\[test\] target a failed, retrying in 30s: the mailbox is on fire$/);
    },
  );
});

test('a failed target is polled again once its backoff has passed', async () => {
  let attempts = 0;

  await withPoller(
    {
      minBackoffMs: 10,
      maxBackoffMs: 20,
      poll: async () => {
        attempts++;
        throw new Error('still broken');
      },
    },
    async () => {
      await waitFor(() => attempts >= 3, 'the failing target to be retried');
    },
  );
});

test('the wait after a failure grows rather than staying flat', async () => {
  const attemptedAt: number[] = [];

  await withPoller(
    {
      minBackoffMs: 25,
      maxBackoffMs: 10_000,
      poll: async () => {
        attemptedAt.push(Date.now());
        throw new Error('still broken');
      },
    },
    async () => {
      await waitFor(() => attemptedAt.length >= 4, 'four attempts');
      const gaps = attemptedAt.slice(1).map((at, index) => at - attemptedAt[index]!);
      // 25ms, then 50, then 100. Compared rather than measured exactly, since a
      // loaded machine can stretch any one of them.
      assert.ok(gaps[1]! > gaps[0]!, `expected growing gaps, got ${gaps.join(', ')}`);
      assert.ok(gaps[2]! > gaps[1]!, `expected growing gaps, got ${gaps.join(', ')}`);
    },
  );
});

test('a target that recovers is polled at full speed again', async () => {
  let attempts = 0;

  await withPoller(
    {
      minBackoffMs: 10,
      poll: async () => {
        attempts++;
        // Fails once, then works.
        if (attempts === 1) throw new Error('a blip');
        return true;
      },
    },
    async () => {
      await waitFor(() => attempts >= 2, 'the retry');
      const afterRecovery = attempts;
      // No second backoff to wait out, so the passes come at the interval.
      await waitFor(() => attempts >= afterRecovery + 3, 'polling to resume at full speed');
    },
  );
});

test('a target whose lease another worker holds is not treated as a failure', async () => {
  let attempts = 0;

  await withPoller(
    {
      // Long enough that a backoff would be obvious: the target would stop.
      minBackoffMs: 30_000,
      poll: async () => {
        attempts++;
        return false;
      },
    },
    async (log) => {
      await waitFor(() => attempts >= 3, 'the target to keep being attempted');
      assert.deepEqual(log, []);
    },
  );
});

test('a poll interrupted by shutdown does not back off', async () => {
  const log: string[] = [];
  let started = 0;
  let release: (() => void) | undefined;

  const poller = createPoller(
    spec({
      poll: async (_group, signal) => {
        started++;
        await new Promise<void>((resolve) => {
          release = resolve;
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        // What a real poll does when it notices the shutdown mid-flight.
        if (signal.aborted) throw new Error('aborted');
        return true;
      },
    }),
  );

  poller.start((message) => log.push(message));
  await waitFor(() => started === 1, 'the first poll to start');
  await poller.stop();
  release?.();

  assert.deepEqual(log, [], 'shutting down is not something to log a retry for');
});

test('starting an already-running poller does not start a second loop', async () => {
  let polls = 0;
  const poller = createPoller(spec({ poll: async () => (polls++, true) }));

  poller.start(() => {});
  poller.start(() => {});

  try {
    await waitFor(() => polls >= 4, 'several passes');
    const inOnePass = polls;
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Two loops would roughly double the rate; this only checks it is not wild.
    assert.ok(polls - inOnePass < 40, `${polls - inOnePass} polls in 20ms suggests two loops`);
  } finally {
    await poller.stop();
  }
});

test('stopping leaves nothing running', async () => {
  let polls = 0;
  const poller = createPoller(spec({ poll: async () => (polls++, true) }));

  poller.start(() => {});
  await waitFor(() => polls > 0, 'the first poll');
  await poller.stop();

  const afterStop = polls;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(polls, afterStop);
});

test('a poller with nothing subscribed waits instead of spinning', async () => {
  let passes = 0;
  let polls = 0;

  await withPoller(
    {
      listTargets: async () => {
        passes++;
        return new Map();
      },
      poll: async () => (polls++, true),
    },
    async () => {
      await waitFor(() => passes >= 3, 'several empty passes');
      assert.equal(polls, 0);
    },
  );
});

test('a database that will not answer does not kill the loop', async () => {
  let attempts = 0;

  await withPoller(
    {
      listTargets: async () => {
        attempts++;
        if (attempts < 3) throw new Error('the database is down');
        return targets('a');
      },
      poll: async () => true,
    },
    async () => {
      await waitFor(() => attempts >= 4, 'the loop to keep trying and then recover');
    },
  );
});

test('the backoff is forgotten across a restart', async () => {
  let attempts = 0;
  const poll = async (): Promise<boolean> => {
    attempts++;
    throw new Error('broken');
  };

  const poller = createPoller(spec({ minBackoffMs: 30_000, poll }));
  poller.start(() => {});
  await waitFor(() => attempts === 1, 'the first attempt');
  await poller.stop();

  // A restart is how an operator clears a stuck integration, so a poller that
  // remembered its backoff would ignore them for the next half hour.
  poller.start(() => {});
  try {
    await waitFor(() => attempts === 2, 'an immediate attempt after restarting');
  } finally {
    await poller.stop();
  }
});

test('a target that goes away does not keep its backoff for when it comes back', async () => {
  let attempts = 0;
  let subscribed = true;

  await withPoller(
    {
      // Long enough that a remembered backoff would still be in force when the
      // target comes back, so the retry below can only be an immediate one.
      minBackoffMs: 30_000,
      maxBackoffMs: 60_000,
      listTargets: async () => (subscribed ? targets('a') : new Map()),
      poll: async () => {
        attempts++;
        throw new Error('broken');
      },
    },
    async () => {
      await waitFor(() => attempts === 1, 'the failing target to be polled once');

      // Switched off, noticed, and switched back on. A trigger being edited
      // looks exactly like this from here.
      subscribed = false;
      await waitFor(() => true, 'a pass with nothing subscribed');
      await new Promise((resolve) => setTimeout(resolve, 20));
      subscribed = true;

      await waitFor(() => attempts === 2, 'the returning target to be polled again');
    },
  );
});
