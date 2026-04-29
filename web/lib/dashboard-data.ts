import { getPool } from '@/lib/db';
import { QUEUE_ORDER, normalizeQueue } from '@/lib/queues';
import type {
  DashboardProduct,
  HealthResponse,
  HourlyActivityPoint,
  ProductSortMode,
  QueueCode,
  SnapshotResponse,
} from '@/lib/dashboard-types';

type CountRow = {
  added_7d: string;
  added_24h: string;
  added_1h: string;
  tracked_value_24h: string;
  avg_item_value_24h: string | null;
  missing_item_value_24h: string;
};

type DayRow = {
  day: Date;
  added: string;
};

type HourRow = {
  bucket: Date;
  added: string;
};

type ProductRow = {
  event_time: Date;
  asin: string;
  queue: string | null;
  title: string | null;
  item_value: string | null;
  currency: string | null;
  raw_payload: Record<string, unknown> | null;
};

type QueueRow = {
  queue: string | null;
  count: string;
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

const COLLECTOR_ACTIVITY_FALLBACK_WINDOW_MS = 2 * 60 * 1000;
const NORMALIZED_QUEUE_SQL = `
  CASE
    WHEN regexp_replace(lower(trim(coalesce(queue, ''))), '[[:space:]-]+', '_', 'g')
      IN ('ai', 'encore') THEN 'AI'
    WHEN regexp_replace(lower(trim(coalesce(queue, ''))), '[[:space:]-]+', '_', 'g')
      IN ('afa', 'last_chance') THEN 'AFA'
    WHEN regexp_replace(lower(trim(coalesce(queue, ''))), '[[:space:]-]+', '_', 'g')
      IN ('rfy', 'potluck') THEN 'RFY'
    ELSE 'OTHER'
  END
`;

type ProductQuery = {
  offset: number;
  limit: number;
  search?: string;
  sort?: ProductSortMode;
  queue?: QueueCode;
  since?: string; // ISO — inclusive lower bound on event_time
  until?: string; // ISO — inclusive upper bound on event_time
};

type ProductQueryFilters = {
  conditions: string[];
  params: Array<number | string>;
};

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

function toNumber(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toNullableNumber(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildDetailUrl(asin: string): string {
  return `https://www.amazon.it/dp/${encodeURIComponent(asin)}`;
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function productOrderClause(sort: ProductSortMode): string {
  switch (sort) {
    case 'value_desc':
      return 'ORDER BY vine_item_events.item_value DESC NULLS LAST, event_time DESC, id DESC';
    case 'value_asc':
      return 'ORDER BY vine_item_events.item_value ASC NULLS LAST, event_time DESC, id DESC';
    case 'newest':
    default:
      return 'ORDER BY event_time DESC, id DESC';
  }
}

function isLikelyImageUrl(value: string): boolean {
  const lower = value.toLowerCase();
  if (!/^https?:\/\//.test(lower)) return false;
  return (
    /\.(avif|gif|jpe?g|png|svg|webp)(\?|$)/.test(lower) ||
    lower.includes('images') ||
    lower.includes('media-amazon') ||
    lower.includes('m.media')
  );
}

function extractImageUrl(value: unknown, depth = 0): string | null {
  if (depth > 4 || value == null) return null;
  if (typeof value === 'string') {
    return isLikelyImageUrl(value) ? value : null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractImageUrl(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;

  const record = value as Record<string, unknown>;
  for (const [key, nested] of Object.entries(record)) {
    if (!/(img|image|thumb|media|photo|picture)/i.test(key)) continue;
    const found = extractImageUrl(nested, depth + 1);
    if (found) return found;
  }
  for (const nested of Object.values(record)) {
    if (typeof nested !== 'object' || nested == null) continue;
    const found = extractImageUrl(nested, depth + 1);
    if (found) return found;
  }
  return null;
}

function buildProductQueryFilters(query: ProductQuery): ProductQueryFilters {
  const params: Array<number | string> = [];
  const conditions = [`event_type = 'item_added'`];
  const search = query.search?.trim();

  if (search) {
    params.push(`%${escapeLikePattern(search)}%`);
    const searchParam = `$${params.length}`;
    conditions.push(
      `(asin ILIKE ${searchParam} ESCAPE '\\' OR coalesce(title, '') ILIKE ${searchParam} ESCAPE '\\')`
    );
  }

  if (query.queue) {
    params.push(query.queue);
    conditions.push(`${NORMALIZED_QUEUE_SQL} = $${params.length}`);
  }

  if (query.since) {
    params.push(query.since);
    conditions.push(`event_time >= $${params.length}`);
  }

  if (query.until) {
    params.push(query.until);
    conditions.push(`event_time <= $${params.length}`);
  }

  return { conditions, params };
}

function mapQueueMix(rows: QueueRow[]): SnapshotResponse['queue_mix_24h'] {
  const counts = new Map<SnapshotResponse['queue_mix_24h'][number]['queue'], number>();
  for (const row of rows) {
    const queue = normalizeQueue(row.queue);
    counts.set(queue, (counts.get(queue) ?? 0) + toNumber(row.count));
  }
  return QUEUE_ORDER.map((queue) => ({ queue, count: counts.get(queue) ?? 0 }));
}

function mapHourlyActivity(rows: HourRow[]): HourlyActivityPoint[] {
  return rows.map((row) => ({
    bucket: row.bucket.toISOString(),
    label: HOUR_FORMATTER.format(row.bucket),
    added: toNumber(row.added),
  }));
}

function mapProduct(row: ProductRow): DashboardProduct {
  return {
    asin: row.asin,
    queue: normalizeQueue(row.queue),
    title: row.title,
    item_value: toNullableNumber(row.item_value),
    currency: row.currency,
    event_time: row.event_time.toISOString(),
    image_url: extractImageUrl(row.raw_payload),
    detail_url: buildDetailUrl(row.asin),
  };
}

function emptySnapshot(): SnapshotResponse {
  return {
    added_7d: 0,
    added_24h: 0,
    added_1h: 0,
    tracked_value_24h: 0,
    avg_item_value_24h: null,
    missing_item_value_24h: 0,
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

export async function loadSnapshot(): Promise<SnapshotResponse> {
  try {
    const pool = getPool();
    const [counts, dq, daily, hourly, recent, queues, queueTotals] = await Promise.all([
      pool.query<CountRow>(
        `
        SELECT
          count(*) FILTER (WHERE event_time > now() - INTERVAL '7 days')::text  AS added_7d,
          count(*) FILTER (WHERE event_time > now() - INTERVAL '24 hours')::text AS added_24h,
          count(*) FILTER (WHERE event_time > now() - INTERVAL '1 hour')::text   AS added_1h,
          coalesce(
            sum(item_value) FILTER (
              WHERE event_time > now() - INTERVAL '24 hours'
                AND item_value IS NOT NULL
            ),
            0
          )::text AS tracked_value_24h,
          avg(item_value) FILTER (
            WHERE event_time > now() - INTERVAL '24 hours'
              AND item_value IS NOT NULL
          )::text AS avg_item_value_24h,
          count(*) FILTER (
            WHERE event_time > now() - INTERVAL '24 hours'
              AND item_value IS NULL
          )::text AS missing_item_value_24h
        FROM vine_item_events
        WHERE event_type = 'item_added'
        `
      ),
      pool.query<{ data_quality: 'ok' | 'partial' }>(
        `SELECT data_quality(now() - INTERVAL '7 days', now()) AS data_quality`
      ),
      pool.query<DayRow>(
        `
        WITH days AS (
          SELECT generate_series(
            date_trunc('day', now()) - INTERVAL '6 days',
            date_trunc('day', now()),
            INTERVAL '1 day'
          ) AS day
        )
        SELECT
          days.day,
          count(events.event_time)::text AS added
        FROM days
        LEFT JOIN vine_item_events AS events
          ON events.event_type = 'item_added'
         AND events.event_time >= days.day
         AND events.event_time < days.day + INTERVAL '1 day'
        GROUP BY days.day
        ORDER BY days.day
        `
      ),
      pool.query<HourRow>(
        `
        WITH hours AS (
          SELECT generate_series(
            date_trunc('hour', now()) - INTERVAL '23 hours',
            date_trunc('hour', now()),
            INTERVAL '1 hour'
          ) AS bucket
        )
        SELECT
          hours.bucket,
          count(events.event_time)::text AS added
        FROM hours
        LEFT JOIN vine_item_events AS events
          ON events.event_type = 'item_added'
         AND events.event_time >= hours.bucket
         AND events.event_time < hours.bucket + INTERVAL '1 hour'
        GROUP BY hours.bucket
        ORDER BY hours.bucket
        `
      ),
      pool.query<ProductRow>(
        `
        SELECT
          event_time,
          asin,
          queue,
          title,
          item_value::text,
          currency,
          raw_payload
        FROM vine_item_events
        WHERE event_type = 'item_added'
        ORDER BY event_time DESC
        LIMIT 20
        `
      ),
      pool.query<QueueRow>(
        `
        SELECT queue, count(*)::text AS count
        FROM vine_item_events
        WHERE event_type = 'item_added'
          AND event_time > now() - INTERVAL '24 hours'
        GROUP BY queue
        `
      ),
      pool.query<QueueRow>(
        `
        SELECT queue, count(*)::text AS count
        FROM vine_item_events
        WHERE event_type = 'item_added'
        GROUP BY queue
        `
      ),
    ]);

    return {
      added_7d: toNumber(counts.rows[0]?.added_7d),
      added_24h: toNumber(counts.rows[0]?.added_24h),
      added_1h: toNumber(counts.rows[0]?.added_1h),
      tracked_value_24h: toNumber(counts.rows[0]?.tracked_value_24h),
      avg_item_value_24h: toNullableNumber(counts.rows[0]?.avg_item_value_24h),
      missing_item_value_24h: toNumber(counts.rows[0]?.missing_item_value_24h),
      data_quality: dq.rows[0]?.data_quality ?? 'partial',
      daily_counts: daily.rows.length
        ? daily.rows.map((row) => ({
            day: row.day.toISOString(),
            label: DAY_FORMATTER.format(row.day),
            added: toNumber(row.added),
          }))
        : createEmptyDailyCounts(),
      hourly_activity_24h: hourly.rows.length
        ? mapHourlyActivity(hourly.rows)
        : createEmptyHourlyActivity(),
      recent_products: recent.rows.map(mapProduct),
      queue_mix_24h: mapQueueMix(queues.rows),
      queue_totals: mapQueueMix(queueTotals.rows),
      total_products: queueTotals.rows.reduce((sum, row) => sum + toNumber(row.count), 0),
      as_of: new Date().toISOString(),
    };
  } catch (err) {
    console.error('loadSnapshot failed', err);
    return emptySnapshot();
  }
}

export async function loadMoreProducts(
  query: ProductQuery
): Promise<{ products: DashboardProduct[]; total: number }> {
  const pool = getPool();
  const sort = query.sort ?? 'newest';
  const { conditions, params } = buildProductQueryFilters(query);

  const countResult = await pool.query<{ total: string }>(
    `
    SELECT count(*)::text AS total
    FROM vine_item_events
    WHERE ${conditions.join('\n      AND ')}
    `,
    params
  );

  const pageParams = [...params, query.limit, query.offset];
  const limitParam = `$${pageParams.length - 1}`;
  const offsetParam = `$${pageParams.length}`;
  const productsResult = await pool.query<ProductRow>(
    `
    SELECT
      event_time,
      asin,
      queue,
      title,
      item_value::text,
      currency,
      raw_payload
    FROM vine_item_events
    WHERE ${conditions.join('\n      AND ')}
    ${productOrderClause(sort)}
    LIMIT ${limitParam} OFFSET ${offsetParam}
    `,
    pageParams
  );

  return {
    products: productsResult.rows.map(mapProduct),
    total: toNumber(countResult.rows[0]?.total),
  };
}

export async function loadHealth(): Promise<HealthResponse> {
  try {
    const pool = getPool();
    const [lastItem, lastCollector, dq] = await Promise.all([
      pool.query<{ event_time: Date | null; ingest_time: Date | null }>(
        `
        SELECT
          max(event_time) AS event_time,
          max(ingest_time) AS ingest_time
        FROM vine_item_events
        `
      ),
      pool.query<{ event_type: string; time: Date }>(
        `
        SELECT event_type, time
        FROM collector_events
        WHERE event_type IN (
          'connected', 'disconnected', 'timeout',
          'gap_opened', 'gap_closed'
        )
        ORDER BY time DESC
        LIMIT 1
        `
      ),
      pool.query<{ data_quality: 'ok' | 'partial' }>(
        `SELECT data_quality(now() - INTERVAL '1 hour', now()) AS data_quality`
      ),
    ]);

    const now = Date.now();
    const lastItemEventTime = lastItem.rows[0]?.event_time ?? null;
    const lastItemIngestTime = lastItem.rows[0]?.ingest_time ?? null;
    const lastCollectorEvent = lastCollector.rows[0] ?? null;
    const lastType = lastCollectorEvent?.event_type ?? null;
    const lastItemIngestMs = lastItemIngestTime?.getTime() ?? null;
    const hasRecentItemIngest =
      lastItemIngestMs !== null &&
      now - lastItemIngestMs <= COLLECTOR_ACTIVITY_FALLBACK_WINDOW_MS;
    const itemIngestIsNewerThanStatus =
      hasRecentItemIngest &&
      (lastCollectorEvent === null || lastItemIngestMs > lastCollectorEvent.time.getTime());
    const collectorStatus =
      itemIngestIsNewerThanStatus || lastType === 'connected' || lastType === 'gap_closed'
        ? 'online'
        : 'offline';
    const gapOpen =
      collectorStatus === 'offline';

    return {
      collector_status: collectorStatus,
      last_event_time: lastItemEventTime?.toISOString() ?? null,
      last_collector_event: lastCollectorEvent
        ? {
            event_type: lastCollectorEvent.event_type,
            time: lastCollectorEvent.time.toISOString(),
          }
        : null,
      gap_open: gapOpen,
      data_quality_1h: dq.rows[0]?.data_quality ?? 'partial',
      as_of: new Date().toISOString(),
    };
  } catch (err) {
    console.error('loadHealth failed', err);
    return {
      collector_status: 'offline',
      last_event_time: null,
      last_collector_event: null,
      gap_open: true,
      data_quality_1h: 'partial',
      as_of: new Date().toISOString(),
    };
  }
}
