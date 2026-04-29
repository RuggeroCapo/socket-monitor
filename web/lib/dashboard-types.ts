export type QueueCode = 'AI' | 'AFA' | 'RFY' | 'OTHER';

export type ChartPoint = {
  bucket: string;
  added: number;
  queues?: Partial<Record<QueueCode, number>>;
};

export type TimeFilter = {
  since: string; // ISO
  until: string; // ISO
  source?: 'chart' | 'heatmap';
  label?: string;
};

export type ChartResponse = {
  points: ChartPoint[];
};

export type ProductSortMode = 'newest' | 'value_desc' | 'value_asc';

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

export type ProductsResponse = {
  products: DashboardProduct[];
  offset: number;
  limit: number;
  total: number;
};

export type SnapshotResponse = {
  added_7d: number;
  added_24h: number;
  added_1h: number;
  tracked_value_24h: number;
  avg_item_value_24h: number | null;
  missing_item_value_24h: number;
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
