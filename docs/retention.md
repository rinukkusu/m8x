# Execution retention

Every node run stores the exact items that went in and came out. That is a
deliberate decision and the reason the execution detail view is worth opening:
you can see the payload at any step of a run from last Tuesday.

It is also unbounded. A webhook workflow firing a few times a minute writes node
run rows continuously, with full payloads, and until now nothing in the system
deleted any of them. The only reaper was the one collecting binary objects that
no execution ever claimed. On a self-hosted install that ends one way — the
volume fills, Postgres stops accepting writes, and the first the operator hears
about it is that everything is broken at once.

This document is the design the implementation follows, and the reasoning behind
the parts that could have gone another way.

## The policy

One row, holding two numbers:

```prisma
model RetentionPolicy {
  id String @id @default("global")

  successDays Int? @default(7)
  failureDays Int? @default(30)

  updatedAt DateTime @updatedAt
}
```

**Successes and failures age out separately** because they are worth different
amounts. A successful run is interesting for a few days at most, and successes
are almost all of the volume. A failed run is the one you go back to, sometimes
weeks later, and failures are a small fraction of the rows — so keeping them
four times as long costs almost nothing and is what an operator would have
chosen anyway.

**Null means keep forever.** It is a decision an operator is allowed to make,
but not the default: the default has to be safe for somebody who never opens the
setting, and "keep everything" is exactly the behaviour this feature exists to
stop. The UI expresses it as a separate choice rather than as `0`, because a
zero typed by accident is a quarter of silence and then a full disk.

**Global rather than per-workflow.** Global is simpler and right to start with.
Per-workflow matters the moment one noisy workflow dominates the volume, and the
shape here does not stand in its way: this table gains a nullable `workflowId`,
the lookup asks for the workflow's row before falling back to the global one,
and nothing else moves. No column is added now for a requirement that does not
exist yet.

## What the job deletes

The prune runs on the worker's existing minute tick, beside the orphan-binary
reaper, so history is enforced whether or not anything is running.

**Age is counted from `queuedAt`**, not from when a run finished. It is the
column `Execution` is already indexed on alongside `status`, so the query that
finds expired rows is an index scan that matches nothing on a normal tick.

**Only finished runs are candidates.** `queued` and `running` appear on neither
clock. An unfinished run is not history, and deleting one would strand a worker
mid-execution. `cancelled` rides the failure clock: it is a run that did not do
what it was asked to, which is the kind somebody comes back to.

**Only root executions are selected.** A sub-workflow run is deleted by the
cascade from its parent. Taking one on its own would leave a retained parent's
detail view linking through to a run that no longer exists, which is a worse
experience than keeping a few extra rows for another day.

**Everything hanging off an execution goes with it.** `NodeRun`, `BinaryObject`
and child executions cascade. Pinned data does not: `PinnedData.sourceExecutionId`
is deliberately not a foreign key, precisely so that retention deleting the run a
pin was captured from cannot delete the pin somebody is working with. The job
nulls that column for the rows it is about to delete, so a pin outlives its
source run without pointing at something that is gone.

That nulling walks the descendants first. A pin can have been captured from a
sub-workflow run, and such a run is deleted by the cascade without ever naming
the root the job selected — so nulling only the selected ids would leave exactly
the dangling reference this is here to prevent.

## Bounded, every time

Deletes happen in batches of 200, each its own statement, with a ceiling of
2,000 executions per tick.

One statement over a date range would be simpler and is the wrong shape. A long
delete holds locks on the tables the executions list reads, so the first tick
against an instance with two years of history would stall the UI — an operator
discovering retention by watching the app freeze is a worse bug than the one
this fixes. Bounded batches mean the backlog is worked off over a few minutes of
ticks instead, and a tick with nothing to do costs one indexed query.

The loop stops a pass as soon as a batch comes back short, which is how it knows
it has reached the cutoff without a counting query.

**The ceiling is per clock, not shared.** Successes are worked first and are
almost all of the volume, so one shared budget would mean that for as long as a
backlog of them took to drain — days, on an old instance — the failure clock
never got a query in and went unenforced. Each clock gets its own.

## Payload size

Retention bounds how long history lives. The cap in `payload.ts` bounds how
large any single piece of it can be: node run inputs and outputs are truncated
at capture, to 50 items and 64 kB of serialised JSON, and the row records that
it happened. The detail view says the payload was cut off rather than quietly
showing a partial one as though it were everything.

That cap is also what keeps retry-from-the-failed-node honest. A partial retry
resumes from stored upstream output, so truncated upstream output falls back to
a full re-run: a partial input would produce a subtly wrong result rather than
an obvious failure.

A run that has been pruned cannot be retried at all — its stored input is what a
retry needs, and it is gone. Pressing Retry on a page left open while retention
caught up says so in those terms.

## What the operator sees

The Insights page shows the policy next to how much history exists: executions
stored, node runs stored, what the history tables occupy on disk, and the date
of the oldest run. It is the page somebody is already on when they wonder where
last month's runs went, and the alternative to showing it there is finding out
from a disk usage graph.

The two row counts are the planner's estimates rather than counts. `COUNT(*)` in
Postgres is a full scan, and this renders on a page that is `force-dynamic` — so
on the instance this whole feature exists for, the one with millions of node
runs, an exact number would cost seconds on every load to say something nobody
reads to the digit. A table Postgres has never analysed reports no estimate at
all, and only then is it counted: that instance is new, and counting it is
free. The size comes from `pg_total_relation_size`, which is free at any
volume.

## A gap worth naming

A run stranded in `running` by a worker that crashed mid-execution is on neither
clock, and nothing else reclaims it, so its payloads are kept forever. The
volume is negligible — it takes a crash to make one — and the fix is not
retention's: it is something noticing that a run has been claimed for longer
than a run can take and marking it failed, which belongs with worker liveness
(#15). Retention will then age it out on the failure clock with everything else.

## Not here yet

Machine-readable metrics — queue depth, execution counts by status, history
size — for anyone running a monitoring stack. The volume query is the shape such
an endpoint would serve, so adding one later is not awkward.
