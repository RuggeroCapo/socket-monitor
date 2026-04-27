'use client';

import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { ChartPoint } from '@/lib/dashboard-types';

type Props = {
  points: ChartPoint[];
  onRangeChange?: (selection: ChartRangeSelection) => void;
};

type PresetKey = '15m' | '30m' | '1h' | '6h' | '24h' | '7d';
type ChartRangeSelection = {
  since: string;
  until: string;
  rangeLabel: string;
  widthLabel: string;
};

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const PRESETS: { key: PresetKey; label: string; ms: number }[] = [
  { key: '15m', label: '15m', ms: 15 * MINUTE_MS },
  { key: '30m', label: '30m', ms: 30 * MINUTE_MS },
  { key: '1h',  label: '1h',  ms: HOUR_MS },
  { key: '6h',  label: '6h',  ms: 6 * HOUR_MS },
  { key: '24h', label: '24h', ms: DAY_MS },
  { key: '7d',  label: '7g',  ms: 7 * DAY_MS },
];

const DEFAULT_PRESET = PRESETS[1]; // 30m
const MIN_WINDOW_MS = PRESETS[0].ms;
const MAX_WINDOW_MS = PRESETS[PRESETS.length - 1].ms;
const STORAGE_KEY = 'vine.chart.preset';
// How close to the newest datapoint counts as "live" — absorbs drift during pan/zoom.
const LIVE_SNAP_MS = 2 * MINUTE_MS;
const DRAG_START_PX = 3;

const TIME_FMT = new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit' });
const DAY_FMT = new Intl.DateTimeFormat('it-IT', { weekday: 'short', day: 'numeric' });
const DATETIME_FMT = new Intl.DateTimeFormat('it-IT', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});
const TOOLTIP_FMT = new Intl.DateTimeFormat('it-IT', {
  weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
});
const CHART_COLORS = {
  grid: 'rgba(255,255,255,0.08)',
  tick: '#778392',
  cursor: '#a3e635',
  tooltipBg: '#202833',
  tooltipBorder: 'rgba(255,255,255,0.15)',
  tooltipText: '#f4f7fb',
  tooltipMuted: '#aab4c0',
  series: '#60a5fa',
  activeDotStroke: '#0d1117',
};

function clamp(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, value));
}

function formatTick(iso: string, widthMs: number): string {
  const d = new Date(iso);
  if (widthMs > 4 * DAY_MS) return DAY_FMT.format(d);
  if (widthMs > DAY_MS)     return DATETIME_FMT.format(d);
  return TIME_FMT.format(d);
}

function formatRange(fromMs: number, toMs: number): string {
  const sameDay = new Date(fromMs).toDateString() === new Date(toMs).toDateString();
  if (!sameDay || toMs - fromMs > DAY_MS) {
    return `${DATETIME_FMT.format(new Date(fromMs))} → ${DATETIME_FMT.format(new Date(toMs))}`;
  }
  return `${TIME_FMT.format(new Date(fromMs))} → ${TIME_FMT.format(new Date(toMs))}`;
}

function formatWidth(widthMs: number): string {
  if (widthMs < HOUR_MS) return `${Math.round(widthMs / MINUTE_MS)} min`;
  if (widthMs < DAY_MS) {
    const hours = widthMs / HOUR_MS;
    return Number.isInteger(hours) ? `${hours} h` : `${hours.toFixed(1)} h`;
  }
  const days = widthMs / DAY_MS;
  return Number.isInteger(days) ? `${days} g` : `${days.toFixed(1)} g`;
}

function presetKeyForWidth(widthMs: number): PresetKey | null {
  const tolerance = 30 * 1000;
  const hit = PRESETS.find((p) => Math.abs(p.ms - widthMs) <= tolerance);
  return hit ? hit.key : null;
}

export default function SevenDayChart({ points, onRangeChange }: Props) {
  const hasData = points.length > 1;
  const dataFromMs = hasData ? new Date(points[0].bucket).getTime() : 0;
  const dataToMs   = hasData ? new Date(points[points.length - 1].bucket).getTime() : 0;

  const [windowMs, setWindowMs] = useState<number>(DEFAULT_PRESET.ms);
  // anchorMs = null → live mode (right edge locked to newest datapoint).
  const [anchorMs, setAnchorMs] = useState<number | null>(null);
  const rangeIntentRef = useRef(false);
  const rangeNotifyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastEmittedRangeRef = useRef<string | null>(null);

  // Restore last preset from session storage after mount (avoid SSR mismatch).
  useEffect(() => {
    try {
      const saved = window.sessionStorage.getItem(STORAGE_KEY);
      const preset = PRESETS.find((p) => p.key === saved);
      if (preset) setWindowMs(preset.ms);
    } catch {
      // storage unavailable — keep default
    }
  }, []);

  const toMs = anchorMs ?? dataToMs;
  const fromMs = Math.max(dataFromMs, toMs - windowMs);
  const effectiveWidthMs = Math.max(1, toMs - fromMs);
  const isLive = anchorMs === null;
  const rangeLabel = hasData ? formatRange(fromMs, toMs) : '—';
  const widthLabel = formatWidth(effectiveWidthMs);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  // Keep the latest range in a ref so native listeners don't need to re-attach on every state change.
  const rangeRef = useRef({ fromMs, toMs, dataFromMs, dataToMs });
  useEffect(() => {
    rangeRef.current = { fromMs, toMs, dataFromMs, dataToMs };
  }, [fromMs, toMs, dataFromMs, dataToMs]);

  const applyRange = useCallback((nextFromMs: number, nextToMs: number) => {
    const { dataFromMs: dFrom, dataToMs: dTo } = rangeRef.current;
    const width = clamp(nextToMs - nextFromMs, MIN_WINDOW_MS, MAX_WINDOW_MS);
    const maxTo = dTo;
    const minTo = Math.min(dFrom + width, dTo);
    const to = clamp(nextToMs, minTo, maxTo);
    setWindowMs(width);
    // Snap to live if the right edge is within the threshold of the newest point.
    setAnchorMs(dTo - to <= LIVE_SNAP_MS ? null : to);
  }, []);

  const emitRangeSelection = useCallback((
    rangeFromMs = fromMs,
    rangeToMs = toMs,
    rangeWidthMs = effectiveWidthMs
  ) => {
    if (!hasData || rangeToMs <= rangeFromMs) return;

    const key = `${Math.round(rangeFromMs)}:${Math.round(rangeToMs)}`;
    if (lastEmittedRangeRef.current === key) return;
    lastEmittedRangeRef.current = key;

    onRangeChange?.({
      since: new Date(rangeFromMs).toISOString(),
      until: new Date(rangeToMs).toISOString(),
      rangeLabel: formatRange(rangeFromMs, rangeToMs),
      widthLabel: formatWidth(rangeWidthMs),
    });
  }, [effectiveWidthMs, fromMs, hasData, onRangeChange, toMs]);

  useEffect(() => {
    if (!rangeIntentRef.current || !hasData) return;
    if (rangeNotifyTimerRef.current) clearTimeout(rangeNotifyTimerRef.current);

    rangeNotifyTimerRef.current = setTimeout(() => {
      emitRangeSelection();
      rangeIntentRef.current = false;
    }, 220);

    return () => {
      if (rangeNotifyTimerRef.current) clearTimeout(rangeNotifyTimerRef.current);
    };
  }, [emitRangeSelection, hasData]);

  useEffect(() => {
    return () => {
      if (rangeNotifyTimerRef.current) clearTimeout(rangeNotifyTimerRef.current);
    };
  }, []);

  // Wheel: zoom (cursor-anchored) or pan (shift / horizontal trackpad).
  // Needs a native listener with passive: false to call preventDefault.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      const { fromMs: f, toMs: t } = rangeRef.current;
      const width = t - f;
      if (width <= 0) return;
      event.preventDefault();
      rangeIntentRef.current = true;

      const rect = el.getBoundingClientRect();
      const frac = clamp((event.clientX - rect.left) / rect.width, 0, 1);
      const cursorMs = f + frac * width;

      const horizontalIntent = Math.abs(event.deltaX) > Math.abs(event.deltaY);
      if (event.shiftKey || horizontalIntent) {
        const delta = event.shiftKey ? event.deltaY : event.deltaX;
        const panMs = (delta / rect.width) * width;
        applyRange(f + panMs, t + panMs);
        return;
      }

      const zoom = Math.exp(event.deltaY * 0.0015);
      const newWidth = clamp(width * zoom, MIN_WINDOW_MS, MAX_WINDOW_MS);
      applyRange(cursorMs - frac * newWidth, cursorMs + (1 - frac) * newWidth);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [applyRange]);

  // Drag to pan.
  const dragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startFromMs: number;
    startToMs: number;
    moved: boolean;
  } | null>(null);

  const handlePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!hasData) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    viewportRef.current?.setPointerCapture(event.pointerId);
    const { fromMs: f, toMs: t } = rangeRef.current;
    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startFromMs: f,
      startToMs: t,
      moved: false,
    };
  }, [hasData]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !viewportRef.current) return;
    const rect = viewportRef.current.getBoundingClientRect();
    const deltaPx = event.clientX - drag.startClientX;
    if (!drag.moved && Math.abs(deltaPx) < DRAG_START_PX) return;
    drag.moved = true;
    rangeIntentRef.current = true;
    const width = drag.startToMs - drag.startFromMs;
    const panMs = -(deltaPx / rect.width) * width;
    applyRange(drag.startFromMs + panMs, drag.startToMs + panMs);
  }, [applyRange]);

  const endDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    try { viewportRef.current?.releasePointerCapture(event.pointerId); } catch { /* noop */ }
    dragRef.current = null;
  }, []);

  const selectPreset = useCallback((presetKey: PresetKey) => {
    const preset = PRESETS.find((p) => p.key === presetKey);
    if (!preset) return;
    rangeIntentRef.current = true;
    setWindowMs(preset.ms);
    setAnchorMs(null);
    try { window.sessionStorage.setItem(STORAGE_KEY, preset.key); } catch { /* noop */ }
    const to = dataToMs || Date.now();
    const from = Math.max(dataFromMs || to - preset.ms, to - preset.ms);
    emitRangeSelection(from, to, to - from);
    rangeIntentRef.current = false;
  }, [dataFromMs, dataToMs, emitRangeSelection]);

  const goLive = useCallback(() => {
    rangeIntentRef.current = true;
    setAnchorMs(null);
  }, []);

  const handleDoubleClick = useCallback(() => {
    selectPreset(DEFAULT_PRESET.key);
  }, [selectPreset]);

  const handleKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!hasData) return;
    const { fromMs: f, toMs: t } = rangeRef.current;
    const width = t - f;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowRight': {
        event.preventDefault();
        rangeIntentRef.current = true;
        const dir = event.key === 'ArrowRight' ? 1 : -1;
        const step = width * 0.2 * dir;
        applyRange(f + step, t + step);
        break;
      }
      case '+':
      case '=': {
        event.preventDefault();
        rangeIntentRef.current = true;
        const center = (f + t) / 2;
        const w = clamp(width / 1.5, MIN_WINDOW_MS, MAX_WINDOW_MS);
        applyRange(center - w / 2, center + w / 2);
        break;
      }
      case '-':
      case '_': {
        event.preventDefault();
        rangeIntentRef.current = true;
        const center = (f + t) / 2;
        const w = clamp(width * 1.5, MIN_WINDOW_MS, MAX_WINDOW_MS);
        applyRange(center - w / 2, center + w / 2);
        break;
      }
      case 'Home':
      case 'Escape':
        event.preventDefault();
        goLive();
        break;
      default:
        break;
    }
  }, [hasData, applyRange, goLive]);

  const visible = useMemo(() => {
    if (!hasData) return [];
    return points.filter((p) => {
      const t = new Date(p.bucket).getTime();
      return t >= fromMs && t <= toMs;
    });
  }, [points, fromMs, toMs, hasData]);

  const activePreset = presetKeyForWidth(windowMs);

  return (
    <div className="chart-shell">
      <div className="chart-toolbar">
        <div className="chart-toolbar-info">
          <span className="chart-range-label">
            {rangeLabel}
          </span>
          <span className="chart-range-width">· {widthLabel}</span>
        </div>
        <div className="chart-toolbar-status">
          <span className={`chart-live-badge ${isLive ? 'live' : 'paused'}`}>
            <span className="chart-live-dot" />
            {isLive ? 'Live' : 'In pausa'}
          </span>
          {!isLive && (
            <button type="button" className="chart-back-to-live" onClick={goLive}>
              ↻ Torna a live
            </button>
          )}
        </div>
      </div>

      <div className="chart-preset-row" role="tablist" aria-label="Intervallo temporale">
        {PRESETS.map((preset) => {
          const active = activePreset === preset.key;
          return (
            <button
              key={preset.key}
              type="button"
              role="tab"
              aria-selected={active}
              className={`chart-preset ${active ? 'active' : ''}`}
              onClick={() => selectPreset(preset.key)}
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      <div
        ref={viewportRef}
        className="chart-viewport"
        role="application"
        aria-label={hasData ? `Grafico attività ${formatRange(fromMs, toMs)}` : 'Grafico attività'}
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
      >
        {hasData ? (
          <ResponsiveContainer>
            <AreaChart data={visible} margin={{ top: 12, right: 4, left: -18, bottom: 0 }}>
              <CartesianGrid stroke={CHART_COLORS.grid} strokeDasharray="2 4" vertical={false} />
              <XAxis
                dataKey="bucket"
                axisLine={false}
                tickLine={false}
                tick={{ fill: CHART_COLORS.tick, fontSize: 12 }}
                minTickGap={52}
                interval="preserveStartEnd"
                tickFormatter={(v: string) => formatTick(v, effectiveWidthMs)}
                tickMargin={10}
              />
              <YAxis
                allowDecimals={false}
                axisLine={false}
                tickLine={false}
                tick={{ fill: CHART_COLORS.tick, fontSize: 12 }}
                width={36}
                domain={[0, 'auto']}
                tickMargin={6}
              />
              <Tooltip
                cursor={{ stroke: CHART_COLORS.cursor, strokeWidth: 1 }}
                contentStyle={{
                  background: CHART_COLORS.tooltipBg,
                  border: `1px solid ${CHART_COLORS.tooltipBorder}`,
                  borderRadius: 6,
                  boxShadow: '0 14px 34px rgba(0,0,0,0.4)',
                  fontSize: 12,
                  padding: '8px 10px',
                  color: CHART_COLORS.tooltipText,
                }}
                labelStyle={{ color: CHART_COLORS.tooltipMuted, fontSize: 11, marginBottom: 4 }}
                itemStyle={{ color: CHART_COLORS.tooltipText, padding: 0 }}
                formatter={(value) => [value, 'Prodotti']}
                labelFormatter={(v: string) => TOOLTIP_FMT.format(new Date(v))}
              />
              <Area
                type="monotone"
                dataKey="added"
                stroke={CHART_COLORS.series}
                strokeWidth={2}
                fill={CHART_COLORS.series}
                fillOpacity={0.12}
                isAnimationActive={false}
                activeDot={{
                  r: 4,
                  fill: CHART_COLORS.series,
                  stroke: CHART_COLORS.activeDotStroke,
                  strokeWidth: 2,
                }}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="chart-empty">Caricamento serie storica…</div>
        )}
      </div>
    </div>
  );
}
