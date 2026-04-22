-- Vine Stats IT — initial schema
-- Idempotent: safe to re-run. Mounted into the timescale image at
-- /docker-entrypoint-initdb.d/init.sql so it executes on first boot.

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- ---------------------------------------------------------------------------
-- 1. Raw item events (hypertable, 7-day retention)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS vine_item_events (
  id                  BIGSERIAL,
  event_time          TIMESTAMPTZ NOT NULL,
  ingest_time         TIMESTAMPTZ NOT NULL DEFAULT now(),
  marketplace         TEXT NOT NULL DEFAULT 'IT',
  event_type          TEXT NOT NULL,
  asin                TEXT NOT NULL,
  queue               TEXT,
  title               TEXT,
  item_value          NUMERIC(10,2),
  currency            TEXT,
  source_event_key    TEXT NOT NULL,
  raw_payload         JSONB NOT NULL,
  PRIMARY KEY (id, event_time)
);

SELECT create_hypertable(
  'vine_item_events',
  'event_time',
  if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS vine_item_events_event_time_idx
  ON vine_item_events (event_time DESC);

CREATE INDEX IF NOT EXISTS vine_item_events_asin_event_time_idx
  ON vine_item_events (asin, event_time DESC);

CREATE INDEX IF NOT EXISTS vine_item_events_type_event_time_idx
  ON vine_item_events (event_type, event_time DESC);

-- Note: NO unique index on source_event_key. Timescale hypertables require
-- the partitioning column in every unique index, which would defeat the
-- purpose. Dedupe lives in vine_event_dedupe instead.

-- ---------------------------------------------------------------------------
-- 2. Dedupe table (NOT a hypertable; cleaned daily by the writer)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS vine_event_dedupe (
  source_event_key TEXT PRIMARY KEY,
  first_seen       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS vine_event_dedupe_first_seen_idx
  ON vine_event_dedupe (first_seen);

-- ---------------------------------------------------------------------------
-- 3. Collector health / gap tracking (hypertable)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS collector_events (
  id            BIGSERIAL,
  time          TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_type    TEXT NOT NULL,
  details       JSONB,
  PRIMARY KEY (id, time)
);

SELECT create_hypertable(
  'collector_events',
  'time',
  if_not_exists => TRUE
);

CREATE INDEX IF NOT EXISTS collector_events_type_time_idx
  ON collector_events (event_type, time DESC);

CREATE INDEX IF NOT EXISTS collector_events_time_idx
  ON collector_events (time DESC);

-- ---------------------------------------------------------------------------
-- 4. Durable notification outbox (regular table)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS notification_outbox (
  id                BIGSERIAL PRIMARY KEY,
  channel           TEXT NOT NULL,
  event_type        TEXT NOT NULL,
  source_event_key  TEXT NOT NULL,
  payload           JSONB NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  available_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_expires_at  TIMESTAMPTZ,
  sent_at           TIMESTAMPTZ,
  attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_attempt_at   TIMESTAMPTZ,
  worker_id         TEXT,
  last_error        TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS notification_outbox_channel_source_key_uidx
  ON notification_outbox (channel, source_event_key);

CREATE INDEX IF NOT EXISTS notification_outbox_ready_idx
  ON notification_outbox (channel, available_at, id)
  WHERE sent_at IS NULL;

CREATE INDEX IF NOT EXISTS notification_outbox_lease_idx
  ON notification_outbox (lease_expires_at)
  WHERE sent_at IS NULL AND lease_expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS notification_outbox_sent_at_idx
  ON notification_outbox (sent_at DESC)
  WHERE sent_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 5. Continuous aggregate: 1-hour buckets (long-lived)
-- ---------------------------------------------------------------------------

CREATE MATERIALIZED VIEW IF NOT EXISTS vine_events_1h
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', event_time) AS bucket,
  event_type,
  count(*)                                             AS event_count,
  avg(item_value) FILTER (WHERE item_value IS NOT NULL) AS avg_item_value,
  sum(item_value) FILTER (WHERE item_value IS NOT NULL) AS sum_item_value
FROM vine_item_events
GROUP BY bucket, event_type
WITH NO DATA;

-- Refresh policy: look back 6h, end 5m before now, run every 5m. Comfortably
-- inside the 7-day raw retention so the CAGG materializes before chunks drop.
SELECT add_continuous_aggregate_policy(
  'vine_events_1h',
  start_offset      => INTERVAL '6 hours',
  end_offset        => INTERVAL '5 minutes',
  schedule_interval => INTERVAL '5 minutes',
  if_not_exists     => TRUE
);

-- ---------------------------------------------------------------------------
-- 6. Retention: drop raw chunks older than 7 days
--    Must be added AFTER the CAGG so the aggregate has time to materialize.
-- ---------------------------------------------------------------------------

SELECT add_retention_policy(
  'vine_item_events',
  INTERVAL '7 days',
  if_not_exists => TRUE
);

-- ---------------------------------------------------------------------------
-- 7. data_quality(from, to) — single source of truth for partial-data badges
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION data_quality(from_ts TIMESTAMPTZ, to_ts TIMESTAMPTZ)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_event_in_window INT;
  v_last_status     TEXT;
BEGIN
  -- Any disconnect / timeout / gap marker inside the window => partial
  SELECT count(*) INTO v_event_in_window
  FROM collector_events
  WHERE time >= from_ts
    AND time <= to_ts
    AND event_type IN ('disconnected', 'timeout', 'gap_opened', 'gap_closed', 'restart');

  IF v_event_in_window > 0 THEN
    RETURN 'partial';
  END IF;

  -- The most recent status event AT OR BEFORE from_ts must show the writer
  -- was connected entering the window. Otherwise we have no evidence the
  -- window was actually covered.
  SELECT event_type INTO v_last_status
  FROM collector_events
  WHERE time <= from_ts
    AND event_type IN (
      'connected', 'disconnected', 'timeout',
      'gap_opened', 'gap_closed', 'restart'
    )
  ORDER BY time DESC
  LIMIT 1;

  IF v_last_status IS NULL OR v_last_status NOT IN ('connected', 'gap_closed') THEN
    RETURN 'partial';
  END IF;

  RETURN 'ok';
END;
$$;
