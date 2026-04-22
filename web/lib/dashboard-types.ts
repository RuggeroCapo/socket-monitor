export type ChartPoint = {
  bucket: string;
  added: number;
};

export type ChartResponse = {
  points: ChartPoint[];
};

export type QueueCode = 'AI' | 'AFA' | 'RFY' | 'OTHER';

export type HourlyActivityPoint = {
  bucket: string;
  label: string;
  added: number;
};

export type DashboardProduct = {
  asin: string;
  queue: QueueCode;
  title: string | null;
  item_value: number | null;
  currency: string | null;
  event_time: string;
  image_url: string | null;
  detail_url: string;
};

export type SnapshotResponse = {
  added_7d: number;
  added_24h: number;
  added_1h: number;
  tracked_value_24h: number;
  avg_item_value_24h: number | null;
  data_quality: 'ok' | 'partial';
  daily_counts: { day: string; label: string; added: number }[];
  hourly_activity_24h: HourlyActivityPoint[];
  recent_products: DashboardProduct[];
  queue_mix_24h: { queue: QueueCode; count: number }[];
  queue_totals: { queue: QueueCode; count: number }[];
  total_products: number;
  as_of: string;
};

export type HealthResponse = {
  collector_status: 'online' | 'offline';
  last_event_time: string | null;
  last_collector_event: { event_type: string; time: string } | null;
  gap_open: boolean;
  data_quality_1h: 'ok' | 'partial';
  as_of: string;
};
