'use client';

import {
  useMemo,
} from 'react';
import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';
import type { ChartPoint } from '@/lib/dashboard-types';

type Props = {
  points: ChartPoint[];
};

type DaySlice = {
  key: string;
  label: string;
  tooltipLabel: string;
  value: number;
  color: string;
  peakHour: string | null;
  peakValue: number;
};
type PieTooltipProps = {
  active?: boolean;
  payload?: { payload?: DaySlice }[];
};
const DAY_FMT = new Intl.DateTimeFormat('it-IT', { weekday: 'short', day: 'numeric' });
const FULL_WEEKDAY_FMT = new Intl.DateTimeFormat('it-IT', { weekday: 'long' });
const SHORT_DATE_FMT = new Intl.DateTimeFormat('it-IT', { day: '2-digit', month: '2-digit' });
const DAY_SLICE_COLORS = ['#60a5fa', '#34d399', '#c084fc', '#f59e0b', '#f472b6', '#22d3ee', '#a3e635'];

function dailyKey(date: Date): string {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

function pointValue(point: ChartPoint, hasQueueBreakdown: boolean): number {
  if (!hasQueueBreakdown) return point.added;
  return (point.queues?.AI ?? 0) + (point.queues?.AFA ?? 0);
}

function buildDaySlices(points: ChartPoint[], hasQueueBreakdown: boolean): DaySlice[] {
  const daily = new Map<string, {
    label: string;
    tooltipLabel: string;
    value: number;
    hours: Map<string, number>;
  }>();

  points.forEach((point) => {
    const date = new Date(point.bucket);
    const key = dailyKey(date);
    const existing = daily.get(key) ?? {
      label: DAY_FMT.format(date),
      tooltipLabel: `${FULL_WEEKDAY_FMT.format(date)} ${SHORT_DATE_FMT.format(date)}`,
      value: 0,
      hours: new Map<string, number>(),
    };
    const value = pointValue(point, hasQueueBreakdown);
    const hour = String(date.getHours()).padStart(2, '0');

    existing.value += value;
    existing.hours.set(hour, (existing.hours.get(hour) ?? 0) + value);
    daily.set(key, existing);
  });

  return Array.from(daily.entries())
    .map(([key, day], index) => {
      const peak = Array.from(day.hours.entries())
        .sort((a, b) => b[1] - a[1])[0];

      return {
        key,
        label: day.label,
        tooltipLabel: day.tooltipLabel,
        value: day.value,
        color: DAY_SLICE_COLORS[index % DAY_SLICE_COLORS.length],
        peakHour: peak && peak[1] > 0 ? `${peak[0]}:00` : null,
        peakValue: peak?.[1] ?? 0,
      };
    })
    .filter((slice) => slice.value > 0);
}

function PieTooltip({ active, payload }: PieTooltipProps) {
  const slice = payload?.[0]?.payload;
  if (!active || !slice) return null;

  return (
    <div className="pie-tooltip">
      <div className="pie-tooltip-title">
        {slice.tooltipLabel}
      </div>
      <div className="pie-tooltip-row">
        <span>Tot prodotti</span>
        <strong>{slice.value.toLocaleString('it-IT')}</strong>
      </div>
      {slice.peakHour && (
        <div className="pie-tooltip-row">
          <span>Ora di picco</span>
          <strong>{slice.peakHour} · {slice.peakValue.toLocaleString('it-IT')}</strong>
        </div>
      )}
    </div>
  );
}

export default function SevenDayChart({ points }: Props) {
  const hasData = points.length > 1;

  const hasQueueBreakdown = useMemo(
    () => points.some((point) => point.queues !== undefined),
    [points]
  );

  const visible = useMemo(() => (hasData ? points : []), [hasData, points]);

  const daySlices = useMemo(
    () => buildDaySlices(visible, hasQueueBreakdown),
    [hasQueueBreakdown, visible]
  );

  return (
    <div className="chart-shell">
      <div className="chart-viewport pie-viewport" aria-label="Distribuzione attività per giorno">
        {hasData ? (
          daySlices.length > 0 ? (
            <div className="single-pie-chart">
              <ResponsiveContainer>
                <PieChart>
                  <Tooltip
                    content={<PieTooltip />}
                    wrapperStyle={{ outline: 'none' }}
                  />
                  <Pie
                    data={daySlices}
                    dataKey="value"
                    nameKey="label"
                    innerRadius="55%"
                    outerRadius="82%"
                    paddingAngle={daySlices.length > 1 ? 2 : 0}
                    stroke="rgba(13,17,23,0.72)"
                    strokeWidth={1}
                    isAnimationActive={false}
                  >
                    {daySlices.map((slice) => (
                      <Cell key={slice.key} fill={slice.color} />
                    ))}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="chart-empty">Nessun dato per AI/AFA</div>
          )
        ) : (
          <div className="chart-empty">Caricamento serie storica…</div>
        )}
      </div>

      {hasData && daySlices.length > 0 && (
        <div className="single-pie-legend" aria-label="Legenda giorni">
          {daySlices.map((slice) => (
            <span key={slice.key} className="chart-legend-item">
              <span className="chart-legend-dot" style={{ backgroundColor: slice.color }} />
              {slice.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
