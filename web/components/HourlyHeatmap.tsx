'use client';

import { useMemo, useRef, useState } from 'react';
import type { ChartPoint } from '@/lib/dashboard-types';

type Props = {
  chartPoints: ChartPoint[];
  now: number;
  selectedCell: { dow: number; bIdx: number } | null;
  onPickCell: (dow: number, bIdx: number) => void;
};

// 8 × 3-hour buckets (0 = 00-03h, …, 7 = 21-24h)
const NUM_BUCKETS = 8;
const NUM_DAYS = 7;
const BUCKET_HOURS = 3;

// Discrete 5-step ramp tuned for the dark dashboard surface.
const HEAT_EMPTY = '#151a22';
const HEAT_STEPS = [
  '#151a22', // 0 — empty
  '#1f3a2c', // 1 — low activity
  '#2f6f43', // 2 — active
  '#a3e635', // 3 — hot
  '#f59e0b', // 4 — very hot
  '#fb7185', // 5 — peak
];

function heatColor(count: number, max: number): string {
  if (count === 0 || max === 0) return HEAT_EMPTY;
  const t = count / max;
  if (t < 0.12) return HEAT_STEPS[1];
  if (t < 0.30) return HEAT_STEPS[2];
  if (t < 0.55) return HEAT_STEPS[3];
  if (t < 0.80) return HEAT_STEPS[4];
  return HEAT_STEPS[5];
}

function heatTextColor(count: number, max: number): string {
  if (max === 0 || count === 0) return 'transparent';
  const t = count / max;
  if (t < 0.30) return 'rgba(244,247,251,0.82)';
  if (t < 0.80) return 'rgba(8,10,13,0.86)';
  return 'rgba(244,247,251,0.94)';
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

function fmtBucketRange(bIdx: number): string {
  const start = bIdx * BUCKET_HOURS;
  const end = (start + BUCKET_HOURS) % 24;
  return `${pad(start)}:00 - ${end === 0 ? '00:00' : `${pad(end)}:00`}`;
}

// Mon=1..Sun=0 → display order Mon..Sun
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DAY_SHORT: Record<number, string> = {
  0: 'Dom', 1: 'Lun', 2: 'Mar', 3: 'Mer', 4: 'Gio', 5: 'Ven', 6: 'Sab',
};

type CellData = {
  count: number;
  occurrences: number; // how many of the 7 days had activity in this slot
};

type TooltipState = {
  bIdx: number;
  dow: number;
  count: number;
  occurrences: number;
  x: number;
  y: number;
  above: boolean;
};

function predictNextPeak(grid: CellData[][], now: number): string {
  for (let i = 1; i <= NUM_BUCKETS * NUM_DAYS; i++) {
    const t = new Date(now + i * BUCKET_HOURS * 3600_000);
    const dow = t.getDay();
    const bIdx = Math.floor(t.getHours() / BUCKET_HOURS);
    if (grid[bIdx][dow].count > 30) {
      const diffH = i * BUCKET_HOURS;
      if (diffH < 24) return `tra ${diffH}h · ${pad(bIdx * BUCKET_HOURS)}h`;
      return `${Math.round(diffH / 24)}g · ${pad(bIdx * BUCKET_HOURS)}h`;
    }
  }
  return '—';
}

export default function HourlyHeatmap({ chartPoints, now, selectedCell, onPickCell }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  // grid[bIdx][dow]
  const grid = useMemo<CellData[][]>(() => {
    const g: Array<Array<{ sum: number; days: Set<string> }>> = Array.from(
      { length: NUM_BUCKETS },
      () => Array.from({ length: NUM_DAYS }, () => ({ sum: 0, days: new Set<string>() }))
    );
    const fromMs = now - 7 * 24 * 3600_000;
    for (const pt of chartPoints) {
      const ts = new Date(pt.bucket).getTime();
      if (ts < fromMs || pt.added === 0) continue;
      const d = new Date(ts);
      const dow = d.getDay();
      const bIdx = Math.floor(d.getHours() / BUCKET_HOURS);
      g[bIdx][dow].sum += pt.added;
      g[bIdx][dow].days.add(pt.bucket.slice(0, 10));
    }
    return g.map(row => row.map(c => ({ count: c.sum, occurrences: c.days.size })));
  }, [chartPoints, now]);

  const max = Math.max(1, ...grid.flat().map(c => c.count));

  const bucketTotals = useMemo(() =>
    grid.map(row => row.reduce((s, c) => s + c.count, 0)), [grid]);
  const peakBucket = bucketTotals.indexOf(Math.max(...bucketTotals));

  const dayTotals = useMemo(() => {
    const arr = Array<number>(NUM_DAYS).fill(0);
    for (let d = 0; d < NUM_DAYS; d++) {
      for (let b = 0; b < NUM_BUCKETS; b++) arr[d] += grid[b][d].count;
    }
    return arr;
  }, [grid]);
  const peakDow = dayTotals.indexOf(Math.max(...dayTotals));

  const todayDow = new Date(now).getDay();
  const currentBIdx = Math.floor(new Date(now).getHours() / BUCKET_HOURS);

  // Render top→bottom = bIdx 7..0 so 00:00 is at the bottom
  const bucketOrder = [7, 6, 5, 4, 3, 2, 1, 0];

  const handleCellEnter = (e: React.MouseEvent<HTMLDivElement>, bIdx: number, dow: number) => {
    const cell = e.currentTarget;
    const wrap = wrapRef.current;
    if (!wrap) return;
    const cr = cell.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    const cx = cr.left + cr.width / 2 - wr.left;
    const cy = cr.top - wr.top;
    const above = cy > 80;
    setTooltip({
      bIdx, dow,
      count: grid[bIdx][dow].count,
      occurrences: grid[bIdx][dow].occurrences,
      x: cx,
      y: above ? cy : cy + cr.height + 6,
      above,
    });
  };

  const HOUR_AXIS_W = 100;

  return (
    <div className="hm-wrap" ref={wrapRef}>
      <div className="hm-grid-layout" style={{
        gridTemplateColumns: `${HOUR_AXIS_W}px 1fr`,
      }}>
        {/* Hour-axis labels */}
        <div className="hm-hour-axis">
          {bucketOrder.map((bIdx) => (
            <div
              key={bIdx}
              className="hm-hour-label"
              style={{
                color: bIdx === peakBucket ? 'var(--text)' : 'var(--text-2)',
                fontWeight: bIdx === peakBucket ? 600 : 400,
                borderRight: bIdx === currentBIdx ? '2px solid var(--accent)' : '2px solid transparent',
              }}
            >
              {fmtBucketRange(bIdx)}
            </div>
          ))}
        </div>

        {/* Cell grid */}
        <div className="hm-cells-col">
          {bucketOrder.map((bIdx) => (
            <div key={bIdx} className="hm-row">
              {DAY_ORDER.map((dow) => {
                const c = grid[bIdx][dow];
                const isToday = dow === todayDow;
                const isCurrent = isToday && bIdx === currentBIdx;
                const isSel = selectedCell?.bIdx === bIdx && selectedCell?.dow === dow;
                const bg = heatColor(c.count, max);
                const textColor = heatTextColor(c.count, max);
                return (
                  <div
                    key={dow}
                    className="hm-cell"
                    style={{
                      background: bg,
                      outline: isSel
                        ? '2px solid var(--accent)'
                        : isCurrent
                          ? '2px solid var(--accent-strong)'
                          : '1px solid rgba(255,255,255,0.08)',
                      outlineOffset: '-1px',
                    }}
                    onMouseEnter={(e) => handleCellEnter(e, bIdx, dow)}
                    onMouseLeave={() => setTooltip(null)}
                    onClick={() => onPickCell(dow, bIdx)}
                  >
                    {c.count > 0 && (
                      <span style={{ color: textColor }} className="hm-cell-count">
                        {c.count > 999 ? `${(c.count / 1000).toFixed(1)}k` : c.count}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}

          {/* Day labels */}
          <div className="hm-day-labels">
            {DAY_ORDER.map(dow => (
              <div
                key={dow}
                className="hm-day-label"
                style={{
                  color: dow === todayDow
                    ? 'var(--accent)'
                    : dow === peakDow ? 'var(--text)' : 'var(--text-2)',
                  fontWeight: dow === todayDow || dow === peakDow ? 700 : 400,
                }}
              >
                {DAY_SHORT[dow]}
              </div>
            ))}
          </div>
        </div>

      </div>

      {/* Floating tooltip */}
      {tooltip && (
        <div
          className="hm-tooltip"
          style={{
            left: tooltip.x,
            top: tooltip.above ? tooltip.y - 8 : tooltip.y,
            transform: tooltip.above ? 'translate(-50%, -100%)' : 'translateX(-50%)',
          }}
        >
          <div className="hm-tooltip-header">
            {DAY_SHORT[tooltip.dow]} · {fmtBucketRange(tooltip.bIdx)}
          </div>
          <div className="hm-tooltip-body">
            {tooltip.count === 0
              ? 'nessun drop'
              : `${tooltip.count.toLocaleString('it-IT')} drop · in ${tooltip.occurrences}/7 giorn${tooltip.occurrences === 1 ? 'o' : 'i'}`}
          </div>
          {tooltip.occurrences > 0 && tooltip.count > 0 && (
            <div className="hm-tooltip-sub">
              media {Math.round(tooltip.count / tooltip.occurrences).toLocaleString('it-IT')} drop/giorno
            </div>
          )}
          <div className="hm-tooltip-hint">click per filtrare il feed</div>
        </div>
      )}

      {/* Insight callouts */}
      <div className="hm-callouts">
        {[
          {
            label: 'Fascia più attiva',
            value: fmtBucketRange(peakBucket),
            sub: `${bucketTotals[peakBucket].toLocaleString('it-IT')} Prodotti · 7g`,
          },
          {
            label: 'Giorno più attivo',
            value: DAY_SHORT[peakDow],
            sub: `${dayTotals[peakDow].toLocaleString('it-IT')} Prodotti`,
          },
          {
            label: 'Prossimo picco previsto',
            value: predictNextPeak(grid, now),
            sub: 'su pattern storici',
          },
        ].map((item, i) => (
          <div key={i} className="hm-callout-card">
            <div className="hm-callout-label">{item.label}</div>
            <div className="hm-callout-value">{item.value}</div>
            <div className="hm-callout-sub">{item.sub}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
