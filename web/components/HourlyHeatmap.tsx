'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, ChangeEvent, MouseEvent } from 'react';
import type { ChartPoint } from '@/lib/dashboard-types';
import type { HeatmapPalette } from '@/lib/ui-settings';

export const HEATMAP_BUCKET_OPTIONS = [180, 120, 60, 30] as const;
export type HeatmapBucketMinutes = (typeof HEATMAP_BUCKET_OPTIONS)[number];
export type HeatmapSelectedCell = {
  dayKey: string;
  bIdx: number;
  bucketMinutes: HeatmapBucketMinutes;
};

type Props = {
  chartPoints: ChartPoint[];
  now: number;
  bucketMinutes: HeatmapBucketMinutes;
  palette: HeatmapPalette;
  selectedCell: HeatmapSelectedCell | null;
  onBucketMinutesChange: (bucketMinutes: HeatmapBucketMinutes) => void;
  onPickCell: (dayKey: string, bIdx: number, bucketMinutes: HeatmapBucketMinutes) => void;
};

const NUM_DAYS = 7;
const MINUTES_PER_DAY = 24 * 60;
const DAILY_PEAK_BUCKET_MINUTES = 30;

const HEAT_EMPTY = 'color-mix(in srgb, var(--surface-3) 72%, var(--bg))';
const HEAT_RAMP_BY_PALETTE: Record<HeatmapPalette, string[]> = {
  viridis: ['#443a83', '#31688e', '#21918c', '#5ec962', '#fde725'],
  magma: ['#2c115f', '#721f81', '#b73779', '#f1605d', '#fcfdbf'],
  plasma: ['#41049d', '#8f0da4', '#cc4778', '#f89540', '#f0f921'],
  inferno: ['#320a5e', '#781c6d', '#bb3654', '#ed6925', '#fcffa4'],
};

function heatColor(count: number, max: number, palette: HeatmapPalette): string {
  const steps = HEAT_RAMP_BY_PALETTE[palette];
  if (count === 0 || max === 0) return HEAT_EMPTY;
  const t = count / max;
  if (t < 0.12) return steps[0];
  if (t < 0.30) return steps[1];
  if (t < 0.55) return steps[2];
  if (t < 0.80) return steps[3];
  return steps[4];
}

function heatTextColor(count: number, max: number): string {
  if (max === 0 || count === 0) return 'transparent';
  const t = count / max;
  if (t < 0.30) return 'rgba(244,247,251,0.82)';
  if (t < 0.80) return 'rgba(8,10,13,0.9)';
  return 'rgba(8,10,13,0.96)';
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function formatMinuteOfDay(totalMinutes: number): string {
  const normalized = ((totalMinutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hours = Math.floor(normalized / 60);
  const minutes = normalized % 60;
  return `${pad(hours)}:${pad(minutes)}`;
}

function fmtBucketRange(bIdx: number, bucketMinutes: HeatmapBucketMinutes): string {
  const start = bIdx * bucketMinutes;
  const end = start + bucketMinutes;
  return `${formatMinuteOfDay(start)} - ${formatMinuteOfDay(end)}`;
}

function formatBucketDuration(bucketMinutes: HeatmapBucketMinutes): string {
  if (bucketMinutes === 30) return '30 minuti';
  if (bucketMinutes === 60) return '1 ora';
  return `${bucketMinutes / 60} ore`;
}

function formatBucketShort(bucketMinutes: HeatmapBucketMinutes): string {
  return bucketMinutes < 60 ? `${bucketMinutes}m` : `${bucketMinutes / 60}h`;
}

function localDayKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function shouldShowHourTick(bIdx: number, bucketMinutes: HeatmapBucketMinutes): boolean {
  if (bucketMinutes >= 120) return true;
  if (bucketMinutes === 60) return bIdx % 2 === 0;
  return bIdx % 4 === 0;
}

const DAY_SHORT: Record<number, string> = {
  0: 'Dom', 1: 'Lun', 2: 'Mar', 3: 'Mer', 4: 'Gio', 5: 'Ven', 6: 'Sab',
};

type RollingDay = {
  dayKey: string;
  dow: number;
  label: string;
  dateLabel: string;
  dayNum: string;
  relativeLabel: string;
};

type CellData = {
  count: number;
};

type TooltipState = {
  bIdx: number;
  dayIndex: number;
  count: number;
  x: number;
  y: number;
  above: boolean;
};

function buildRollingDays(now: number): RollingDay[] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  return Array.from({ length: NUM_DAYS }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (NUM_DAYS - 1 - index));

    return {
      dayKey: localDayKey(date),
      dow: date.getDay(),
      label: DAY_SHORT[date.getDay()],
      dateLabel: `${pad(date.getDate())}/${pad(date.getMonth() + 1)}`,
      dayNum: String(date.getDate()),
      relativeLabel:
        index === NUM_DAYS - 1
          ? 'oggi'
          : index === NUM_DAYS - 2
            ? 'ieri'
            : `${NUM_DAYS - 1 - index}g fa`,
    };
  });
}

function predictNextDailyPeak(chartPoints: ChartPoint[], now: number): string {
  const numBuckets = MINUTES_PER_DAY / DAILY_PEAK_BUCKET_MINUTES;
  const totals = Array<number>(numBuckets).fill(0);
  const fromMs = now - NUM_DAYS * 24 * 3600_000;

  for (const pt of chartPoints) {
    const ts = new Date(pt.bucket).getTime();
    if (ts < fromMs || pt.added === 0) continue;

    const d = new Date(ts);
    const minutes = d.getHours() * 60 + d.getMinutes();
    const bIdx = Math.floor(minutes / DAILY_PEAK_BUCKET_MINUTES);
    totals[bIdx] += pt.added;
  }

  const peakCount = Math.max(...totals);
  if (peakCount <= 0) return 'Non disponibile';

  const peakStartMinutes = totals.indexOf(peakCount) * DAILY_PEAK_BUCKET_MINUTES;
  const currentDate = new Date(now);
  const currentMinutes = currentDate.getHours() * 60 + currentDate.getMinutes();
  const dayLabel = peakStartMinutes > currentMinutes ? 'Oggi' : 'Domani';

  return `${dayLabel} · ${formatMinuteOfDay(peakStartMinutes)}`;
}

export default function HourlyHeatmap({
  chartPoints,
  now,
  bucketMinutes,
  palette,
  selectedCell,
  onBucketMinutesChange,
  onPickCell,
}: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const matrixRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [armedTouch, setArmedTouch] = useState<{ bIdx: number; dayIndex: number } | null>(null);
  const [hoverCapable, setHoverCapable] = useState(true);
  const [showCellCounts, setShowCellCounts] = useState(true);
  const numBuckets = MINUTES_PER_DAY / bucketMinutes;
  const days = useMemo(() => buildRollingDays(now), [now]);
  const dayIndexByKey = useMemo(
    () => new Map(days.map((day, index) => [day.dayKey, index])),
    [days]
  );
  const bucketOrder = useMemo(
    () => Array.from({ length: numBuckets }, (_, index) => index),
    [numBuckets]
  );
  const bucketOptionIndex = Math.max(0, HEATMAP_BUCKET_OPTIONS.indexOf(bucketMinutes));

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia('(hover: hover) and (pointer: fine)');
    setHoverCapable(mql.matches);
    const handler = (event: MediaQueryListEvent) => {
      setHoverCapable(event.matches);
      if (event.matches) {
        setArmedTouch(null);
        setTooltip(null);
      }
    };
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  useEffect(() => {
    if (hoverCapable || !armedTouch) return;
    const handler = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && wrapRef.current?.contains(target)) return;
      setArmedTouch(null);
      setTooltip(null);
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [hoverCapable, armedTouch]);

  useEffect(() => {
    const matrix = matrixRef.current;
    if (!matrix) return;
    const GAP_PX = 3;
    const MIN_READABLE_CELL_WIDTH = 24;

    const evaluate = () => {
      const width = matrix.clientWidth;
      const usableWidth = width - GAP_PX * Math.max(0, numBuckets - 1);
      const cellWidth = usableWidth / Math.max(1, numBuckets);
      setShowCellCounts(cellWidth >= MIN_READABLE_CELL_WIDTH);
    };

    evaluate();
    if (typeof window === 'undefined' || !('ResizeObserver' in window)) return;
    const observer = new ResizeObserver(evaluate);
    observer.observe(matrix);
    return () => observer.disconnect();
  }, [numBuckets]);

  // grid[bIdx][dayIndex]
  const grid = useMemo<CellData[][]>(() => {
    const g: Array<Array<{ sum: number }>> = Array.from(
      { length: numBuckets },
      () => Array.from({ length: NUM_DAYS }, () => ({ sum: 0 }))
    );
    const fromMs = now - 7 * 24 * 3600_000;
    for (const pt of chartPoints) {
      const ts = new Date(pt.bucket).getTime();
      if (ts < fromMs || pt.added === 0) continue;
      const d = new Date(ts);
      const dayKey = localDayKey(d);
      const dayIndex = dayIndexByKey.get(dayKey);
      if (dayIndex === undefined) continue;
      const minutes = d.getHours() * 60 + d.getMinutes();
      const bIdx = Math.floor(minutes / bucketMinutes);
      g[bIdx][dayIndex].sum += pt.added;
    }
    return g.map(row => row.map(c => ({ count: c.sum })));
  }, [bucketMinutes, chartPoints, dayIndexByKey, now, numBuckets]);

  const max = Math.max(1, ...grid.flat().map(c => c.count));

  const bucketTotals = useMemo(() =>
    grid.map(row => row.reduce((s, c) => s + c.count, 0)), [grid]);
  const peakBucket = bucketTotals.indexOf(Math.max(...bucketTotals));

  const dayTotals = useMemo(() => {
    const arr = Array<number>(NUM_DAYS).fill(0);
    for (let d = 0; d < NUM_DAYS; d++) {
      for (let b = 0; b < numBuckets; b++) arr[d] += grid[b][d].count;
    }
    return arr;
  }, [grid, numBuckets]);
  const peakDow = dayTotals.indexOf(Math.max(...dayTotals));

  const currentDate = new Date(now);
  const todayKey = localDayKey(currentDate);
  const currentBIdx = Math.floor(
    (currentDate.getHours() * 60 + currentDate.getMinutes()) / bucketMinutes
  );

  const positionTooltipForCell = (
    cell: HTMLButtonElement,
    bIdx: number,
    dayIndex: number
  ) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const cr = cell.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    const cx = cr.left + cr.width / 2 - wr.left;
    const cy = cr.top - wr.top;
    const above = cy > 80;
    setTooltip({
      bIdx, dayIndex,
      count: grid[bIdx][dayIndex].count,
      x: cx,
      y: above ? cy : cy + cr.height + 6,
      above,
    });
  };

  const handleCellEnter = (e: MouseEvent<HTMLButtonElement>, bIdx: number, dayIndex: number) => {
    if (!hoverCapable) return;
    positionTooltipForCell(e.currentTarget, bIdx, dayIndex);
  };

  const handleCellLeave = () => {
    if (!hoverCapable) return;
    setTooltip(null);
  };

  const handleCellActivate = (
    e: MouseEvent<HTMLButtonElement>,
    bIdx: number,
    dayIndex: number,
    dayKey: string
  ) => {
    if (hoverCapable) {
      onPickCell(dayKey, bIdx, bucketMinutes);
      return;
    }
    if (armedTouch?.bIdx === bIdx && armedTouch?.dayIndex === dayIndex) {
      onPickCell(dayKey, bIdx, bucketMinutes);
      setArmedTouch(null);
      setTooltip(null);
      return;
    }
    setArmedTouch({ bIdx, dayIndex });
    positionTooltipForCell(e.currentTarget, bIdx, dayIndex);
  };

  const commitArmedFilter = () => {
    if (!armedTouch) return;
    const day = days[armedTouch.dayIndex];
    if (!day) return;
    onPickCell(day.dayKey, armedTouch.bIdx, bucketMinutes);
    setArmedTouch(null);
    setTooltip(null);
  };

  const handleBucketSliderChange = (event: ChangeEvent<HTMLInputElement>) => {
    const next = HEATMAP_BUCKET_OPTIONS[Number(event.currentTarget.value)];
    if (next) {
      setTooltip(null);
      setArmedTouch(null);
      onBucketMinutesChange(next);
    }
  };

  const gridLayoutStyle = useMemo<CSSProperties>(
    () => ({ ['--hm-buckets' as string]: String(numBuckets) }),
    [numBuckets]
  );

  return (
    <div className="hm-wrap" ref={wrapRef}>
      <div className="hm-scroll">
        <div
          className="hm-grid-layout"
          data-bucket={bucketMinutes}
          style={gridLayoutStyle}
        >
          {/* Day labels */}
          <div className="hm-day-axis">
            {days.map((day, dayIndex) => (
              <div
                key={day.dayKey}
                className="hm-day-label"
                style={{
                  color: day.dayKey === todayKey
                    ? 'var(--accent)'
                    : dayIndex === peakDow ? 'var(--text)' : 'var(--text-2)',
                  fontWeight: day.dayKey === todayKey || dayIndex === peakDow ? 700 : 400,
                }}
              >
                <span className="hm-day-name">{day.label} {day.dateLabel}</span>
                <span className="hm-day-meta">{day.relativeLabel}</span>
                <span className="hm-day-num" aria-hidden="true">{day.dayNum}</span>
              </div>
            ))}
          </div>

          {/* Cell grid */}
          <div className="hm-matrix" ref={matrixRef}>
            <div className="hm-cells-col">
              {days.map((day, dayIndex) => (
                <div key={day.dayKey} className="hm-row">
                  {bucketOrder.map((bIdx) => {
                    const c = grid[bIdx][dayIndex];
                    const isToday = day.dayKey === todayKey;
                    const isCurrent = isToday && bIdx === currentBIdx;
                    const isFuture = isToday && bIdx > currentBIdx;
                    const isSel =
                      selectedCell?.bucketMinutes === bucketMinutes &&
                      selectedCell?.bIdx === bIdx &&
                      selectedCell?.dayKey === day.dayKey;
                    const bg = heatColor(c.count, max, palette);
                    const textColor = heatTextColor(c.count, max);
                    const rangeLabel = fmtBucketRange(bIdx, bucketMinutes);
                    return (
                      <button
                        key={bIdx}
                        type="button"
                        className={[
                          'hm-cell',
                          isFuture ? 'future' : '',
                          isCurrent ? 'is-current' : '',
                          isSel ? 'is-selected' : '',
                          isCurrent && isSel ? 'is-current-selected' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        disabled={isFuture}
                        style={{
                          background: bg,
                          outline:
                            isCurrent
                              ? '0px'
                              : isSel
                                ? '2px solid var(--accent)'
                                : '1px solid rgba(255,255,255,0.08)',
                          outlineOffset: '-1px',
                        }}
                        aria-label={`${day.label} ${day.dateLabel} ${rangeLabel}: ${c.count.toLocaleString('it-IT')} prodotti`}
                        onMouseEnter={(e) => handleCellEnter(e, bIdx, dayIndex)}
                        onMouseLeave={handleCellLeave}
                        onClick={(e) => handleCellActivate(e, bIdx, dayIndex, day.dayKey)}
                      >
                        {showCellCounts && bucketMinutes >= 60 && c.count > 0 && (
                          <span style={{ color: textColor }} className="hm-cell-count">
                            {c.count > 999 ? `${(c.count / 1000).toFixed(1)}k` : c.count}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>

            {/* Hour labels */}
            <div className="hm-hour-labels">
              {bucketOrder.map((bIdx) => {
                const showTick = shouldShowHourTick(bIdx, bucketMinutes);
                return (
                  <div
                    key={bIdx}
                    className={`hm-hour-label${showTick ? ' visible' : ''}`}
                    style={{
                      color: bIdx === peakBucket ? 'var(--text)' : 'var(--text-3)',
                      fontWeight: bIdx === peakBucket ? 700 : 400,
                    }}
                  >
                    {showTick ? formatMinuteOfDay(bIdx * bucketMinutes) : ''}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="hm-controls">
        <div className="hm-control-head">
          <span>Granularità bucket</span>
          <strong>{formatBucketDuration(bucketMinutes)}</strong>
        </div>
        <div className="hm-slider-row">
          <input
            className="hm-bucket-slider"
            type="range"
            min={0}
            max={HEATMAP_BUCKET_OPTIONS.length - 1}
            step={1}
            value={bucketOptionIndex}
            aria-label="Granularità temporale della heatmap"
            onChange={handleBucketSliderChange}
          />
        </div>
        <div className="hm-slider-labels" aria-hidden="true">
          {HEATMAP_BUCKET_OPTIONS.map((option) => (
            <div
              key={option}
              className={option === bucketMinutes ? 'active' : undefined}
            >
              {formatBucketShort(option)}
            </div>
          ))}
        </div>
      </div>

      {/* Floating tooltip */}
      {tooltip && (
        (() => {
          const day = days[tooltip.dayIndex];
          if (!day) return null;
          const isArmed =
            armedTouch?.bIdx === tooltip.bIdx &&
            armedTouch?.dayIndex === tooltip.dayIndex;

          return (
        <div
          className={`hm-tooltip${isArmed ? ' is-armed' : ''}`}
          style={{
            left: tooltip.x,
            top: tooltip.above ? tooltip.y - 8 : tooltip.y,
            transform: tooltip.above ? 'translate(-50%, -100%)' : 'translateX(-50%)',
          }}
        >
          <div className="hm-tooltip-header">
            {day.label} {day.dateLabel} · {fmtBucketRange(tooltip.bIdx, bucketMinutes)}
          </div>
          <div className="hm-tooltip-sub">{day.relativeLabel}</div>
          <div className="hm-tooltip-body">
            {tooltip.count === 0
              ? 'nessun drop'
              : `${tooltip.count.toLocaleString('it-IT')} prodotti nel bucket`}
          </div>
          {isArmed ? (
            <button
              type="button"
              className="hm-tooltip-action"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                commitArmedFilter();
              }}
            >
              Filtra il feed
            </button>
          ) : (
            <div className="hm-tooltip-hint">click per filtrare il feed</div>
          )}
        </div>
          );
        })()
      )}

      {/* Insight callouts */}
      <div className="hm-callouts">
        {[
          {
            label: 'Fascia più calda',
            value: fmtBucketRange(peakBucket, bucketMinutes),
            unit: '',
            meta: [
              `${Math.round(bucketTotals[peakBucket] / NUM_DAYS).toLocaleString('it-IT')} prodotti in media`,
            ],
          },
          {
            label: 'Giorno più forte',
            value: dayTotals[peakDow].toLocaleString('it-IT'),
            unit: 'prod',
            meta: [days[peakDow] ? `${days[peakDow].label} ${days[peakDow].dateLabel}` : '—'],
          },
          {
            label: 'Prossima finestra utile',
            value: predictNextDailyPeak(chartPoints, now),
            unit: '',
            meta: ['storico recente'],
          },
        ].map((item, i) => (
          <div key={i} className="hm-callout-card">
            {item.label && <div className="hm-callout-label">{item.label}</div>}
            <div className="hm-callout-value-row">
              <div className="hm-callout-value">{item.value}</div>
              {item.unit && <div className="hm-callout-unit">{item.unit}</div>}
            </div>
            <div className="hm-callout-sub">
              {item.meta.map((chip) => (
                <span key={chip} className="hm-callout-chip">
                  {chip}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
