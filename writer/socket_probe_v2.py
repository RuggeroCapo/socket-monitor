#!/usr/bin/env python3
"""Vine Stats IT — collector / writer.

Connects to the Vine IT Socket.IO feed, persists raw events into
PostgreSQL+TimescaleDB through a non-hypertable dedupe table, and emits a
Postgres NOTIFY on `vine_events` after each successful insert so the Next.js
LISTEN dispatcher can fan out to live SSE clients.

Designed to run as a long-lived container alongside the database. The socket
loop and the Postgres loop are independent: a DB hiccup never kills the
socket loop and vice versa.

Environment:
  DATABASE_URL                  postgres://user:pass@host/db (required)
  SOCKET_URL                    wss://... (defaults to v-helper.com IT)
  HEARTBEAT_TIMEOUT_SECONDS     default 45
  RECONNECT_DELAY_SECONDS       default 5
  UNKNOWN_EVENT_LOG_INTERVAL    seconds, default 60 (per-event-name throttle)
  DEDUPE_CLEANUP_INTERVAL_HOURS default 24
  HEALTHCHECK_FILE              default /tmp/writer-health.json
  HEALTHCHECK_INTERVAL_SECONDS  default 15
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
from pathlib import Path
import signal
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

try:
    import asyncpg
except ImportError:
    print(
        "Missing dependency: asyncpg\nInstall it with: pip install -r requirements.txt",
        file=sys.stderr,
    )
    raise SystemExit(1)

try:
    import websockets
    from websockets.exceptions import ConnectionClosed
except ImportError:
    print(
        "Missing dependency: websockets\nInstall it with: pip install -r requirements.txt",
        file=sys.stderr,
    )
    raise SystemExit(1)


DEFAULT_SOCKET_URL = (
    "wss://api.v-helper.com/socket.io/"
    "?app_version=3.10.10"
    "&countryCode=it"
    "&uuid=639e138a-0e43-11f1-9839-fa163effef06"
    "&fid=58259"
    "&cid=7f1cf6cd0ee4ee0339d1ae05ce67ffc9c95f414b46c987b46b8c3f49f53f2312"
    "&device_name=Pumping%20Micro%20Zeppelin%20S-339"
    "&EIO=4"
    "&transport=websocket"
)

# Event names we know how to map. Anything else gets logged once per minute
# into collector_events as 'unknown_event' so we can extend the mapping later.
KNOWN_ITEM_EVENTS: dict[str, str] = {
    "newItem": "item_added",
    # When removal/claim event names are confirmed, add them here, e.g.:
    #   "removeItem": "item_removed",
    #   "itemClaimed": "item_removed",
}

ONLINE_COLLECTOR_EVENTS = {"connected", "gap_closed"}
OFFLINE_COLLECTOR_EVENTS = {"disconnected", "timeout", "gap_opened"}

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("vine.writer")

LIVE_EVENTS_CHANNEL = "vine_events"
OUTBOX_NOTIFY_CHANNEL = "notification_outbox"
TELEGRAM_OUTBOX_CHANNEL = "telegram"
DEFAULT_HEALTHCHECK_FILE = "/tmp/writer-health.json"
DEFAULT_HEALTHCHECK_INTERVAL_SECONDS = 15


def collector_status_for_event(event_type: str) -> str | None:
    if event_type in ONLINE_COLLECTOR_EVENTS:
        return "online"
    if event_type in OFFLINE_COLLECTOR_EVENTS:
        return "offline"
    return None


def as_utc_isoformat(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat()


def build_live_item_event_payload(
    event_type: str,
    asin: str,
    queue: str | None,
    event_time: datetime,
) -> str:
    return json.dumps(
        {
            "t": event_type,
            "a": asin,
            "queue": queue,
            "ts": as_utc_isoformat(event_time),
        },
        ensure_ascii=False,
    )


def build_item_added_outbox_payload(item: dict[str, Any], event_time: datetime) -> str:
    return json.dumps(
        {
            "item": item,
            "event_time": as_utc_isoformat(event_time),
        },
        ensure_ascii=False,
    )


def build_live_item_value_updated_payload(
    asin: str,
    item_value: float,
    currency: str | None,
    event_time: datetime,
) -> str:
    return json.dumps(
        {
            "t": "item_value_updated",
            "a": asin,
            "item_value": item_value,
            "currency": currency,
            "ts": as_utc_isoformat(event_time),
        },
        ensure_ascii=False,
    )


def build_live_collector_status_payload(
    event_type: str,
    status: str,
    event_time: datetime,
) -> str:
    return json.dumps(
        {
            "t": "collector_status",
            "status": status,
            "event_type": event_type,
            "ts": as_utc_isoformat(event_time),
        },
        ensure_ascii=False,
    )


def build_collector_status_outbox_payload(
    event_type: str,
    status: str,
    event_time: datetime,
    details: dict[str, Any] | None,
) -> str:
    return json.dumps(
        {
            "status": status,
            "event_type": event_type,
            "event_time": as_utc_isoformat(event_time),
            "details": details or {},
        },
        ensure_ascii=False,
    )


# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

@dataclass(slots=True)
class HealthState:
    service: str
    pid: int = field(default_factory=os.getpid)
    db_connected: bool = False
    socket_connected: bool = False
    last_heartbeat_at: float = field(default_factory=time.time)

    def snapshot(self) -> dict[str, Any]:
        return {
            "service": self.service,
            "pid": self.pid,
            "db_connected": self.db_connected,
            "socket_connected": self.socket_connected,
            "last_heartbeat_at": self.last_heartbeat_at,
        }


@dataclass(slots=True)
class Config:
    database_url: str
    socket_url: str
    heartbeat_timeout_seconds: float
    reconnect_delay_seconds: int
    unknown_event_log_interval: int
    dedupe_cleanup_interval_hours: int
    healthcheck_file: str
    healthcheck_interval_seconds: int


def load_config() -> Config:
    db_url = os.getenv("DATABASE_URL", "").strip()
    if not db_url:
        print("DATABASE_URL is required", file=sys.stderr)
        raise SystemExit(2)
    return Config(
        database_url=db_url,
        socket_url=os.getenv("SOCKET_URL", DEFAULT_SOCKET_URL).strip() or DEFAULT_SOCKET_URL,
        heartbeat_timeout_seconds=float(os.getenv("HEARTBEAT_TIMEOUT_SECONDS", "45")),
        reconnect_delay_seconds=int(os.getenv("RECONNECT_DELAY_SECONDS", "5")),
        unknown_event_log_interval=int(os.getenv("UNKNOWN_EVENT_LOG_INTERVAL", "60")),
        dedupe_cleanup_interval_hours=int(os.getenv("DEDUPE_CLEANUP_INTERVAL_HOURS", "24")),
        healthcheck_file=(
            os.getenv("HEALTHCHECK_FILE", DEFAULT_HEALTHCHECK_FILE).strip()
            or DEFAULT_HEALTHCHECK_FILE
        ),
        healthcheck_interval_seconds=max(
            1,
            int(
                os.getenv(
                    "HEALTHCHECK_INTERVAL_SECONDS",
                    str(DEFAULT_HEALTHCHECK_INTERVAL_SECONDS),
                )
            ),
        ),
    )


def write_healthcheck_file(path_str: str, payload: dict[str, Any]) -> None:
    path = Path(path_str)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = path.with_name(f"{path.name}.tmp")
    tmp_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    tmp_path.replace(path)


async def healthcheck_task(
    *,
    path: str,
    interval_seconds: int,
    state: HealthState,
    stop_event: asyncio.Event,
) -> None:
    while not stop_event.is_set():
        state.last_heartbeat_at = time.time()
        try:
            write_healthcheck_file(path, state.snapshot())
        except Exception as exc:  # noqa: BLE001
            log.warning("healthcheck write failed: %s: %s", type(exc).__name__, exc)

        try:
            await asyncio.wait_for(stop_event.wait(), timeout=interval_seconds)
        except asyncio.TimeoutError:
            continue


# ---------------------------------------------------------------------------
# DB writer (single persistent asyncpg connection, independent reconnect)
# ---------------------------------------------------------------------------

@dataclass
class DBWriter:
    database_url: str
    health_state: HealthState
    _conn: asyncpg.Connection | None = None
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def _ensure_conn(self) -> asyncpg.Connection | None:
        """Returns a live connection, opening one if needed.

        On failure returns None — the caller should drop the event with a
        warning rather than buffer indefinitely.
        """
        if self._conn is not None and not self._conn.is_closed():
            return self._conn

        try:
            self._conn = await asyncpg.connect(self.database_url)
            self.health_state.db_connected = True
            log.info("Postgres connection established")
            return self._conn
        except Exception as exc:  # noqa: BLE001
            log.warning("Postgres connection failed: %s: %s", type(exc).__name__, exc)
            self.health_state.db_connected = False
            self._conn = None
            return None

    async def reconnect_loop(self, stop_event: asyncio.Event) -> None:
        """Background task that keeps the DB connection healthy.

        Independent from the socket loop: a Postgres outage never kills the
        socket reader, and vice versa.
        """
        backoff = 1
        while not stop_event.is_set():
            conn = await self._ensure_conn()
            if conn is not None:
                backoff = 1
                # Cheap liveness check every 5s
                try:
                    await asyncio.wait_for(stop_event.wait(), timeout=5)
                except asyncio.TimeoutError:
                    try:
                        async with self._lock:
                            await conn.execute("SELECT 1")
                    except Exception as exc:  # noqa: BLE001
                        log.warning("Postgres ping failed: %s: %s", type(exc).__name__, exc)
                        self.health_state.db_connected = False
                        try:
                            await conn.close()
                        except Exception:  # noqa: BLE001
                            pass
                        self.health_state.db_connected = False
                        self._conn = None
                continue

            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 30)

    async def write_item_event(
        self,
        *,
        event_type: str,
        asin: str,
        queue: str | None,
        title: str | None,
        item_value: float | None,
        currency: str | None,
        source_event_key: str,
        event_time: datetime,
        raw_payload: dict[str, Any],
    ) -> bool:
        """Dedupe + insert + NOTIFY in one transaction.

        Returns True if the row was actually inserted (i.e. not a duplicate).
        Returns False on duplicate or DB unavailable.
        """
        conn = await self._ensure_conn()
        if conn is None:
            log.warning("Dropping %s for %s: DB unavailable", event_type, asin)
            return False

        live_payload = build_live_item_event_payload(event_type, asin, queue, event_time)
        outbox_payload = (
            build_item_added_outbox_payload(raw_payload, event_time)
            if event_type == "item_added"
            else None
        )

        async with self._lock:
            try:
                async with conn.transaction():
                    inserted = await conn.fetchrow(
                        """
                        WITH dedupe AS (
                            INSERT INTO vine_event_dedupe(source_event_key)
                            VALUES ($1)
                            ON CONFLICT DO NOTHING
                            RETURNING source_event_key
                        )
                        INSERT INTO vine_item_events(
                            event_time, event_type, asin, queue, title,
                            item_value, currency, source_event_key, raw_payload
                        )
                        SELECT $2, $3, $4, $5, $6, $7, $8, $1, $9::jsonb
                        WHERE EXISTS (SELECT 1 FROM dedupe)
                        RETURNING id
                        """,
                        source_event_key,
                        event_time,
                        event_type,
                        asin,
                        queue,
                        title,
                        item_value,
                        currency,
                        json.dumps(raw_payload, ensure_ascii=False),
                    )
                    if not inserted:
                        return False

                    if outbox_payload is not None:
                        await conn.execute(
                            """
                            INSERT INTO notification_outbox(
                                channel, event_type, source_event_key, payload
                            )
                            VALUES ($1, $2, $3, $4::jsonb)
                            ON CONFLICT (channel, source_event_key) DO NOTHING
                            """,
                            TELEGRAM_OUTBOX_CHANNEL,
                            event_type,
                            source_event_key,
                            outbox_payload,
                        )
                        await conn.execute(
                            "SELECT pg_notify($1, $2)",
                            OUTBOX_NOTIFY_CHANNEL,
                            TELEGRAM_OUTBOX_CHANNEL,
                        )

                    # NOTIFY payload must stay well under 8000 bytes
                    await conn.execute(
                        "SELECT pg_notify($1, $2)",
                        LIVE_EVENTS_CHANNEL,
                        live_payload,
                    )
                return True
            except Exception as exc:  # noqa: BLE001
                log.warning("write_item_event failed: %s: %s", type(exc).__name__, exc)
                # Connection may be in bad state — drop it so reconnect_loop reopens
                try:
                    await conn.close()
                except Exception:  # noqa: BLE001
                    pass
                self.health_state.db_connected = False
                self._conn = None
                return False

    async def update_item_value(
        self,
        *,
        asin: str,
        item_value: float,
        currency: str | None,
        source_event_key: str,
        event_time: datetime,
        raw_payload: dict[str, Any],
    ) -> bool:
        """Update the latest stored item row for an ASIN and emit NOTIFY."""
        conn = await self._ensure_conn()
        if conn is None:
            log.warning("Dropping item_value_updated for %s: DB unavailable", asin)
            return False

        live_payload: str | None = None

        async with self._lock:
            try:
                async with conn.transaction():
                    updated = await conn.fetchrow(
                        """
                        WITH latest AS (
                            SELECT id, event_time
                            FROM vine_item_events
                            WHERE asin = $2
                              AND event_type = 'item_added'
                            ORDER BY event_time DESC, id DESC
                            LIMIT 1
                        ),
                        ins AS (
                            INSERT INTO vine_event_dedupe(source_event_key)
                            SELECT $1
                            WHERE EXISTS (SELECT 1 FROM latest)
                            ON CONFLICT DO NOTHING
                            RETURNING source_event_key
                        )
                        UPDATE vine_item_events AS events
                        SET
                            item_value = $3,
                            currency = COALESCE($4, events.currency, 'EUR'),
                            raw_payload = CASE
                                WHEN jsonb_typeof(events.raw_payload) = 'object'
                                    THEN events.raw_payload || $5::jsonb
                                ELSE $5::jsonb
                            END
                        FROM latest
                        WHERE events.id = latest.id
                          AND events.event_time = latest.event_time
                          AND EXISTS (SELECT 1 FROM ins)
                        RETURNING
                            events.asin,
                            events.item_value::text AS item_value,
                            events.currency
                        """,
                        source_event_key,
                        asin,
                        item_value,
                        currency,
                        json.dumps(raw_payload, ensure_ascii=False),
                    )

                    if updated is None:
                        return False

                    live_payload = build_live_item_value_updated_payload(
                        asin=asin,
                        item_value=float(updated["item_value"]),
                        currency=updated["currency"],
                        event_time=event_time,
                    )
                    await conn.execute(
                        "SELECT pg_notify($1, $2)",
                        LIVE_EVENTS_CHANNEL,
                        live_payload,
                    )
                return True
            except Exception as exc:  # noqa: BLE001
                log.warning("update_item_value failed: %s: %s", type(exc).__name__, exc)
                try:
                    await conn.close()
                except Exception:  # noqa: BLE001
                    pass
                self.health_state.db_connected = False
                self._conn = None
                return False

    async def log_collector_event(
        self,
        event_type: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        conn = await self._ensure_conn()
        if conn is None:
            log.info("Could not persist collector_event %s (DB unavailable)", event_type)
            return
        async with self._lock:
            try:
                async with conn.transaction():
                    inserted = await conn.fetchrow(
                        """
                        INSERT INTO collector_events(event_type, details)
                        VALUES ($1, $2::jsonb)
                        RETURNING id, time
                        """,
                        event_type,
                        json.dumps(details or {}, ensure_ascii=False),
                    )
                    if inserted is None:
                        return

                    status = collector_status_for_event(event_type)
                    if status:
                        event_time = inserted["time"]
                        await conn.execute(
                            """
                            INSERT INTO notification_outbox(
                                channel, event_type, source_event_key, payload
                            )
                            VALUES ($1, $2, $3, $4::jsonb)
                            ON CONFLICT (channel, source_event_key) DO NOTHING
                            """,
                            TELEGRAM_OUTBOX_CHANNEL,
                            "collector_status",
                            f"collector_status:{event_type}:{inserted['id']}",
                            build_collector_status_outbox_payload(
                                event_type=event_type,
                                status=status,
                                event_time=event_time,
                                details=details,
                            ),
                        )
                        await conn.execute(
                            "SELECT pg_notify($1, $2)",
                            LIVE_EVENTS_CHANNEL,
                            build_live_collector_status_payload(
                                event_type=event_type,
                                status=status,
                                event_time=event_time,
                            ),
                        )
                        await conn.execute(
                            "SELECT pg_notify($1, $2)",
                            OUTBOX_NOTIFY_CHANNEL,
                            TELEGRAM_OUTBOX_CHANNEL,
                        )
            except Exception as exc:  # noqa: BLE001
                log.warning("log_collector_event failed: %s: %s", type(exc).__name__, exc)
                try:
                    await conn.close()
                except Exception:  # noqa: BLE001
                    pass
                self.health_state.db_connected = False
                self._conn = None

    async def cleanup_dedupe(self) -> int:
        conn = await self._ensure_conn()
        if conn is None:
            return 0
        async with self._lock:
            try:
                status = await conn.execute(
                    "DELETE FROM vine_event_dedupe WHERE first_seen < now() - INTERVAL '8 days'"
                )
                # "DELETE N"
                try:
                    return int(status.split()[1])
                except (IndexError, ValueError):
                    return 0
            except Exception as exc:  # noqa: BLE001
                log.warning("cleanup_dedupe failed: %s: %s", type(exc).__name__, exc)
                return 0


async def dedupe_cleanup_task(writer: DBWriter, interval_hours: int, stop_event: asyncio.Event) -> None:
    interval = max(1, interval_hours) * 3600
    while not stop_event.is_set():
        try:
            await asyncio.wait_for(stop_event.wait(), timeout=interval)
            return  # stop_event set
        except asyncio.TimeoutError:
            pass
        rows = await writer.cleanup_dedupe()
        await writer.log_collector_event("dedupe_cleanup", {"rows": rows})
        log.info("dedupe cleanup removed %d rows", rows)


# ---------------------------------------------------------------------------
# Source event key
# ---------------------------------------------------------------------------

def compute_source_event_key(
    event_type: str,
    asin: str,
    item: dict[str, Any],
) -> str:
    """Stable per-event key for dedupe.

    Prefer a source-side timestamp when available; otherwise hash the
    normalized payload. This is the function to revisit once we see real
    removal/claim events and know which fields they expose.
    """
    src_ts = item.get("date_added") or item.get("date") or item.get("created_at")
    if src_ts:
        return f"{event_type}:{asin}:{src_ts}"
    digest = hashlib.sha1(
        json.dumps(item, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()[:16]
    return f"{event_type}:{asin}:{digest}"


def parse_event_time(item: dict[str, Any]) -> datetime:
    """Parse a source-side timestamp into a tz-aware datetime, fall back to now()."""
    raw = item.get("date_added") or item.get("date") or item.get("created_at")
    if isinstance(raw, str) and raw:
        for parser in (datetime.fromisoformat,):
            try:
                dt = parser(raw.replace("Z", "+00:00"))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
                return dt
            except ValueError:
                pass
    if isinstance(raw, (int, float)):
        # Heuristic: ms vs s
        try:
            ts = float(raw)
            if ts > 1e12:
                ts /= 1000.0
            return datetime.fromtimestamp(ts, tz=timezone.utc)
        except (OverflowError, ValueError):
            pass
    return datetime.now(timezone.utc)


def coerce_float(value: Any) -> float | None:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Socket.IO frame helpers (lifted in spirit from socket_probe.py)
# ---------------------------------------------------------------------------

def try_parse_event_frame(frame: str) -> tuple[str, Any] | None:
    if not frame.startswith("42"):
        return None
    try:
        payload = json.loads(frame[2:])
    except json.JSONDecodeError:
        return None
    if isinstance(payload, list) and payload:
        event_name = str(payload[0])
        event_payload = payload[1] if len(payload) > 1 else None
        return event_name, event_payload
    return None


# ---------------------------------------------------------------------------
# Collector main loop
# ---------------------------------------------------------------------------

class Collector:
    def __init__(self, config: Config, writer: DBWriter) -> None:
        self.config = config
        self.writer = writer
        self._gap_open = False
        self._unknown_last_logged: dict[str, float] = {}

    async def run(self, stop_event: asyncio.Event) -> None:
        await self.writer.log_collector_event("restart", {})
        while not stop_event.is_set():
            try:
                code = await self._connect_once(stop_event)
                log.info("Socket connection ended (code=%s), reconnecting", code)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                log.warning("Socket loop error: %s: %s", type(exc).__name__, exc)
                await self.writer.log_collector_event(
                    "disconnected",
                    {"reason": f"{type(exc).__name__}: {exc}"},
                )
                await self._open_gap_if_needed("loop_error")

            try:
                await asyncio.wait_for(
                    stop_event.wait(),
                    timeout=self.config.reconnect_delay_seconds,
                )
                return
            except asyncio.TimeoutError:
                pass

    async def _open_gap_if_needed(self, reason: str) -> None:
        if not self._gap_open:
            self._gap_open = True
            await self.writer.log_collector_event("gap_opened", {"reason": reason})

    async def _close_gap_if_needed(self) -> None:
        if self._gap_open:
            self._gap_open = False
            await self.writer.log_collector_event("gap_closed", {})

    async def _connect_once(self, stop_event: asyncio.Event) -> int:
        log.info("Connecting to %s", self.config.socket_url)
        namespace_connected = False
        try:
            async with websockets.connect(
                self.config.socket_url,
                open_timeout=self.config.heartbeat_timeout_seconds,
                close_timeout=5,
                ping_interval=None,
                max_size=None,
            ) as ws:
                log.info("Socket transport CONNECTED")

                while not stop_event.is_set():
                    try:
                        frame = await asyncio.wait_for(
                            ws.recv(),
                            timeout=self.config.heartbeat_timeout_seconds,
                        )
                    except asyncio.TimeoutError:
                        log.warning(
                            "Socket TIMEOUT after %.1fs",
                            self.config.heartbeat_timeout_seconds,
                        )
                        await self.writer.log_collector_event(
                            "timeout",
                            {"after_seconds": self.config.heartbeat_timeout_seconds},
                        )
                        await self._open_gap_if_needed("timeout")
                        return 2

                    if not isinstance(frame, str):
                        continue

                    if frame == "2":
                        await ws.send("3")
                        continue

                    if frame.startswith("0"):
                        await ws.send("40")
                        continue

                    if frame == "40" or frame.startswith("40{"):
                        namespace_connected = True
                        self.writer.health_state.socket_connected = True
                        log.info("Socket namespace CONNECTED")
                        await self.writer.log_collector_event("connected", {})
                        await self._close_gap_if_needed()
                        continue

                    parsed = try_parse_event_frame(frame)
                    if not parsed:
                        continue

                    event_name, event_payload = parsed
                    should_reconnect = await self._dispatch_event(event_name, event_payload)
                    if should_reconnect:
                        return 6

                return 0

        except ConnectionClosed as exc:
            log.warning("Socket CLOSED code=%s reason=%r", exc.code, exc.reason)
            await self.writer.log_collector_event(
                "disconnected",
                {"code": exc.code, "reason": exc.reason or ""},
            )
            await self._open_gap_if_needed(f"closed:{exc.code}")
            return 5
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # noqa: BLE001
            log.warning("Socket ERROR: %s: %s", type(exc).__name__, exc)
            await self.writer.log_collector_event(
                "disconnected",
                {"reason": f"{type(exc).__name__}: {exc}"},
            )
            await self._open_gap_if_needed(f"error:{type(exc).__name__}")
            return 1
        finally:
            self.writer.health_state.socket_connected = False
            if not namespace_connected:
                await self._open_gap_if_needed("never_connected")

    async def _dispatch_event(self, event_name: str, payload: Any) -> bool:
        if event_name == "serverDisconnect":
            log.warning("Socket serverDisconnect event received")
            await self.writer.log_collector_event(
                "disconnected",
                {"reason": "serverDisconnect"},
            )
            await self._open_gap_if_needed("serverDisconnect")
            await self._log_unknown_event(event_name, payload)
            return True

        if event_name == "newETV":
            item = payload.get("item") if isinstance(payload, dict) else None
            if not isinstance(item, dict):
                log.info("Ignoring newETV with malformed payload")
                return False

            asin = str(item.get("asin") or "").strip()
            if not asin:
                log.info("Ignoring newETV without ASIN")
                return False

            item_value = coerce_float(item.get("etv") or item.get("item_value") or item.get("value"))
            if item_value is None:
                log.info("Ignoring newETV without numeric etv for %s", asin)
                return False

            currency = (str(item.get("currency") or "").strip() or "EUR")
            event_time = parse_event_time(item)
            source_event_key = compute_source_event_key("item_value_updated", asin, item)

            updated = await self.writer.update_item_value(
                asin=asin,
                item_value=item_value,
                currency=currency,
                source_event_key=source_event_key,
                event_time=event_time,
                raw_payload=item,
            )

            if updated:
                log.info("UPDATE item_value_updated asin=%s etv=%.2f", asin, item_value)
            else:
                log.debug("SKIP item_value_updated asin=%s", asin)
            return False

        mapped = KNOWN_ITEM_EVENTS.get(event_name)
        if mapped is None:
            await self._log_unknown_event(event_name, payload)
            return False

        item = payload.get("item") if isinstance(payload, dict) else None
        if not isinstance(item, dict):
            log.info("Ignoring %s with malformed payload", event_name)
            return False

        asin = str(item.get("asin") or "").strip()
        if not asin:
            log.info("Ignoring %s without ASIN", event_name)
            return False

        queue = (str(item.get("queue") or "").strip() or None)
        title = (str(item.get("title") or "").strip() or None)
        currency = (str(item.get("currency") or "").strip() or None)
        item_value = coerce_float(item.get("item_value") or item.get("value"))
        event_time = parse_event_time(item)
        source_event_key = compute_source_event_key(mapped, asin, item)

        inserted = await self.writer.write_item_event(
            event_type=mapped,
            asin=asin,
            queue=queue,
            title=title,
            item_value=item_value,
            currency=currency,
            source_event_key=source_event_key,
            event_time=event_time,
            raw_payload=item,
        )

        if inserted:
            log.info("INSERT %s asin=%s queue=%s", mapped, asin, queue)
        else:
            log.debug("DEDUPE %s asin=%s", mapped, asin)
        return False

    async def _log_unknown_event(self, event_name: str, payload: Any) -> None:
        now = time.monotonic()
        last = self._unknown_last_logged.get(event_name, 0.0)
        if now - last < self.config.unknown_event_log_interval:
            return
        self._unknown_last_logged[event_name] = now

        # Truncate payload to keep details JSON small
        sample = json.dumps(payload, ensure_ascii=False, default=str)
        if len(sample) > 2000:
            sample = sample[:2000] + "...<truncated>"

        await self.writer.log_collector_event(
            "unknown_event",
            {"name": event_name, "sample_payload": sample},
        )
        log.info("UNKNOWN event_name=%s (logged sample)", event_name)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

async def amain() -> int:
    config = load_config()
    health_state = HealthState(service="writer")
    writer = DBWriter(database_url=config.database_url, health_state=health_state)

    stop_event = asyncio.Event()

    def _signal_handler(*_args: Any) -> None:
        log.info("Shutdown signal received")
        stop_event.set()

    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(sig, _signal_handler)
        except NotImplementedError:
            pass

    db_task = asyncio.create_task(writer.reconnect_loop(stop_event), name="db_reconnect")
    cleanup_task = asyncio.create_task(
        dedupe_cleanup_task(writer, config.dedupe_cleanup_interval_hours, stop_event),
        name="dedupe_cleanup",
    )
    writer_health_task = asyncio.create_task(
        healthcheck_task(
            path=config.healthcheck_file,
            interval_seconds=config.healthcheck_interval_seconds,
            state=health_state,
            stop_event=stop_event,
        ),
        name="writer_healthcheck",
    )

    collector = Collector(config, writer)
    try:
        await collector.run(stop_event)
    finally:
        stop_event.set()
        for task in (db_task, cleanup_task, writer_health_task):
            task.cancel()
        for task in (db_task, cleanup_task, writer_health_task):
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001
                pass
        if writer._conn is not None:
            try:
                await writer._conn.close()
            except Exception:  # noqa: BLE001
                pass
        writer.health_state.db_connected = False
        writer.health_state.socket_connected = False

    return 0


def main() -> int:
    try:
        return asyncio.run(amain())
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
