-- Adds the durable notification outbox used by the Telegram notifier worker.
-- Safe to run multiple times.

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
