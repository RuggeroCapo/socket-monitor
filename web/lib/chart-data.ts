import { getPool } from '@/lib/db';
import type { ChartPoint } from '@/lib/dashboard-types';

type BucketRow = {
  bucket: Date;
  added: string;
  ai: string;
  afa: string;
  rfy: string;
  other: string;
};

// 7 days at 5-minute resolution → ~2 016 points, fine enough for minute-level zoom
const TOTAL_INTERVAL = '7 days';
const BUCKET_INTERVAL = '5 minutes';

export async function loadChartData(): Promise<ChartPoint[]> {
  try {
    const result = await getPool().query<BucketRow>(
      `
      WITH buckets AS (
        SELECT generate_series(
          now() - $1::interval,
          now(),
          $2::interval
        ) AS bucket
      ),
      events AS (
        SELECT
          event_time,
          CASE replace(replace(trim(lower(coalesce(queue, ''))), '-', '_'), ' ', '_')
            WHEN 'ai' THEN 'AI'
            WHEN 'encore' THEN 'AI'
            WHEN 'afa' THEN 'AFA'
            WHEN 'last_chance' THEN 'AFA'
            WHEN 'rfy' THEN 'RFY'
            WHEN 'potluck' THEN 'RFY'
            ELSE 'OTHER'
          END AS queue_code
        FROM vine_item_events
        WHERE event_type = 'item_added'
          AND event_time >= now() - $1::interval
      )
      SELECT
        buckets.bucket,
        count(events.event_time)::text AS added,
        count(events.event_time) FILTER (WHERE events.queue_code = 'AI')::text AS ai,
        count(events.event_time) FILTER (WHERE events.queue_code = 'AFA')::text AS afa,
        count(events.event_time) FILTER (WHERE events.queue_code = 'RFY')::text AS rfy,
        count(events.event_time) FILTER (WHERE events.queue_code = 'OTHER')::text AS other
      FROM buckets
      LEFT JOIN events
        ON events.event_time >= buckets.bucket
       AND events.event_time  < buckets.bucket + $2::interval
      GROUP BY buckets.bucket
      ORDER BY buckets.bucket
      `,
      [TOTAL_INTERVAL, BUCKET_INTERVAL]
    );

    return result.rows.map((row) => ({
      bucket: row.bucket.toISOString(),
      added: Number(row.added) || 0,
      queues: {
        AI: Number(row.ai) || 0,
        AFA: Number(row.afa) || 0,
        RFY: Number(row.rfy) || 0,
        OTHER: Number(row.other) || 0,
      },
    }));
  } catch (err) {
    console.error('loadChartData failed', err);
    return [];
  }
}
