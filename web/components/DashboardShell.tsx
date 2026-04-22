'use client';

import {
  startTransition,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from 'react';
import SevenDayChart from '@/components/SevenDayChart';
import { QUEUE_ORDER, queueLabel } from '@/lib/queues';
import type {
  ChartPoint,
  ChartResponse,
  DashboardProduct,
  HealthResponse,
  QueueCode,
  SnapshotResponse,
} from '@/lib/dashboard-types';
import type { LiveCollectorStatusEvent, LiveItemValueUpdatedEvent } from '@/lib/live-bus';

type Props = {
  initialSnapshot: SnapshotResponse;
  initialHealth: HealthResponse;
};

type SortMode = 'newest' | 'value_desc' | 'value_asc';
type QueueFilter = 'ALL' | QueueCode;
type StatusTone = 'ok' | 'warn' | 'bad';
type MetricIconKind = 'box' | 'spark' | 'bolt' | 'coin' | 'shield' | 'clock';
type AudioContextCtor = typeof AudioContext;
type WindowWithWebkitAudioContext = Window &
  typeof globalThis & {
    webkitAudioContext?: AudioContextCtor;
  };

const QUEUE_FILTERS: QueueFilter[] = ['ALL', ...QUEUE_ORDER];
const MONITORING_TOOLTIP_COPY =
  'Per la natura del monitoraggio alcuni oggetti possono non essere rilevati correttamente dal sistema.';
const BEEP_COOLDOWN_MS = 250;

function getAudioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;

  return (
    window.AudioContext ??
    (window as WindowWithWebkitAudioContext).webkitAudioContext ??
    null
  );
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

function compactNumber(value: number): string {
  return value.toLocaleString('it-IT');
}

function collectorEventLabel(eventType: string | null | undefined): string {
  switch (eventType) {
    case 'connected':
      return 'Connesso';
    case 'disconnected':
      return 'Disconnesso';
    case 'timeout':
      return 'Timeout';
    case 'gap_opened':
      return 'Gap aperto';
    case 'gap_closed':
      return 'Gap chiuso';
    default:
      return 'Nessun evento';
  }
}

function qualityLabel(quality: 'ok' | 'partial'): string {
  return quality === 'ok' ? 'Stimata' : 'Ridotta';
}

function dashboardTone(health: HealthResponse): StatusTone {
  if (health.collector_status === 'offline') return 'bad';
  return health.data_quality_1h === 'ok' ? 'ok' : 'warn';
}

function dashboardCopy(health: HealthResponse): string {
  if (health.collector_status === 'offline') return 'Collector offline';
  return health.data_quality_1h === 'ok' ? 'Realtime attivo' : 'Copertura live parziale';
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
        {kind === 'shield' && (
          <>
            <path {...common} d="M12 3 5.5 6v5.2c0 4.2 2.7 7.9 6.5 9.3 3.8-1.4 6.5-5.1 6.5-9.3V6z" />
            <path {...common} d="m9.3 12.2 1.7 1.7 3.7-4.1" />
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

function InfoTooltip({ copy = MONITORING_TOOLTIP_COPY }: { copy?: string }) {
  return (
    <span className="info-tooltip" tabIndex={0} aria-label={copy}>
      <span className="info-tooltip-trigger" aria-hidden="true">
        I
      </span>
      <span className="info-tooltip-bubble" role="tooltip">
        {copy}
      </span>
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

function isItemAddedEvent(payload: unknown): payload is { t: 'item_added'; ts: string } {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { t?: unknown }).t === 'item_added' &&
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

function sortProducts(products: DashboardProduct[], mode: SortMode): DashboardProduct[] {
  const sorted = [...products];
  if (mode === 'value_desc') {
    sorted.sort((left, right) => (right.item_value ?? -1) - (left.item_value ?? -1));
    return sorted;
  }
  if (mode === 'value_asc') {
    sorted.sort((left, right) => {
      const leftValue = left.item_value ?? Number.MAX_SAFE_INTEGER;
      const rightValue = right.item_value ?? Number.MAX_SAFE_INTEGER;
      return leftValue - rightValue;
    });
    return sorted;
  }
  sorted.sort(
    (left, right) => new Date(right.event_time).getTime() - new Date(left.event_time).getTime()
  );
  return sorted;
}

export default function DashboardShell({ initialSnapshot, initialHealth }: Props) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [health, setHealth] = useState(initialHealth);
  const [search, setSearch] = useState('');
  const [queueFilter, setQueueFilter] = useState<QueueFilter>('ALL');
  const [sortMode, setSortMode] = useState<SortMode>('newest');
  const [extraProducts, setExtraProducts] = useState<DashboardProduct[]>([]);
  const [nextOffset, setNextOffset] = useState(initialSnapshot.recent_products.length);
  const [hasMore, setHasMore] = useState(initialSnapshot.recent_products.length === 20);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [isSyncing, setIsSyncing] = useState(false);
  const [chartPoints, setChartPoints] = useState<ChartPoint[]>([]);
  const deferredSearch = useDeferredValue(search.trim().toLowerCase());

  const eventSourceRef = useRef<EventSource | null>(null);
  const refreshTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const lastBeepAtRef = useRef(0);

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

  const playNotificationBeep = async () => {
    const nowMs = Date.now();
    if (nowMs - lastBeepAtRef.current < BEEP_COOLDOWN_MS) return;

    const context = await primeAudioContext();
    if (!context || context.state !== 'running') return;
    lastBeepAtRef.current = nowMs;

    const startAt = context.currentTime;
    const oscillator = context.createOscillator();
    const gain = context.createGain();

    oscillator.type = 'triangle';
    oscillator.frequency.setValueAtTime(880, startAt);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(0.028, startAt + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.14);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.onended = () => {
      oscillator.disconnect();
      gain.disconnect();
    };
    oscillator.start(startAt);
    oscillator.stop(startAt + 0.15);
  };

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    return () => {
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
            });
            void playNotificationBeep();
            scheduleSnapshotRefresh();
            return;
          }
          if (isItemValueUpdatedEvent(payload)) {
            startTransition(() => {
              setSnapshot((current) => applyItemValueUpdate(current, payload));
            });
            scheduleSnapshotRefresh();
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
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, []);

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
    if (isLoadingMore) return;
    setIsLoadingMore(true);
    try {
      const response = await fetch(`/api/products?offset=${nextOffset}&limit=20`, { cache: 'no-store' });
      if (!response.ok) return;
      const data = (await response.json()) as { products: DashboardProduct[]; limit: number };
      setExtraProducts((prev) => [...prev, ...data.products]);
      setNextOffset((prev) => prev + data.products.length);
      setHasMore(data.products.length === data.limit);
    } catch {
      // ignore
    } finally {
      setIsLoadingMore(false);
    }
  };

  const tone = dashboardTone(health);
  const allProducts = [...snapshot.recent_products, ...extraProducts];
  const allFilteredProducts = sortProducts(
    allProducts.filter((product) => {
      const queueMatches = queueFilter === 'ALL' || product.queue === queueFilter;
      if (!queueMatches) return false;
      if (!deferredSearch) return true;
      const haystack = `${product.asin} ${product.title || ''}`.toLowerCase();
      return haystack.includes(deferredSearch);
    }),
    sortMode
  );

  const latestEventTime = snapshot.recent_products[0]?.event_time ?? health.last_event_time;
  const queueCounts = snapshot.recent_products.reduce<Map<QueueCode, number>>((counts, product) => {
    counts.set(product.queue, (counts.get(product.queue) ?? 0) + 1);
    return counts;
  }, new Map(QUEUE_ORDER.map((queue) => [queue, 0] as const)));
  const strongestBucket = snapshot.hourly_activity_24h.reduce(
    (best, bucket) => (bucket.added > best.added ? bucket : best),
    snapshot.hourly_activity_24h[0] ?? { bucket: '', label: '—', added: 0 }
  );
  const maxHourlyCount = Math.max(...snapshot.hourly_activity_24h.map((bucket) => bucket.added), 0);
  const liveQuality = qualityLabel(health.data_quality_1h);
  const historicalQuality = qualityLabel(snapshot.data_quality);

  return (
    <main className="dashboard-shell">
      <section className="dashboard-head">
        <div className="dashboard-head-copy">
          <p className="eyebrow">Dashboard monitoraggio live</p>
          <h1 className="dashboard-title">Dashboard monitoraggio Amazon Vine</h1>
          <p className="dashboard-subtitle">
            Attività in tempo reale, qualità dati e feed prodotti in un layout operativo più compatto.
          </p>
        </div>
      </section>

      <section className="metric-strip">
        <article className="metric-card metric-card-accent">
          <div className="metric-topline">
            <MetricIcon kind="box" />
            <span className="metric-label">Prodotti trovati</span>
          </div>
          <strong className="metric-value">{compactNumber(snapshot.added_7d)}</strong>
          <p className="metric-sub">ultimi 7 giorni</p>
        </article>
        <article className="metric-card">
          <div className="metric-topline">
            <MetricIcon kind="spark" />
            <span className="metric-label">Nuovi in 24h</span>
          </div>
          <strong className="metric-value">{compactNumber(snapshot.added_24h)}</strong>
          <p className="metric-sub">aggiunte da ieri</p>
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
            media {formatMoney(snapshot.avg_item_value_24h, 'EUR')} / articolo
          </p>
        </article>
        <article className="metric-card">
          <div className="metric-topline">
            <MetricIcon kind="shield" />
            <div className="metric-heading">
              <span className="metric-label">Qualità rilevazione</span>
              <InfoTooltip />
            </div>
          </div>
          <strong className="metric-value">{liveQuality}</strong>
          <p className="metric-sub">monitoraggio best effort</p>
        </article>
        <article className="metric-card">
          <div className="metric-topline">
            <MetricIcon kind="clock" />
            <span className="metric-label">Ultimo aggiornamento</span>
          </div>
          <strong className="metric-value">{relTime(latestEventTime, now)}</strong>
          <p className="metric-sub">ultimo item rilevato</p>
        </article>
      </section>

      <section className="chart-section">
        <article className="panel chart-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">ATTIVITÀ LIVE</p>
              <h2 className="panel-title">Timeline prodotti rilevati</h2>
            </div>
            <span className={`status-pill ${snapshot.data_quality === 'ok' ? 'ok' : 'warn'}`}>
              <span className="status-pill-dot" />
              {historicalQuality} 7g
              <InfoTooltip />
            </span>
          </div>
          <SevenDayChart points={chartPoints} />
        </article>
      </section>

      <section className="detail-grid">
        <article className="panel rail-panel heatmap-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">ULTIME 24 ORE</p>
              <h2 className="panel-title">Heatmap oraria</h2>
            </div>
          </div>

          <div className="heatmap-summary">
            <span className="heatmap-summary-label">Fascia più attiva</span>
            <strong>
              {strongestBucket.added > 0 ? strongestBucket.label : 'Nessun drop'}
            </strong>
            <span>
              {strongestBucket.added > 0
                ? `${compactNumber(strongestBucket.added)} prodotti`
                : 'nessun prodotto rilevato'}
            </span>
          </div>

          <div className="heatmap-grid">
            {snapshot.hourly_activity_24h.map((bucket) => {
              const intensity = maxHourlyCount > 0 ? bucket.added / maxHourlyCount : 0;
              const background =
                bucket.added === 0
                  ? 'var(--surface-2)'
                  : `rgba(163, 230, 53, ${0.08 + intensity * 0.22})`;
              const borderColor =
                bucket.added === 0
                  ? 'var(--border)'
                  : `rgba(163, 230, 53, ${0.2 + intensity * 0.3})`;

              return (
                <div
                  key={bucket.bucket}
                  className={`heatmap-cell ${bucket.added > 0 ? 'active' : ''}`}
                  style={{ background, borderColor }}
                >
                  <span className="heatmap-hour">{bucket.label}</span>
                  <strong className="heatmap-count">{compactNumber(bucket.added)}</strong>
                </div>
              );
            })}
          </div>
        </article>

        <article className="panel rail-panel status-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">STATO SISTEMA</p>
              <h2 className="panel-title">Segnali operativi</h2>
            </div>
            <span className={`status-pill ${tone}`}>
              <span className="status-pill-dot" />
              {dashboardCopy(health)}
            </span>
          </div>

          <div className="ops-list">
            <div className="ops-row">
              <span className="ops-label">Collector</span>
              <strong>{health.collector_status === 'online' ? 'Online' : 'Offline'}</strong>
              <span>{health.gap_open ? 'gap aperto' : 'socket attivo'}</span>
            </div>
            <div className="ops-row">
              <div className="ops-label-wrap">
                <span className="ops-label">Qualità live</span>
                <InfoTooltip />
              </div>
              <strong>{liveQuality}</strong>
              <span>ultima ora</span>
            </div>
            <div className="ops-row">
              <span className="ops-label">Ultimo evento collector</span>
              <strong>{collectorEventLabel(health.last_collector_event?.event_type)}</strong>
              <span>{relTime(health.last_collector_event?.time ?? null, now)}</span>
            </div>
          </div>
        </article>
      </section>

      <section className="panel products-panel">
        <div className="products-header">
          <div>
            <p className="eyebrow">ULTIMI PRODOTTI</p>
            <h2 className="panel-title">Feed in tempo reale</h2>
            <p className="products-sub">
              Coda normalizzata, card più compatte e aggiornamento automatico dal collector live.
            </p>
          </div>

          <div className="products-controls">
            <input
              className="search-input"
              type="search"
              placeholder="Cerca titolo o ASIN"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <select
              className="sort-select"
              value={sortMode}
              onChange={(event) => setSortMode(event.target.value as SortMode)}
            >
              <option value="newest">Più recenti</option>
              <option value="value_desc">Valore alto</option>
              <option value="value_asc">Valore basso</option>
            </select>
          </div>
        </div>

        <div className="queue-filter-row">
          {QUEUE_FILTERS.map((queue) => {
            const count =
              queue === 'ALL'
                ? snapshot.recent_products.length
                : queueCounts.get(queue) ?? 0;

            return (
              <button
                key={queue}
                type="button"
                className={`queue-pill ${queueFilter === queue ? 'active' : ''}`}
                data-queue={queue}
                onClick={() => setQueueFilter(queue)}
              >
                {queueLabel(queue)}
                <span>{count}</span>
              </button>
            );
          })}
        </div>

        <div className="products-grid">
          {allFilteredProducts.length === 0 ? (
            <div className="empty-state">
              Nessun prodotto corrisponde ai filtri correnti.
            </div>
          ) : (
            allFilteredProducts.map((product) => {
              const isFresh = now - new Date(product.event_time).getTime() < 90_000;

              return (
                <a
                  key={`${product.asin}-${product.event_time}`}
                  className={`product-card ${isFresh ? 'fresh' : ''}`}
                  href={product.detail_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  <div className="product-thumb">
                    {product.image_url ? (
                      <img src={product.image_url} alt={product.title || product.asin} />
                    ) : (
                      <span>{product.asin.slice(0, 6)}</span>
                    )}
                  </div>

                  <div className="product-body">
                    <div className="product-topline">
                      <span className={`queue-badge queue-${product.queue.toLowerCase()}`}>
                        {queueLabel(product.queue)}
                      </span>
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
              disabled={isLoadingMore}
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
    </main>
  );
}
