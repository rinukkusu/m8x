'use client';

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export interface DailyPoint {
  day: string;
  succeeded: number;
  failed: number;
}

/**
 * Run volume over time, stacked by outcome.
 *
 * Stacked rather than two lines, because the question people actually ask is
 * "how much of this is failing", and a stack answers that by shape alone.
 * Failures are drawn on top so the red band sits against the eye line.
 */
export function InsightsCharts({ daily }: { daily: DailyPoint[] }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-ink">Runs per day</h2>
        <p className="mt-0.5 text-xs text-ink-faint">Successes in green, failures in red.</p>
      </div>

      <div className="rounded-lg border border-line bg-surface-1 p-4">
        <ResponsiveContainer width="100%" height={220}>
          <AreaChart data={daily} margin={{ top: 4, right: 4, bottom: 0, left: -16 }}>
            <defs>
              <linearGradient id="ok" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#22c55e" stopOpacity={0.45} />
                <stop offset="100%" stopColor="#22c55e" stopOpacity={0.05} />
              </linearGradient>
              <linearGradient id="bad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#ef4444" stopOpacity={0.5} />
                <stop offset="100%" stopColor="#ef4444" stopOpacity={0.08} />
              </linearGradient>
            </defs>

            <CartesianGrid stroke="#2a3040" strokeDasharray="3 3" vertical={false} />

            <XAxis
              dataKey="day"
              tick={{ fill: '#6b7385', fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: '#2a3040' }}
              tickFormatter={(value: string) => value.slice(5)}
            />
            <YAxis
              tick={{ fill: '#6b7385', fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              allowDecimals={false}
              width={44}
            />

            <Tooltip
              contentStyle={{
                background: '#181c26',
                border: '1px solid #2a3040',
                borderRadius: 8,
                fontSize: 12,
              }}
              labelStyle={{ color: '#99a1b3' }}
              cursor={{ stroke: '#3a4356' }}
            />

            <Area
              type="monotone"
              dataKey="succeeded"
              name="Succeeded"
              stackId="runs"
              stroke="#22c55e"
              strokeWidth={1.5}
              fill="url(#ok)"
            />
            <Area
              type="monotone"
              dataKey="failed"
              name="Failed"
              stackId="runs"
              stroke="#ef4444"
              strokeWidth={1.5}
              fill="url(#bad)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}
