import { prisma } from '@m8x/core/server';
import Link from 'next/link';

import { InsightsCharts, type DailyPoint } from '@/components/insights-charts';
import { EmptyState, PageHeader, formatDuration, formatRelative } from '@/components/ui';
import { requireUser } from '@/lib/auth';

export const dynamic = 'force-dynamic';

const WINDOW_DAYS = 14;

export default async function InsightsPage() {
  await requireUser();

  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const [daily, durations, failureGroups, slowNodes, totals] = await Promise.all([
    dailyCounts(since),
    durationPercentiles(since),
    failureGroupsSince(since),
    slowestNodes(since),
    prisma.execution.groupBy({
      by: ['status'],
      where: { queuedAt: { gte: since } },
      _count: { _all: true },
    }),
  ]);

  const totalRuns = totals.reduce((sum, row) => sum + row._count._all, 0);
  const failed = totals.find((row) => row.status === 'failed')?._count._all ?? 0;
  const succeeded = totals.find((row) => row.status === 'success')?._count._all ?? 0;
  const finished = failed + succeeded;
  const successRate = finished === 0 ? null : (succeeded / finished) * 100;

  return (
    <>
      <PageHeader title="Insights" description={`Everything that ran in the last ${WINDOW_DAYS} days.`} />

      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto p-6">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Runs" value={totalRuns.toLocaleString()} />
          <Stat
            label="Success rate"
            value={successRate === null ? '-' : `${successRate.toFixed(1)}%`}
            tone={successRate !== null && successRate < 90 ? 'bad' : undefined}
          />
          <Stat label="Median duration" value={formatDuration(durations.p50)} />
          <Stat label="95th percentile" value={formatDuration(durations.p95)} />
        </div>

        {totalRuns === 0 ? (
          <EmptyState
            title="Nothing has run yet"
            description="Once workflows start running, this page shows how often they fail, how long they take, and which failures are the same problem repeating."
          />
        ) : (
          <>
            <InsightsCharts daily={daily} />

            <section className="space-y-3">
              <div>
                <h2 className="text-sm font-semibold text-ink">Failure groups</h2>
                <p className="mt-0.5 text-xs text-ink-faint">
                  Runs that failed the same way, collapsed into one row each. A wall of failures is usually a handful
                  of distinct problems.
                </p>
              </div>

              {failureGroups.length === 0 ? (
                <p className="rounded-lg border border-line bg-surface-1 px-4 py-6 text-center text-sm text-ink-faint">
                  Nothing has failed in this window.
                </p>
              ) : (
                <ul className="space-y-1.5">
                  {failureGroups.map((group) => (
                    <li key={group.fingerprint}>
                      <Link
                        href={`/executions?fingerprint=${group.fingerprint}`}
                        className="flex items-start gap-3 rounded-lg border border-line bg-surface-1 px-4 py-3 transition-colors hover:border-line-strong"
                      >
                        <span className="mt-0.5 min-w-12 shrink-0 rounded bg-bad/15 px-2 py-0.5 text-center text-xs font-semibold text-bad">
                          {group.count}
                        </span>

                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm text-ink">{group.message}</span>
                          <span className="mt-0.5 block text-xs text-ink-faint">
                            <code className="font-mono">{group.errorType}</code> in {group.nodeName} ·{' '}
                            {group.workflowCount} {group.workflowCount === 1 ? 'workflow' : 'workflows'} · last seen{' '}
                            {formatRelative(group.lastSeen)}
                          </span>
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="space-y-3">
              <div>
                <h2 className="text-sm font-semibold text-ink">Slowest node types</h2>
                <p className="mt-0.5 text-xs text-ink-faint">Average time spent per node type across all runs.</p>
              </div>

              <div className="overflow-hidden rounded-lg border border-line">
                <table className="w-full text-sm">
                  <thead className="bg-surface-1 text-left text-xs text-ink-faint">
                    <tr>
                      <th className="px-4 py-2 font-medium">Node type</th>
                      <th className="px-4 py-2 font-medium">Runs</th>
                      <th className="px-4 py-2 font-medium">Average</th>
                      <th className="px-4 py-2 font-medium">Slowest</th>
                    </tr>
                  </thead>
                  <tbody>
                    {slowNodes.map((row) => (
                      <tr key={row.nodeType} className="border-t border-line/60">
                        <td className="px-4 py-2 font-mono text-xs text-ink">{row.nodeType}</td>
                        <td className="px-4 py-2 text-ink-muted">{row.runs.toLocaleString()}</td>
                        <td className="px-4 py-2 text-ink-muted">{formatDuration(row.avgMs)}</td>
                        <td className="px-4 py-2 text-ink-muted">{formatDuration(row.maxMs)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}
      </div>
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'bad' }) {
  return (
    <div className="rounded-lg border border-line bg-surface-1 px-4 py-3">
      <p className="text-xs text-ink-faint">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${tone === 'bad' ? 'text-bad' : 'text-ink'}`}>{value}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Queries
//
// These are raw SQL because Prisma cannot express date bucketing or
// percentiles, and doing either in JavaScript would mean pulling every
// execution row into the page.
// ---------------------------------------------------------------------------

async function dailyCounts(since: Date): Promise<DailyPoint[]> {
  const rows = await prisma.$queryRaw<Array<{ day: Date; succeeded: bigint; failed: bigint }>>`
    SELECT
      DATE_TRUNC('day', "queuedAt") AS day,
      COUNT(*) FILTER (WHERE "status" = 'success') AS succeeded,
      COUNT(*) FILTER (WHERE "status" = 'failed') AS failed
    FROM "Execution"
    WHERE "queuedAt" >= ${since}
    GROUP BY 1
    ORDER BY 1 ASC
  `;

  return rows.map((row) => ({
    day: row.day.toISOString().slice(0, 10),
    succeeded: Number(row.succeeded),
    failed: Number(row.failed),
  }));
}

async function durationPercentiles(since: Date): Promise<{ p50: number | null; p95: number | null }> {
  const rows = await prisma.$queryRaw<Array<{ p50: number | null; p95: number | null }>>`
    SELECT
      PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY "durationMs") AS p50,
      PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY "durationMs") AS p95
    FROM "Execution"
    WHERE "queuedAt" >= ${since} AND "durationMs" IS NOT NULL
  `;

  const row = rows[0];
  return {
    p50: row?.p50 === null || row?.p50 === undefined ? null : Math.round(row.p50),
    p95: row?.p95 === null || row?.p95 === undefined ? null : Math.round(row.p95),
  };
}

interface FailureGroup {
  fingerprint: string;
  count: number;
  message: string;
  errorType: string;
  nodeName: string;
  workflowCount: number;
  lastSeen: Date;
}

async function failureGroupsSince(since: Date): Promise<FailureGroup[]> {
  const rows = await prisma.$queryRaw<
    Array<{
      fingerprint: string;
      count: bigint;
      message: string | null;
      errortype: string | null;
      nodename: string | null;
      workflowcount: bigint;
      lastseen: Date;
    }>
  >`
    SELECT
      "errorFingerprint" AS fingerprint,
      COUNT(*) AS count,
      COUNT(DISTINCT "workflowId") AS workflowcount,
      MAX("queuedAt") AS lastseen,
      -- The most recent example stands in for the group. Any member would do,
      -- but the newest one is the one someone is most likely investigating.
      (ARRAY_AGG("errorMessage" ORDER BY "queuedAt" DESC))[1] AS message,
      (ARRAY_AGG("errorType" ORDER BY "queuedAt" DESC))[1] AS errortype,
      (ARRAY_AGG("errorNodeName" ORDER BY "queuedAt" DESC))[1] AS nodename
    FROM "Execution"
    WHERE "status" = 'failed' AND "errorFingerprint" IS NOT NULL AND "queuedAt" >= ${since}
    GROUP BY 1
    ORDER BY count DESC
    LIMIT 25
  `;

  return rows.map((row) => ({
    fingerprint: row.fingerprint,
    count: Number(row.count),
    message: row.message ?? 'Unknown failure',
    errorType: row.errortype ?? 'Error',
    nodeName: row.nodename ?? 'the workflow',
    workflowCount: Number(row.workflowcount),
    lastSeen: row.lastseen,
  }));
}

async function slowestNodes(since: Date): Promise<Array<{ nodeType: string; runs: number; avgMs: number; maxMs: number }>> {
  const rows = await prisma.$queryRaw<
    Array<{ nodetype: string; runs: bigint; avgms: number; maxms: number }>
  >`
    SELECT
      nr."nodeType" AS nodetype,
      COUNT(*) AS runs,
      AVG(nr."durationMs") AS avgms,
      MAX(nr."durationMs") AS maxms
    FROM "NodeRun" nr
    JOIN "Execution" e ON e."id" = nr."executionId"
    WHERE e."queuedAt" >= ${since} AND nr."durationMs" IS NOT NULL
    GROUP BY 1
    ORDER BY avgms DESC
    LIMIT 10
  `;

  return rows.map((row) => ({
    nodeType: row.nodetype,
    runs: Number(row.runs),
    avgMs: Math.round(row.avgms),
    maxMs: Math.round(row.maxms),
  }));
}
