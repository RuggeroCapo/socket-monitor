import { getPool } from '@/lib/db';
import type { ChartPoint } from '@/lib/dashboard-types';

type BucketRow = { bucket: Date; added: string };

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
      )
      SELECT
        buckets.bucket,
        count(events.event_time)::text AS added
      FROM buckets
      LEFT JOIN vine_item_events AS events
        ON events.event_type = 'item_added'
       AND events.event_time >= buckets.bucket
       AND events.event_time  < buckets.bucket + $2::interval
      GROUP BY buckets.bucket
      ORDER BY buckets.bucket
      `,
      [TOTAL_INTERVAL, BUCKET_INTERVAL]
    );

    return result.rows.map((row) => ({
      bucket: row.bucket.toISOString(),
      added: Number(row.added) || 0,
    }));
  } catch (err) {
    console.error('loadChartData failed', err);
    return [];
  }
}
