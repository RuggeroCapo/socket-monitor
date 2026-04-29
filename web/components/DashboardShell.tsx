'use client';

import {
  startTransition,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import SevenDayChart from '@/components/SevenDayChart';
import HourlyHeatmap from '@/components/HourlyHeatmap';
import { HEATMAP_BUCKET_OPTIONS } from '@/components/HourlyHeatmap';
import type { HeatmapBucketMinutes, HeatmapSelectedCell } from '@/components/HourlyHeatmap';
import { QUEUE_ORDER, queueLabel } from '@/lib/queues';
import { normalizeQueue } from '@/lib/queues';
import type {
  ChartPoint,
  ChartResponse,
  DashboardProduct,
  HealthResponse,
  ProductSortMode,
  ProductsResponse,
  QueueCode,
  SnapshotResponse,
  TimeFilter,
} from '@/lib/dashboard-types';
import type {
  LiveCollectorStatusEvent,
  LiveItemEvent,
  LiveItemValueUpdatedEvent,
} from '@/lib/live-bus';
import {
  HEATMAP_PALETTE_EVENT,
  HEATMAP_PALETTE_STORAGE_KEY,
  QUEUE_SOUND_AFA_STORAGE_KEY,
  QUEUE_SOUND_AI_STORAGE_KEY,
  QUEUE_SOUND_SETTINGS_EVENT,
  QUEUE_SOUND_TEST_EVENT,
  getStoredQueueSoundSetting,
  isHeatmapPalette,
} from '@/lib/ui-settings';
import type {
  HeatmapPalette,
  QueueSoundSetting,
  QueueSoundSettings,
  QueueSoundTestRequest,
} from '@/lib/ui-settings';

type Props = {
  initialSnapshot: SnapshotResponse;
  initialHealth: HealthResponse;
};

type QueueFilter = 'ALL' | QueueCode;
type MetricIconKind = 'box' | 'spark' | 'bolt' | 'coin' | 'clock';
type NotificationTone = QueueSoundSetting;
type AudioContextCtor = typeof AudioContext;
type WindowWithWebkitAudioContext = Window &
  typeof globalThis & {
    webkitAudioContext?: AudioContextCtor;
  };

const QUEUE_FILTERS: QueueFilter[] = ['ALL', ...QUEUE_ORDER.filter((queue) => queue !== 'OTHER')];
const DISABLED_QUEUE_FILTERS = new Set<QueueFilter>(['RFY']);
const BEEP_COOLDOWN_MS = 250;
const PAGE_SIZE = 20;
const DAY_LABELS = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];
const FILTER_DATETIME_FORMATTER = new Intl.DateTimeFormat('it-IT', {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
const FILTER_TIME_FORMATTER = new Intl.DateTimeFormat('it-IT', {
  hour: '2-digit',
  minute: '2-digit',
});
const HEATMAP_BUCKET_STORAGE_KEY = 'dashboard.heatmap.bucketMinutes';

function getStoredHeatmapPalette(): HeatmapPalette {
  if (typeof window === 'undefined') return 'viridis';
  const rawValue = window.localStorage.getItem(HEATMAP_PALETTE_STORAGE_KEY);
  return isHeatmapPalette(rawValue) ? rawValue : 'viridis';
}

function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;

  return (
    window.AudioContext ??
    (window as WindowWithWebkitAudioContext).webkitAudioContext ??
    null
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function buildProductsSearchParams({
  offset,
  limit,
  queueFilter,
  search,
  sortMode,
  timeFilter,
}: {
  offset: number;
  limit: number;
  queueFilter: QueueFilter;
  search: string;
  sortMode: ProductSortMode;
  timeFilter: TimeFilter | null;
}): string {
  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(limit),
    sort: sortMode,
  });
  if (search) params.set('search', search);
  if (queueFilter !== 'ALL') params.set('queue', queueFilter);
  if (timeFilter) {
    params.set('since', timeFilter.since);
    params.set('until', timeFilter.until);
  }
  return params.toString();
}

function relTime(iso: string | null, now: number): string {
  if (!iso) return '—';
  const delta = now - new Date(iso).getTime();
  if (delta < 0) return 'adesso';

  const seconds = Math.round(delta / 1000);
  if (seconds < 5) return 'adesso';
  if (seconds < 60) return `${seconds}s fa`;

  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min fa`;

  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h fa`;

  return `${Math.round(hours / 24)} g fa`;
}

function formatMoney(value: number | null, currency: string | null): string {
  if (value == null) return 'Valore n/d';
  try {
    return new Intl.NumberFormat('it-IT', {
      style: 'currency',
      currency: currency || 'EUR',
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${value.toLocaleString('it-IT')} ${currency || 'EUR'}`;
  }
}

function compactNumber(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '0';
  return value.toLocaleString('it-IT');
}

function padHour(value: number): string {
  return String(value).padStart(2, '0');
}

function formatHeatmapBucketRange(bIdx: number, bucketMinutes: HeatmapBucketMinutes): string {
  const startMinutes = bIdx * bucketMinutes;
  const endMinutes = startMinutes + bucketMinutes;
  const format = (totalMinutes: number) => {
    const normalized = ((totalMinutes % 1440) + 1440) % 1440;
    const hours = Math.floor(normalized / 60);
    const minutes = normalized % 60;
    return `${padHour(hours)}:${padHour(minutes)}`;
  };

  return `${format(startMinutes)}-${format(endMinutes)}`;
}

function formatHeatmapBucketLabel(bucketMinutes: HeatmapBucketMinutes): string {
  return bucketMinutes < 60 ? `${bucketMinutes}M` : `${bucketMinutes / 60}H`;
}

function getStoredHeatmapBucketMinutesOrDefault(
  fallback: HeatmapBucketMinutes
): HeatmapBucketMinutes {
  if (typeof window === 'undefined') return fallback;
  const rawValue = window.localStorage.getItem(HEATMAP_BUCKET_STORAGE_KEY);
  if (!rawValue) return fallback;
  const parsed = Number(rawValue);
  if (
    Number.isFinite(parsed) &&
    HEATMAP_BUCKET_OPTIONS.includes(parsed as HeatmapBucketMinutes)
  ) {
    return parsed as HeatmapBucketMinutes;
  }
  return fallback;
}

function parseHeatmapDayKey(dayKey: string): Date | null {
  const [year, month, day] = dayKey.split('-').map(Number);
  if (!year || !month || !day) return null;

  const date = new Date(year, month - 1, day);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }

  return date;
}

function formatHeatmapDayLabel(dayKey: string): string {
  const date = parseHeatmapDayKey(dayKey);
  if (!date) return dayKey;

  return `${DAY_LABELS[date.getDay()]} ${padHour(date.getDate())}/${padHour(date.getMonth() + 1)}`;
}

function formatFilterRange(since: string, until: string): string {
  return `${FILTER_DATETIME_FORMATTER.format(new Date(since))} -> ${FILTER_DATETIME_FORMATTER.format(new Date(until))}`;
}

function MetricIcon({ kind }: { kind: MetricIconKind }) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
  };

  return (
    <span className="metric-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" role="presentation">
        {kind === 'box' && (
          <>
            <path {...common} d="M4 8.5 12 4l8 4.5v7L12 20l-8-4.5z" />
            <path {...common} d="M12 20v-7" />
            <path {...common} d="M4 8.5 12 13l8-4.5" />
          </>
        )}
        {kind === 'spark' && (
          <>
            <path {...common} d="M12 4v4" />
            <path {...common} d="M12 16v4" />
            <path {...common} d="M4 12h4" />
            <path {...common} d="M16 12h4" />
            <circle {...common} cx="12" cy="12" r="4.5" />
          </>
        )}
        {kind === 'bolt' && <path {...common} d="M13 2 6 13h5l-1 9 8-12h-5z" />}
        {kind === 'coin' && (
          <>
            <circle {...common} cx="12" cy="12" r="7.5" />
            <path {...common} d="M14.8 9.3c-.5-.8-1.5-1.3-2.8-1.3-1.8 0-3 .9-3 2.3 0 3 6 1.1 6 4 0 1.4-1.2 2.3-3 2.3-1.4 0-2.5-.5-3.1-1.4" />
            <path {...common} d="M12 7v10" />
          </>
        )}
        {kind === 'clock' && (
          <>
            <circle {...common} cx="12" cy="12" r="7.5" />
            <path {...common} d="M12 7.5v5l3.2 1.8" />
          </>
        )}
      </svg>
    </span>
  );
}

function applyLiveEvent(prev: SnapshotResponse, ts: string): SnapshotResponse {
  const eventDay = new Date(ts).toISOString().slice(0, 10);
  const eventHour = new Date(ts);
  eventHour.setUTCMinutes(0, 0, 0);
  const eventBucket = eventHour.toISOString();

  return {
    ...prev,
    added_7d: prev.added_7d + 1,
    added_24h: prev.added_24h + 1,
    added_1h: prev.added_1h + 1,
    daily_counts: prev.daily_counts.map((bucket) =>
      bucket.day.slice(0, 10) === eventDay
        ? { ...bucket, added: bucket.added + 1 }
        : bucket
    ),
    hourly_activity_24h: prev.hourly_activity_24h.map((bucket) =>
      bucket.bucket === eventBucket
        ? { ...bucket, added: bucket.added + 1 }
        : bucket
    ),
    as_of: new Date().toISOString(),
  };
}

function applyCollectorStatus(
  prev: HealthResponse,
  event: LiveCollectorStatusEvent
): HealthResponse {
  return {
    ...prev,
    collector_status: event.status,
    gap_open: event.status === 'offline',
    last_collector_event: {
      event_type: event.event_type,
      time: event.ts,
    },
    as_of: new Date().toISOString(),
  };
}

function applyCollectorActivity(prev: HealthResponse): HealthResponse {
  if (prev.collector_status === 'online' && !prev.gap_open) {
    return {
      ...prev,
      as_of: new Date().toISOString(),
    };
  }

  return {
    ...prev,
    collector_status: 'online',
    gap_open: false,
    as_of: new Date().toISOString(),
  };
}

function applyItemValueUpdate(
  prev: SnapshotResponse,
  event: LiveItemValueUpdatedEvent
): SnapshotResponse {
  return {
    ...prev,
    recent_products: prev.recent_products.map((product) =>
      product.asin === event.a
        ? {
          ...product,
          item_value: event.item_value,
          currency: event.currency ?? product.currency ?? 'EUR',
        }
        : product
    ),
    as_of: new Date().toISOString(),
  };
}

function isItemAddedEvent(payload: unknown): payload is LiveItemEvent {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { t?: unknown }).t === 'item_added' &&
    typeof (payload as { a?: unknown }).a === 'string' &&
    (typeof (payload as { queue?: unknown }).queue === 'string' ||
      (payload as { queue?: unknown }).queue === null ||
      typeof (payload as { queue?: unknown }).queue === 'undefined') &&
    typeof (payload as { ts?: unknown }).ts === 'string'
  );
}

function isItemValueUpdatedEvent(payload: unknown): payload is LiveItemValueUpdatedEvent {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { t?: unknown }).t === 'item_value_updated' &&
    typeof (payload as { a?: unknown }).a === 'string' &&
    typeof (payload as { item_value?: unknown }).item_value === 'number' &&
    Number.isFinite((payload as { item_value: number }).item_value) &&
    (typeof (payload as { currency?: unknown }).currency === 'string' ||
      (payload as { currency?: unknown }).currency === null ||
      typeof (payload as { currency?: unknown }).currency === 'undefined') &&
    typeof (payload as { ts?: unknown }).ts === 'string'
  );
}

function isCollectorStatusEvent(payload: unknown): payload is LiveCollectorStatusEvent {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { t?: unknown }).t === 'collector_status' &&
    ((payload as { status?: unknown }).status === 'online' ||
      (payload as { status?: unknown }).status === 'offline') &&
    typeof (payload as { event_type?: unknown }).event_type === 'string' &&
    typeof (payload as { ts?: unknown }).ts === 'string'
  );
}

export default function DashboardShell({ initialSnapshot, initialHealth }: Props) {
  const initialNowMs = useMemo(() => {
    const snapshotMs = new Date(initialSnapshot.as_of).getTime();
    if (Number.isFinite(snapshotMs)) return snapshotMs;
    const healthMs = new Date(initialHealth.as_of).getTime();
    if (Number.isFinite(healthMs)) return healthMs;
    return 0;
  }, [initialHealth.as_of, initialSnapshot.as_of]);

  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [health, setHealth] = useState(initialHealth);
  const [search, setSearch] = useState('');
  const [queueFilter, setQueueFilter] = useState<QueueFilter>('ALL');
  const [sortMode, setSortMode] = useState<ProductSortMode>('newest');
  const [products, setProducts] = useState<DashboardProduct[]>(initialSnapshot.recent_products);
  const [productsTotal, setProductsTotal] = useState(
    Number.isFinite(initialSnapshot.total_products) ? initialSnapshot.total_products : 0
  );
  const [hasMore, setHasMore] = useState(initialSnapshot.recent_products.length < initialSnapshot.total_products);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [isRefreshingProducts, setIsRefreshingProducts] = useState(false);
  const [now, setNow] = useState(initialNowMs);
  const [isSyncing, setIsSyncing] = useState(false);
  const [chartPoints, setChartPoints] = useState<ChartPoint[]>([]);
  const [timeFilter, setTimeFilter] = useState<TimeFilter | null>(null);
  const [heatmapBucketMinutes, setHeatmapBucketMinutes] = useState<HeatmapBucketMinutes>(180);
  const [heatmapPalette, setHeatmapPalette] = useState<HeatmapPalette>('viridis');
  const [pickedCell, setPickedCell] = useState<HeatmapSelectedCell | null>(null);
  const [tickerItem, setTickerItem] = useState<DashboardProduct | null>(null);
  const [queueSoundSettings, setQueueSoundSettings] = useState<QueueSoundSettings>(() => ({
    AI: getStoredQueueSoundSetting(QUEUE_SOUND_AI_STORAGE_KEY, 'soft'),
    AFA: getStoredQueueSoundSetting(QUEUE_SOUND_AFA_STORAGE_KEY, 'alert'),
  }));
  const deferredSearch = useDeferredValue(search.trim());

  const eventSourceRef = useRef<EventSource | null>(null);
  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const productsRefreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const lastBeepAtRef = useRef(0);
  const productsAbortRef = useRef<AbortController | null>(null);
  const productsRequestIdRef = useRef(0);
  const hasInitializedProductsRef = useRef(false);
  const productsLengthRef = useRef(initialSnapshot.recent_products.length);
  const pendingTickerAsinRef = useRef<string | null>(null);
  const tickerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const productsQueryRef = useRef<{
    queueFilter: QueueFilter;
    search: string;
    sortMode: ProductSortMode;
    timeFilter: TimeFilter | null;
  }>({
    queueFilter: 'ALL',
    search: '',
    sortMode: 'newest',
    timeFilter: null,
  });

  const primeAudioContext = async (): Promise<AudioContext | null> => {
    const AudioContextCtor = getAudioContextCtor();
    if (!AudioContextCtor) return null;

    const context = audioContextRef.current ?? new AudioContextCtor();
    audioContextRef.current = context;

    if (context.state === 'suspended') {
      try {
        await context.resume();
      } catch {
        return context;
      }
    }

    return context;
  };

  const playPulse = (
    context: AudioContext,
    startAt: number,
    frequency: number,
    duration: number,
    type: OscillatorType,
    peakGain: number
  ) => {
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, startAt);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(peakGain, startAt + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start(startAt);
    oscillator.stop(startAt + duration);
  };

  const playNotificationBeep = async (tone: NotificationTone = 'soft') => {
    if (tone === 'off') return;
    const nowMs = Date.now();
    if (nowMs - lastBeepAtRef.current < BEEP_COOLDOWN_MS) return;

    const context = await primeAudioContext();
    if (!context || context.state !== 'running') return;
    lastBeepAtRef.current = nowMs;

    const startAt = context.currentTime;

    if (tone === 'alert') {
      playPulse(context, startAt, 659.25, 0.09, 'sine', 0.09);
      playPulse(context, startAt + 0.11, 987.77, 0.16, 'sine', 0.11);
      return;
    }

    if (tone === 'chime') {
      playPulse(context, startAt, 523.25, 0.08, 'triangle', 0.06);
      playPulse(context, startAt + 0.09, 659.25, 0.11, 'triangle', 0.07);
      playPulse(context, startAt + 0.22, 783.99, 0.13, 'triangle', 0.075);
      return;
    }

    if (tone === 'ping') {
      playPulse(context, startAt, 1174.66, 0.08, 'sine', 0.06);
      return;
    }

    if (tone === 'bell') {
      playPulse(context, startAt, 987.77, 0.14, 'sine', 0.07);
      playPulse(context, startAt + 0.04, 1318.51, 0.2, 'triangle', 0.045);
      return;
    }

    if (tone === 'pulse') {
      playPulse(context, startAt, 660, 0.07, 'square', 0.045);
      playPulse(context, startAt + 0.09, 660, 0.07, 'square', 0.05);
      playPulse(context, startAt + 0.18, 660, 0.08, 'square', 0.055);
      return;
    }

    playPulse(context, startAt, 880, 0.15, 'triangle', 0.055);
  };

  const fetchProducts = async ({
    offset,
    limit,
    replace,
  }: {
    offset: number;
    limit: number;
    replace: boolean;
  }) => {
    if (!replace && isLoadingMore) return;

    const requestId = productsRequestIdRef.current + 1;
    productsRequestIdRef.current = requestId;
    setIsLoadingMore(false);
    setIsRefreshingProducts(false);
    productsAbortRef.current?.abort();
    const controller = new AbortController();
    productsAbortRef.current = controller;
    const query = productsQueryRef.current;

    if (replace) {
      setIsRefreshingProducts(true);
    } else {
      setIsLoadingMore(true);
    }

    try {
      const response = await fetch(
        `/api/products?${buildProductsSearchParams({
          offset,
          limit,
          queueFilter: query.queueFilter,
          search: query.search,
          sortMode: query.sortMode,
          timeFilter: query.timeFilter,
        })}`,
        {
          cache: 'no-store',
          signal: controller.signal,
        }
      );
      if (!response.ok) return;
      const data = (await response.json()) as ProductsResponse;
      if (productsRequestIdRef.current !== requestId) return;
      startTransition(() => {
        setProducts((current) => {
          const next = replace ? data.products : [...current, ...data.products];
          productsLengthRef.current = next.length;
          // Resolve pending ticker: find freshly-arrived product
          const pending = pendingTickerAsinRef.current;
          if (pending && replace) {
            const match = next.find(p => p.asin === pending);
            if (match) {
              pendingTickerAsinRef.current = null;
              setTickerItem(match);
              if (tickerTimerRef.current) clearTimeout(tickerTimerRef.current);
              tickerTimerRef.current = setTimeout(() => setTickerItem(null), 4500);
            }
          }
          return next;
        });
        const nextTotal = Number.isFinite(data.total) ? data.total : 0;
        setProductsTotal(nextTotal);
        setHasMore(offset + data.products.length < nextTotal);
      });
    } catch (error) {
      if (!isAbortError(error)) {
        // ignore network failures
      }
    } finally {
      if (productsRequestIdRef.current === requestId) {
        if (replace) {
          setIsRefreshingProducts(false);
        } else {
          setIsLoadingMore(false);
        }
      }
    }
  };

  const refreshProducts = async (limit = PAGE_SIZE) => {
    await fetchProducts({ offset: 0, limit, replace: true });
  };

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    const handleQueueSoundSettingsChange = (event: Event) => {
      const detail = (event as CustomEvent<QueueSoundSettings>).detail;
      if (!detail) return;
      setQueueSoundSettings((current) => ({
        AI: detail.AI ?? current.AI,
        AFA: detail.AFA ?? current.AFA,
      }));
    };
    const handleStorageChange = (event: StorageEvent) => {
      if (event.key === QUEUE_SOUND_AI_STORAGE_KEY) {
        setQueueSoundSettings((current) => ({
          ...current,
          AI: getStoredQueueSoundSetting(QUEUE_SOUND_AI_STORAGE_KEY, current.AI),
        }));
      }
      if (event.key === QUEUE_SOUND_AFA_STORAGE_KEY) {
        setQueueSoundSettings((current) => ({
          ...current,
          AFA: getStoredQueueSoundSetting(QUEUE_SOUND_AFA_STORAGE_KEY, current.AFA),
        }));
      }
    };
    const handleQueueSoundTest = (event: Event) => {
      const detail = (event as CustomEvent<QueueSoundTestRequest>).detail;
      if (!detail?.sound || detail.sound === 'off') return;
      void playNotificationBeep(detail.sound);
    };
    window.addEventListener(QUEUE_SOUND_SETTINGS_EVENT, handleQueueSoundSettingsChange);
    window.addEventListener(QUEUE_SOUND_TEST_EVENT, handleQueueSoundTest);
    window.addEventListener('storage', handleStorageChange);
    return () => {
      window.removeEventListener(QUEUE_SOUND_SETTINGS_EVENT, handleQueueSoundSettingsChange);
      window.removeEventListener(QUEUE_SOUND_TEST_EVENT, handleQueueSoundTest);
      window.removeEventListener('storage', handleStorageChange);
    };
  }, []);

  useEffect(() => {
    return () => {
      productsAbortRef.current?.abort();
      if (refreshTimeoutRef.current) clearTimeout(refreshTimeoutRef.current);
      if (productsRefreshTimeoutRef.current) clearTimeout(productsRefreshTimeoutRef.current);
      if (tickerTimerRef.current) clearTimeout(tickerTimerRef.current);
      const context = audioContextRef.current;
      audioContextRef.current = null;
      if (!context) return;
      void context.close().catch(() => { });
    };
  }, []);

  useEffect(() => {
    const activateAudio = () => {
      void primeAudioContext();
    };

    window.addEventListener('pointerdown', activateAudio, { once: true });
    window.addEventListener('keydown', activateAudio, { once: true });

    return () => {
      window.removeEventListener('pointerdown', activateAudio);
      window.removeEventListener('keydown', activateAudio);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const fetchChart = async () => {
      try {
        const response = await fetch('/api/chart', { cache: 'no-store' });
        if (!response.ok) return;
        const data = (await response.json()) as ChartResponse;
        if (cancelled) return;
        setChartPoints(data.points);
      } catch {
        // ignore
      }
    };
    void fetchChart();
    const id = setInterval(() => { void fetchChart(); }, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    productsQueryRef.current = {
      queueFilter,
      search: deferredSearch,
      sortMode,
      timeFilter,
    };
    if (!hasInitializedProductsRef.current) {
      hasInitializedProductsRef.current = true;
      return;
    }
    void refreshProducts(PAGE_SIZE);
  }, [deferredSearch, queueFilter, sortMode, timeFilter]);

  useEffect(() => {
    setHeatmapBucketMinutes(getStoredHeatmapBucketMinutesOrDefault(180));
    setHeatmapPalette(getStoredHeatmapPalette());
  }, []);

  useEffect(() => {
    window.localStorage.setItem(
      HEATMAP_BUCKET_STORAGE_KEY,
      String(heatmapBucketMinutes)
    );
  }, [heatmapBucketMinutes]);

  useEffect(() => {
    const handlePaletteChange = (event: Event) => {
      const nextPalette = (event as CustomEvent<HeatmapPalette>).detail;
      if (isHeatmapPalette(nextPalette)) {
        setHeatmapPalette(nextPalette);
      }
    };
    const handleStorageChange = (event: StorageEvent) => {
      if (
        event.key === HEATMAP_PALETTE_STORAGE_KEY &&
        isHeatmapPalette(event.newValue)
      ) {
        setHeatmapPalette(event.newValue);
      }
    };

    window.addEventListener(HEATMAP_PALETTE_EVENT, handlePaletteChange);
    window.addEventListener('storage', handleStorageChange);
    return () => {
      window.removeEventListener(HEATMAP_PALETTE_EVENT, handlePaletteChange);
      window.removeEventListener('storage', handleStorageChange);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const refreshSnapshot = async () => {
      setIsSyncing(true);
      try {
        const response = await fetch('/api/live/snapshot', { cache: 'no-store' });
        if (!response.ok) return;
        const next = (await response.json()) as SnapshotResponse;
        if (cancelled) return;
        startTransition(() => {
          setSnapshot(next);
        });
      } catch {
        // ignore
      } finally {
        if (!cancelled) setIsSyncing(false);
      }
    };

    const scheduleSnapshotRefresh = (delay = 700) => {
      if (refreshTimeoutRef.current) clearTimeout(refreshTimeoutRef.current);
      refreshTimeoutRef.current = setTimeout(() => {
        void refreshSnapshot();
      }, delay);
    };

    const scheduleProductsRefresh = (delay = 700) => {
      if (productsRefreshTimeoutRef.current) clearTimeout(productsRefreshTimeoutRef.current);
      productsRefreshTimeoutRef.current = setTimeout(() => {
        void refreshProducts(Math.max(productsLengthRef.current, PAGE_SIZE));
      }, delay);
    };

    let retryDelay = 1000;
    const open = () => {
      if (cancelled) return;
      const source = new EventSource('/api/live');
      eventSourceRef.current = source;
      source.onopen = () => {
        retryDelay = 1000;
        scheduleSnapshotRefresh(0);
      };
      source.onmessage = (event) => {
        try {
          const payload: unknown = JSON.parse(event.data);
          if (isItemAddedEvent(payload)) {
            startTransition(() => {
              setSnapshot((current) => applyLiveEvent(current, payload.ts));
              setHealth((current) => applyCollectorActivity(current));
            });
            const normalizedQueue = normalizeQueue(payload.queue);
            if (normalizedQueue === 'AI') {
              const sound = queueSoundSettings.AI;
              if (sound !== 'off') {
                void playNotificationBeep(sound);
              }
            } else if (normalizedQueue === 'AFA') {
              const sound = queueSoundSettings.AFA;
              if (sound !== 'off') {
                void playNotificationBeep(sound);
              }
            }
            // Stage the asin for ticker display once the products refresh resolves
            pendingTickerAsinRef.current = payload.a;
            scheduleSnapshotRefresh();
            scheduleProductsRefresh();
            return;
          }
          if (isItemValueUpdatedEvent(payload)) {
            startTransition(() => {
              setSnapshot((current) => applyItemValueUpdate(current, payload));
              setHealth((current) => applyCollectorActivity(current));
            });
            scheduleSnapshotRefresh();
            scheduleProductsRefresh();
            return;
          }
          if (isCollectorStatusEvent(payload)) {
            startTransition(() => {
              setHealth((current) => applyCollectorStatus(current, payload));
            });
          }
        } catch {
          // ignore malformed events
        }
      };
      source.onerror = () => {
        source.close();
        eventSourceRef.current = null;
        if (cancelled) return;
        const nextDelay = retryDelay;
        retryDelay = Math.min(retryDelay * 2, 30_000);
        setTimeout(open, nextDelay);
      };
    };

    open();

    return () => {
      cancelled = true;
      if (refreshTimeoutRef.current) clearTimeout(refreshTimeoutRef.current);
      if (productsRefreshTimeoutRef.current) clearTimeout(productsRefreshTimeoutRef.current);
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, [queueSoundSettings]);

  useEffect(() => {
    let cancelled = false;

    const refreshHealth = async () => {
      try {
        const response = await fetch('/api/health', { cache: 'no-store' });
        if (!response.ok) return;
        const next = (await response.json()) as HealthResponse;
        if (cancelled) return;
        startTransition(() => {
          setHealth(next);
        });
      } catch {
        // ignore
      }
    };

    void refreshHealth();
    const id = setInterval(() => {
      void refreshHealth();
    }, 30_000);

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const loadMore = async () => {
    if (isRefreshingProducts) return;
    await fetchProducts({ offset: products.length, limit: PAGE_SIZE, replace: false });
  };

  const handleHeatmapBucketChange = (bucketMinutes: HeatmapBucketMinutes) => {
    setHeatmapBucketMinutes(bucketMinutes);
    setPickedCell(null);
    if (timeFilter?.source === 'heatmap') {
      setTimeFilter(null);
    }
  };

  const handlePickCell = (
    dayKey: string,
    bIdx: number,
    bucketMinutes: HeatmapBucketMinutes
  ) => {
    if (
      pickedCell?.dayKey === dayKey &&
      pickedCell?.bIdx === bIdx &&
      pickedCell?.bucketMinutes === bucketMinutes
    ) {
      // Toggle off
      setPickedCell(null);
      setTimeFilter(null);
      return;
    }
    // The heatmap rows are concrete rolling dates, so the clicked row maps directly to one day.
    const nowMs = Date.now();
    const bucketStartMinutes = bIdx * bucketMinutes;
    const targetDate = parseHeatmapDayKey(dayKey);
    if (!targetDate) return;
    targetDate.setHours(
      Math.floor(bucketStartMinutes / 60),
      bucketStartMinutes % 60,
      0,
      0
    );
    const targetMs = targetDate.getTime();
    if (targetMs > nowMs) return;
    const sinceMs = targetMs;
    const untilMs = targetMs + bucketMinutes * 60_000;
    const since = new Date(sinceMs).toISOString();
    const until = new Date(untilMs).toISOString();
    const hourLabel = formatHeatmapBucketRange(bIdx, bucketMinutes);
    const dateLabel = FILTER_DATETIME_FORMATTER.format(new Date(sinceMs));
    const untilLabel = FILTER_TIME_FORMATTER.format(new Date(untilMs));
    setPickedCell({ dayKey, bIdx, bucketMinutes });
    setTimeFilter({
      since,
      until,
      source: 'heatmap',
      label: `Heatmap · ${formatHeatmapDayLabel(dayKey)} ${hourLabel} (${dateLabel} -> ${untilLabel})`,
    });
  };

  const clearFilters = () => {
    setTimeFilter(null);
    setPickedCell(null);
    setQueueFilter('ALL');
    setSearch('');
  };

  const latestEventTime = snapshot.recent_products[0]?.event_time ?? health.last_event_time;
  const queueCounts = new Map<QueueCode, number>(
    snapshot.queue_totals.map(({ queue, count }) => [queue, count])
  );
  const visibleProducts = useMemo(() => {
    const normalizedSearch = deferredSearch.toLowerCase();
    const sinceMs = timeFilter ? new Date(timeFilter.since).getTime() : null;
    const untilMs = timeFilter ? new Date(timeFilter.until).getTime() : null;

    return products.filter((product) => {
      if (queueFilter !== 'ALL' && product.queue !== queueFilter) return false;
      if (normalizedSearch) {
        const asin = product.asin.toLowerCase();
        const title = product.title?.toLowerCase() ?? '';
        if (!asin.includes(normalizedSearch) && !title.includes(normalizedSearch)) return false;
      }
      if (sinceMs !== null || untilMs !== null) {
        const productMs = new Date(product.event_time).getTime();
        if (sinceMs !== null && productMs < sinceMs) return false;
        if (untilMs !== null && productMs > untilMs) return false;
      }
      return true;
    });
  }, [deferredSearch, products, queueFilter, timeFilter]);
  const hasActiveFilters = Boolean(
    timeFilter || pickedCell || queueFilter !== 'ALL' || deferredSearch
  );
  const showProductsLoading = isRefreshingProducts && visibleProducts.length === 0;
  const addedToday = snapshot.daily_counts[snapshot.daily_counts.length - 1]?.added ?? 0;

  return (
    <main className="dashboard-shell">
      <section className="metric-strip">
        <article className="metric-card metric-card-accent">
          <div className="metric-topline">
            <MetricIcon kind="clock" />
            <span className="metric-label">Tempo dall&apos;ultimo drop</span>
          </div>
          <strong className="metric-value">{relTime(latestEventTime, now)}</strong>
          <p className="metric-sub">ultimo item rilevato dal collector</p>
        </article>
        <article className="metric-card">
          <div className="metric-topline">
            <MetricIcon kind="spark" />
            <span className="metric-label">Nuovi oggi</span>
          </div>
          <strong className="metric-value">{compactNumber(addedToday)}</strong>
          <p className="metric-sub">dalle 00:00 di oggi</p>
        </article>
        <article className="metric-card">
          <div className="metric-topline">
            <MetricIcon kind="bolt" />
            <span className="metric-label">Velocità attuale</span>
          </div>
          <strong className="metric-value">{compactNumber(snapshot.added_1h)}</strong>
          <p className="metric-sub">prodotti nell&apos;ultima ora</p>
        </article>
        <article className="metric-card">
          <div className="metric-topline">
            <MetricIcon kind="coin" />
            <span className="metric-label">Valore totale 24h</span>
          </div>
          <strong className="metric-value">
            {formatMoney(snapshot.tracked_value_24h, 'EUR')}
          </strong>
          <p className="metric-sub">
            media {formatMoney(snapshot.avg_item_value_24h, 'EUR')} / prodotto
          </p>
        </article>
        <article className="metric-card">
          <div className="metric-topline">
            <MetricIcon kind="box" />
            <span className="metric-label">Totale 7g</span>
          </div>
          <strong className="metric-value">{compactNumber(snapshot.added_7d)}</strong>
          <p className="metric-sub">prodotti trovati</p>
        </article>
      </section>

      <section className="chart-section">
        <article className="panel rail-panel heatmap-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">PATTERN 7G × {formatHeatmapBucketLabel(heatmapBucketMinutes)}</p>
              <h2 className="panel-title">Heatmap attività</h2>
            </div>
            <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'JetBrains Mono, monospace' }}>
              click cella per filtrare
            </span>
          </div>
          <HourlyHeatmap
            chartPoints={chartPoints}
            now={now}
            bucketMinutes={heatmapBucketMinutes}
            palette={heatmapPalette}
            selectedCell={pickedCell}
            onBucketMinutesChange={handleHeatmapBucketChange}
            onPickCell={handlePickCell}
          />
        </article>
        <article className="panel chart-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">ATTIVITÀ LIVE</p>
              <h2 className="panel-title">Pie chart giornaliera</h2>
            </div>
          </div>
          <SevenDayChart points={chartPoints} />
        </article>
      </section>

      {hasActiveFilters && (
        <div className="active-filter-banner">
          <div className="active-filter-banner-chips">
            <span className="active-filter-label">Filtri attivi ·</span>
            {queueFilter !== 'ALL' && (
              <span className="active-filter-chip">
                coda {queueLabel(queueFilter)}
              </span>
            )}
            {deferredSearch && (
              <span className="active-filter-chip">
                ricerca "{deferredSearch}"
              </span>
            )}
            {timeFilter && (
              <span className="active-filter-chip">
                {timeFilter.label ?? formatFilterRange(timeFilter.since, timeFilter.until)}
              </span>
            )}
            {pickedCell && !timeFilter && (
              <span className="active-filter-chip">
                {formatHeatmapDayLabel(pickedCell.dayKey)}
                {' '}
                {formatHeatmapBucketRange(pickedCell.bIdx, pickedCell.bucketMinutes)}
              </span>
            )}
            <span className="active-filter-label">
              · {(Number.isFinite(productsTotal) ? productsTotal : 0).toLocaleString('it-IT')} risultati
            </span>
          </div>
          <button type="button" className="active-filter-clear" onClick={clearFilters}>
            cancella ✕
          </button>
        </div>
      )}

      <section className="panel products-panel">
        <div className="products-header">
          <div>
            <p className="eyebrow">ULTIMI PRODOTTI</p>
            <h2 className="panel-title">Feed in tempo reale</h2>
            <p className="products-sub">
              Valori indicativi: possibili ritardi o imprecisioni.
            </p>
          </div>

          <div className="products-controls">
            <input
              className="search-input"
              type="search"
              aria-label="Cerca prodotti per titolo o ASIN"
              placeholder="Cerca titolo o ASIN"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <select
              className="sort-select"
              aria-label="Ordina prodotti"
              value={sortMode}
              onChange={(event) => setSortMode(event.target.value as ProductSortMode)}
            >
              <option value="newest">Più recenti</option>
              <option value="value_desc">Valore alto</option>
              <option value="value_asc">Valore basso</option>
            </select>
          </div>
        </div>

        <div className="queue-filter-row">
          {QUEUE_FILTERS.map((queue) => {
            const isDisabled = DISABLED_QUEUE_FILTERS.has(queue);
            const count =
              queue === queueFilter
                ? productsTotal
                : queue === 'ALL'
                ? snapshot.total_products
                : queueCounts.get(queue) ?? 0;

            return (
              <button
                key={queue}
                type="button"
                className={`queue-pill ${queueFilter === queue ? 'active' : ''}`}
                data-queue={queue}
                aria-pressed={queueFilter === queue}
                disabled={isDisabled}
                aria-disabled={isDisabled}
                onClick={() => {
                  if (isDisabled) return;
                  setQueueFilter(queue);
                }}
              >
                {queueLabel(queue)}
                <span>
                  {isDisabled ? 'n/d' : count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="products-grid">
          {showProductsLoading ? (
            <div className="empty-state">
              Caricamento prodotti per il periodo selezionato…
            </div>
          ) : visibleProducts.length === 0 ? (
            <div className="empty-state">
              Nessun prodotto corrisponde ai filtri correnti.
            </div>
          ) : (
            visibleProducts.map((product) => {
              const isFresh = now - new Date(product.event_time).getTime() < 90_000;

              return (
                <a
                  key={`${product.asin}-${product.event_time}`}
                  className={`product-card ${isFresh ? 'fresh' : ''}`}
                  href={product.detail_url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`${product.title || product.asin}, ${queueLabel(product.queue)}, ${formatMoney(product.item_value, product.currency)}`}
                >
                  <div className="product-thumb">
                    {product.image_url ? (
                      <img src={product.image_url} alt={product.title || product.asin} />
                    ) : (
                      <span>{product.asin.slice(0, 6)}</span>
                    )}
                    <span className={`queue-badge queue-${product.queue.toLowerCase()}`}>
                      {queueLabel(product.queue)}
                    </span>
                  </div>

                  <div className="product-body">
                    <div className="product-topline">
                      <span className="product-asin">{product.asin}</span>
                    </div>
                    <h3 className="product-title">{product.title || 'Titolo non disponibile'}</h3>
                    <div className="product-meta">
                      <span className="product-price">
                        {formatMoney(product.item_value, product.currency)}
                      </span>
                      <span>{relTime(product.event_time, now)}</span>
                    </div>
                  </div>
                </a>
              );
            })
          )}
        </div>

        {hasMore && (
          <div className="load-more-row">
            <button
              type="button"
              className="load-more-btn"
              disabled={isLoadingMore || isRefreshingProducts}
              onClick={() => void loadMore()}
            >
              {isLoadingMore ? 'Caricamento…' : 'Carica altri'}
            </button>
          </div>
        )}
      </section>

      <footer className="dashboard-footer">
        <span>Monitoraggio continuo in tempo reale. Dati a scopo informativo.</span>
        <span>Non affiliato con Amazon.</span>
      </footer>

      {/* Live ticker popup */}
      <div className={`live-ticker ${tickerItem ? 'show' : ''}`} aria-live="polite" aria-atomic="true">
        <div className="live-ticker-thumb">
          {tickerItem?.image_url ? (
            <img src={tickerItem.image_url} alt="" />
          ) : (
            <span className="live-ticker-thumb-placeholder">{tickerItem?.asin?.slice(0, 6) ?? ''}</span>
          )}
        </div>
        <div className="live-ticker-body">
          <div className="live-ticker-queue">+ {tickerItem ? queueLabel(tickerItem.queue) : ''}</div>
          <div className="live-ticker-title">{tickerItem?.title ?? 'Nuovo prodotto'}</div>
          <div className="live-ticker-price">
            {tickerItem ? formatMoney(tickerItem.item_value, tickerItem.currency) : ''}
          </div>
        </div>
      </div>
    </main>
  );
}
