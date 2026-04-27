import { loadChartData } from '@/lib/chart-data';
import { loadHealth, loadMoreProducts, loadSnapshot } from '@/lib/dashboard-data';
import { pingDatabase } from '@/lib/db';
import type {
  ChartResponse,
  HealthResponse,
  ProductSortMode,
  ProductsResponse,
  QueueCode,
  SnapshotResponse,
} from '@/lib/dashboard-types';
import { QUEUE_ORDER } from '@/lib/queues';

type LoadProductsQuery = {
  offset: number;
  limit: number;
  search?: string;
  sort?: ProductSortMode;
  queue?: QueueCode;
  since?: string;
  until?: string;
};

const DAY_FORMATTER = new Intl.DateTimeFormat('it-IT', {
  weekday: 'short',
  day: 'numeric',
  timeZone: 'Europe/Rome',
});

const HOUR_FORMATTER = new Intl.DateTimeFormat('it-IT', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Europe/Rome',
});

function getRemoteDashboardUrl(): string | null {
  const raw = process.env.REMOTE_DASHBOARD_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

function buildRemoteDashboardUrl(pathAndSearch: string): string {
  const baseUrl = getRemoteDashboardUrl();
  if (!baseUrl) {
    throw new Error('REMOTE_DASHBOARD_URL is not set');
  }

  const normalizedPath = pathAndSearch.startsWith('/')
    ? pathAndSearch
    : `/${pathAndSearch}`;

  return `${baseUrl}${normalizedPath}`;
}

function hasRemoteDashboard(): boolean {
  return getRemoteDashboardUrl() !== null;
}

async function fetchRemoteJson<T>(pathAndSearch: string): Promise<T> {
  const response = await fetch(buildRemoteDashboardUrl(pathAndSearch), {
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(
      `Remote dashboard request failed for ${pathAndSearch}: ${response.status} ${response.statusText}`
    );
  }

  return (await response.json()) as T;
}

function buildProductsParams(
  query: LoadProductsQuery
): URLSearchParams {
  const params = new URLSearchParams({
    offset: String(query.offset),
    limit: String(query.limit),
    sort: query.sort ?? 'newest',
  });

  const search = query.search?.trim();
  if (search) {
    params.set('search', search);
  }
  if (query.queue) {
    params.set('queue', query.queue);
  }
  if (query.since) {
    params.set('since', query.since);
  }
  if (query.until) {
    params.set('until', query.until);
  }

  return params;
}

async function fetchRemoteProductsPage(
  query: LoadProductsQuery
): Promise<ProductsResponse> {
  const params = buildProductsParams(query);
  return fetchRemoteJson<ProductsResponse>(`/api/products?${params.toString()}`);
}

function createEmptyDailyCounts(): SnapshotResponse['daily_counts'] {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 6);

  return Array.from({ length: 7 }, (_, index) => {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    return {
      day: day.toISOString(),
      label: DAY_FORMATTER.format(day),
      added: 0,
    };
  });
}

function createEmptyQueueMix(): SnapshotResponse['queue_mix_24h'] {
  return QUEUE_ORDER.map((queue) => ({ queue, count: 0 }));
}

function createEmptyHourlyActivity(): SnapshotResponse['hourly_activity_24h'] {
  const end = new Date();
  end.setUTCMinutes(0, 0, 0);
  end.setUTCHours(end.getUTCHours() - 23);

  return Array.from({ length: 24 }, (_, index) => {
    const bucket = new Date(end);
    bucket.setUTCHours(end.getUTCHours() + index);
    return {
      bucket: bucket.toISOString(),
      label: HOUR_FORMATTER.format(bucket),
      added: 0,
    };
  });
}

function createFallbackSnapshot(): SnapshotResponse {
  return {
    added_7d: 0,
    added_24h: 0,
    added_1h: 0,
    tracked_value_24h: 0,
    avg_item_value_24h: null,
    data_quality: 'partial',
    daily_counts: createEmptyDailyCounts(),
    hourly_activity_24h: createEmptyHourlyActivity(),
    recent_products: [],
    queue_mix_24h: createEmptyQueueMix(),
    queue_totals: createEmptyQueueMix(),
    total_products: 0,
    as_of: new Date().toISOString(),
  };
}

function createFallbackHealth(): HealthResponse {
  return {
    collector_status: 'offline',
    last_event_time: null,
    last_collector_event: null,
    gap_open: true,
    data_quality_1h: 'partial',
    as_of: new Date().toISOString(),
  };
}

export async function loadSnapshotForApp(): Promise<SnapshotResponse> {
  if (!hasRemoteDashboard()) {
    return loadSnapshot();
  }

  try {
    return await fetchRemoteJson<SnapshotResponse>('/api/live/snapshot');
  } catch (err) {
    console.error('remote snapshot load failed', err);
    return createFallbackSnapshot();
  }
}

export async function loadHealthForApp(): Promise<HealthResponse> {
  if (!hasRemoteDashboard()) {
    return loadHealth();
  }

  try {
    return await fetchRemoteJson<HealthResponse>('/api/health');
  } catch (err) {
    console.error('remote health load failed', err);
    return createFallbackHealth();
  }
}

export async function loadChartForApp(): Promise<ChartResponse> {
  if (!hasRemoteDashboard()) {
    return { points: await loadChartData() };
  }

  try {
    return await fetchRemoteJson<ChartResponse>('/api/chart');
  } catch (err) {
    console.error('remote chart load failed', err);
    return { points: [] };
  }
}

export async function loadProductsForApp(
  query: LoadProductsQuery
): Promise<ProductsResponse> {
  if (!hasRemoteDashboard()) {
    const { products, total } = await loadMoreProducts({
      offset: query.offset,
      limit: query.limit,
      search: query.search,
      sort: query.sort,
      queue: query.queue,
      since: query.since,
      until: query.until,
    });
    return {
      products,
      offset: query.offset,
      limit: query.limit,
      total,
    };
  }

  return fetchRemoteProductsPage(query);
}

export async function pingDashboardSource(): Promise<void> {
  if (!hasRemoteDashboard()) {
    await pingDatabase();
    return;
  }

  const response = await fetch(buildRemoteDashboardUrl('/api/health'), {
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(
      `Remote dashboard health check failed: ${response.status} ${response.statusText}`
    );
  }
}

export async function proxyLiveStreamForApp(
  request: Request
): Promise<Response | null> {
  if (!hasRemoteDashboard()) {
    return null;
  }

  const controller = new AbortController();
  request.signal.addEventListener(
    'abort',
    () => {
      controller.abort();
    },
    { once: true }
  );

  const upstream = await fetch(buildRemoteDashboardUrl('/api/live'), {
    cache: 'no-store',
    headers: {
      Accept: 'text/event-stream',
    },
    signal: controller.signal,
  });

  if (!upstream.ok || !upstream.body) {
    throw new Error(
      `Remote live stream failed: ${upstream.status} ${upstream.statusText}`
    );
  }

  const headers = new Headers();
  headers.set(
    'Content-Type',
    upstream.headers.get('content-type') ?? 'text/event-stream'
  );
  headers.set(
    'Cache-Control',
    upstream.headers.get('cache-control') ?? 'no-cache, no-transform'
  );
  headers.set('Connection', 'keep-alive');
  headers.set('X-Accel-Buffering', 'no');

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}
