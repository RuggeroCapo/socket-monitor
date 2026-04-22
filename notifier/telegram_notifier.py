#!/usr/bin/env python3
"""Telegram notification worker backed by the notification_outbox table.

Reads durable jobs from PostgreSQL, sends Telegram messages, and retries with
leases so jobs recover cleanly after process crashes or transient API errors.

Environment:
  DATABASE_URL                         postgres://user:pass@host/db (required)
  TELEGRAM_BOT_TOKEN                   Telegram bot token (required)
  TELEGRAM_CHAT_ID                     Telegram chat/channel ID (required)
  TELEGRAM_DISABLE_PREVIEW             default true
  TELEGRAM_BATCH_SIZE                  default 10
  TELEGRAM_IDLE_POLL_SECONDS           default 30
  TELEGRAM_LEASE_SECONDS               default 120
  TELEGRAM_RETRY_BASE_SECONDS          default 15
  TELEGRAM_RETRY_MAX_SECONDS           default 900
  TELEGRAM_SENT_RETENTION_DAYS         default 14
  TELEGRAM_CLEANUP_INTERVAL_HOURS      default 24
  TELEGRAM_VINE_URL_TEMPLATE           default https://www.amazon.it/dp/{asin}
  HEALTHCHECK_FILE                     default /tmp/notifier-health.json
  HEALTHCHECK_INTERVAL_SECONDS         default 15
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from pathlib import Path
import signal
import socket
import sys
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

try:
    import asyncpg
except ImportError:
    print(
        "Missing dependency: asyncpg\nInstall it with: pip install -r requirements.txt",
        file=sys.stderr,
    )
    raise SystemExit(1)


OUTBOX_NOTIFY_CHANNEL = "notification_outbox"
TELEGRAM_OUTBOX_CHANNEL = "telegram"
DEFAULT_VINE_URL_TEMPLATE = "https://www.amazon.it/dp/{asin}"
DEFAULT_HEALTHCHECK_FILE = "/tmp/notifier-health.json"
DEFAULT_HEALTHCHECK_INTERVAL_SECONDS = 15

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("vine.telegram_notifier")


def env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def backoff_seconds(attempts: int, base: int, maximum: int) -> int:
    exponent = max(0, attempts - 1)
    return min(base * (2**exponent), maximum)


def truncate_error(message: str, limit: int = 1000) -> str:
    cleaned = " ".join(message.strip().split())
    if len(cleaned) <= limit:
        return cleaned
    return cleaned[: limit - 3] + "..."


def normalize_outbox_payload(payload: Any) -> dict[str, Any]:
    if isinstance(payload, dict):
        return payload
    if isinstance(payload, (bytes, bytearray)):
        try:
            payload = payload.decode("utf-8")
        except UnicodeDecodeError:
            return {"value": payload}
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except json.JSONDecodeError:
            return {"value": payload}
        if isinstance(payload, dict):
            return payload
    return {"value": payload}


def build_vine_url(asin: str, template: str) -> str:
    return template.format(asin=quote(asin, safe=""))


def format_item_added_message(
    item: dict[str, Any],
    vine_url_template: str,
) -> tuple[str, str]:
    asin = str(item.get("asin") or "unknown")
    title = str(item.get("title") or asin)
    queue = str(item.get("queue") or "unknown")
    reason = str(item.get("reason") or "new item")
    tier = str(item.get("tier") or "unknown")
    added_at = str(item.get("date_added") or item.get("date") or "")
    image_url = str(item.get("img_url") or "")
    item_value = item.get("item_value") or item.get("value")
    currency = str(item.get("currency") or "EUR")
    vine_url = build_vine_url(asin, vine_url_template)

    body_lines = [
        title,
        "",
        f"ASIN: {asin}",
        f"Queue: {queue}",
        f"Reason: {reason}",
        f"Tier: {tier}",
    ]
    if item_value not in (None, ""):
        body_lines.append(f"Value: {item_value} {currency}")
    if added_at:
        body_lines.append(f"Added: {added_at}")
    if image_url:
        body_lines.append(f"Image: {image_url}")
    body_lines.append(f"Open Product: {vine_url}")

    return f"New Vine Item [{queue}]", "\n".join(body_lines)


def format_collector_status_message(payload: dict[str, Any]) -> tuple[str, str]:
    status = str(payload.get("status") or "unknown")
    event_type = str(payload.get("event_type") or "unknown")
    event_time = str(payload.get("event_time") or "")
    details = payload.get("details")

    title = "Collector online" if status == "online" else "Collector offline"
    body_lines = [
        f"Status: {status}",
        f"Event: {event_type}",
    ]
    if event_time:
        body_lines.append(f"Time: {event_time}")
    if isinstance(details, dict):
        reason = details.get("reason")
        code = details.get("code")
        after_seconds = details.get("after_seconds")
        if reason:
            body_lines.append(f"Reason: {reason}")
        if code not in (None, ""):
            body_lines.append(f"Code: {code}")
        if after_seconds not in (None, ""):
            body_lines.append(f"After seconds: {after_seconds}")
    elif details:
        body_lines.append(f"Details: {details}")

    return title, "\n".join(body_lines)


class RetryableSendError(RuntimeError):
    def __init__(self, message: str, retry_after_seconds: int | None = None) -> None:
        super().__init__(message)
        self.retry_after_seconds = retry_after_seconds


def send_telegram_message(
    bot_token: str,
    chat_id: str,
    title: str,
    message: str,
    disable_preview: bool,
) -> None:
    text = f"{title}\n\n{message}"
    payload = {
        "chat_id": chat_id,
        "text": text,
        "disable_web_page_preview": disable_preview,
    }
    body = json.dumps(payload).encode("utf-8")
    request = Request(
        f"https://api.telegram.org/bot{bot_token}/sendMessage",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urlopen(request, timeout=20) as response:  # noqa: S310
            data = json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:  # pragma: no cover - exercised via live API only
        raw = exc.read().decode("utf-8", errors="replace")
        retry_after: int | None = None
        try:
            parsed = json.loads(raw)
            retry_value = parsed.get("parameters", {}).get("retry_after")
            if retry_value is not None:
                retry_after = int(retry_value)
        except (ValueError, TypeError, AttributeError):
            pass
        raise RetryableSendError(
            f"Telegram HTTP {exc.code}: {raw or exc.reason}",
            retry_after_seconds=retry_after,
        ) from exc
    except URLError as exc:  # pragma: no cover - exercised via live API only
        raise RetryableSendError(f"Telegram network error: {exc}") from exc

    if not data.get("ok"):
        retry_after: int | None = None
        retry_value = data.get("parameters", {}).get("retry_after")
        if retry_value is not None:
            try:
                retry_after = int(retry_value)
            except (TypeError, ValueError):
                retry_after = None
        raise RetryableSendError(
            f"Telegram API returned error payload: {data}",
            retry_after_seconds=retry_after,
        )

@dataclass(slots=True)
class HealthState:
    service: str
    pid: int = field(default_factory=os.getpid)
    db_connected: bool = False
    listener_connected: bool = False
    last_heartbeat_at: float = field(default_factory=time.time)

    def snapshot(self) -> dict[str, Any]:
        return {
            "service": self.service,
            "pid": self.pid,
            "db_connected": self.db_connected,
            "listener_connected": self.listener_connected,
            "last_heartbeat_at": self.last_heartbeat_at,
        }


@dataclass(slots=True)
class Config:
    database_url: str
    telegram_bot_token: str
    telegram_chat_id: str
    telegram_disable_preview: bool
    batch_size: int
    idle_poll_seconds: int
    lease_seconds: int
    retry_base_seconds: int
    retry_max_seconds: int
    sent_retention_days: int
    cleanup_interval_hours: int
    vine_url_template: str
    healthcheck_file: str
    healthcheck_interval_seconds: int


def load_config() -> Config:
    database_url = os.getenv("DATABASE_URL", "").strip()
    telegram_bot_token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    telegram_chat_id = os.getenv("TELEGRAM_CHAT_ID", "").strip()
    if not database_url:
        print("DATABASE_URL is required", file=sys.stderr)
        raise SystemExit(2)
    if not telegram_bot_token:
        print("TELEGRAM_BOT_TOKEN is required", file=sys.stderr)
        raise SystemExit(2)
    if not telegram_chat_id:
        print("TELEGRAM_CHAT_ID is required", file=sys.stderr)
        raise SystemExit(2)
    return Config(
        database_url=database_url,
        telegram_bot_token=telegram_bot_token,
        telegram_chat_id=telegram_chat_id,
        telegram_disable_preview=env_bool("TELEGRAM_DISABLE_PREVIEW", True),
        batch_size=max(1, int(os.getenv("TELEGRAM_BATCH_SIZE", "10"))),
        idle_poll_seconds=max(1, int(os.getenv("TELEGRAM_IDLE_POLL_SECONDS", "30"))),
        lease_seconds=max(30, int(os.getenv("TELEGRAM_LEASE_SECONDS", "120"))),
        retry_base_seconds=max(1, int(os.getenv("TELEGRAM_RETRY_BASE_SECONDS", "15"))),
        retry_max_seconds=max(1, int(os.getenv("TELEGRAM_RETRY_MAX_SECONDS", "900"))),
        sent_retention_days=max(1, int(os.getenv("TELEGRAM_SENT_RETENTION_DAYS", "14"))),
        cleanup_interval_hours=max(
            1,
            int(os.getenv("TELEGRAM_CLEANUP_INTERVAL_HOURS", "24")),
        ),
        vine_url_template=(
            os.getenv("TELEGRAM_VINE_URL_TEMPLATE", DEFAULT_VINE_URL_TEMPLATE).strip()
            or DEFAULT_VINE_URL_TEMPLATE
        ),
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


@dataclass(slots=True)
class ClaimedNotification:
    id: int
    event_type: str
    source_event_key: str
    payload: dict[str, Any]
    attempts: int


@dataclass
class OutboxStore:
    database_url: str
    health_state: HealthState
    _work_conn: asyncpg.Connection | None = None
    _listen_conn: asyncpg.Connection | None = None
    _work_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    _wake_event: asyncio.Event = field(default_factory=asyncio.Event)

    async def _ensure_work_conn(self) -> asyncpg.Connection:
        if self._work_conn is not None and not self._work_conn.is_closed():
            return self._work_conn
        self._work_conn = await asyncpg.connect(self.database_url)
        self.health_state.db_connected = True
        log.info("Outbox work connection established")
        return self._work_conn

    async def _ensure_listen_conn(self) -> asyncpg.Connection:
        if self._listen_conn is not None and not self._listen_conn.is_closed():
            return self._listen_conn
        conn = await asyncpg.connect(self.database_url)
        await conn.add_listener(OUTBOX_NOTIFY_CHANNEL, self._handle_notify)
        await conn.execute(f"LISTEN {OUTBOX_NOTIFY_CHANNEL}")
        self._listen_conn = conn
        self.health_state.listener_connected = True
        log.info("Outbox listener connection established")
        return conn

    def _handle_notify(
        self,
        _connection: asyncpg.Connection,
        _pid: int,
        _channel: str,
        payload: str,
    ) -> None:
        if not payload or payload == TELEGRAM_OUTBOX_CHANNEL:
            self._wake_event.set()

    async def ensure_ready(self) -> None:
        await self._ensure_work_conn()
        await self._ensure_listen_conn()

    async def claim_batch(
        self,
        *,
        batch_size: int,
        lease_seconds: int,
        worker_id: str,
    ) -> list[ClaimedNotification]:
        conn = await self._ensure_work_conn()
        async with self._work_lock:
            rows = await conn.fetch(
                """
                WITH picked AS (
                    SELECT id
                    FROM notification_outbox
                    WHERE channel = $1
                      AND sent_at IS NULL
                      AND available_at <= now()
                      AND (lease_expires_at IS NULL OR lease_expires_at <= now())
                    ORDER BY available_at, id
                    LIMIT $2
                    FOR UPDATE SKIP LOCKED
                )
                UPDATE notification_outbox AS outbox
                SET
                    attempts = outbox.attempts + 1,
                    last_attempt_at = now(),
                    lease_expires_at = now() + make_interval(secs => $3),
                    worker_id = $4
                FROM picked
                WHERE outbox.id = picked.id
                RETURNING
                    outbox.id,
                    outbox.event_type,
                    outbox.source_event_key,
                    outbox.payload,
                    outbox.attempts
                """,
                TELEGRAM_OUTBOX_CHANNEL,
                batch_size,
                lease_seconds,
                worker_id,
            )
        claimed: list[ClaimedNotification] = []
        for row in rows:
            claimed.append(
                ClaimedNotification(
                    id=row["id"],
                    event_type=row["event_type"],
                    source_event_key=row["source_event_key"],
                    payload=normalize_outbox_payload(row["payload"]),
                    attempts=row["attempts"],
                )
            )
        return claimed

    async def mark_sent(self, notification_id: int, worker_id: str) -> None:
        conn = await self._ensure_work_conn()
        async with self._work_lock:
            await conn.execute(
                """
                UPDATE notification_outbox
                SET
                    sent_at = now(),
                    lease_expires_at = NULL,
                    worker_id = NULL,
                    last_error = NULL
                WHERE id = $1
                  AND worker_id = $2
                """,
                notification_id,
                worker_id,
            )

    async def mark_discarded(self, notification_id: int, worker_id: str, error: str) -> None:
        conn = await self._ensure_work_conn()
        async with self._work_lock:
            await conn.execute(
                """
                UPDATE notification_outbox
                SET
                    sent_at = now(),
                    lease_expires_at = NULL,
                    worker_id = NULL,
                    last_error = $3
                WHERE id = $1
                  AND worker_id = $2
                """,
                notification_id,
                worker_id,
                truncate_error(error),
            )

    async def release_for_retry(
        self,
        notification_id: int,
        worker_id: str,
        *,
        error: str,
        delay_seconds: int,
    ) -> None:
        conn = await self._ensure_work_conn()
        async with self._work_lock:
            await conn.execute(
                """
                UPDATE notification_outbox
                SET
                    available_at = now() + make_interval(secs => $3),
                    lease_expires_at = NULL,
                    worker_id = NULL,
                    last_error = $4
                WHERE id = $1
                  AND worker_id = $2
                """,
                notification_id,
                worker_id,
                delay_seconds,
                truncate_error(error),
            )

    async def cleanup_sent(self, retention_days: int) -> int:
        conn = await self._ensure_work_conn()
        async with self._work_lock:
            status = await conn.execute(
                """
                DELETE FROM notification_outbox
                WHERE sent_at IS NOT NULL
                  AND sent_at < now() - make_interval(days => $1)
                """,
                retention_days,
            )
        try:
            return int(status.split()[1])
        except (IndexError, ValueError):
            return 0

    async def wait_for_work(self, stop_event: asyncio.Event, timeout_seconds: int) -> None:
        self._wake_event.clear()
        wake_task = asyncio.create_task(self._wake_event.wait(), name="telegram_outbox_wait")
        stop_task = asyncio.create_task(stop_event.wait(), name="telegram_stop_wait")
        try:
            done, pending = await asyncio.wait(
                {wake_task, stop_task},
                timeout=timeout_seconds,
                return_when=asyncio.FIRST_COMPLETED,
            )
            for task in pending:
                task.cancel()
            for task in done:
                if task is wake_task:
                    self._wake_event.clear()
                else:
                    stop_event.set()
        finally:
            for task in (wake_task, stop_task):
                if not task.done():
                    task.cancel()
            await asyncio.gather(wake_task, stop_task, return_exceptions=True)

    async def close(self) -> None:
        for attr in ("_listen_conn", "_work_conn"):
            conn = getattr(self, attr)
            if conn is None:
                continue
            try:
                if attr == "_listen_conn" and not conn.is_closed():
                    await conn.remove_listener(OUTBOX_NOTIFY_CHANNEL, self._handle_notify)
            except Exception:  # noqa: BLE001
                pass
            try:
                await conn.close()
            except Exception:  # noqa: BLE001
                pass
            setattr(self, attr, None)
        self.health_state.db_connected = False
        self.health_state.listener_connected = False


class TelegramNotifier:
    def __init__(self, config: Config, store: OutboxStore) -> None:
        self.config = config
        self.store = store
        self.worker_id = f"{socket.gethostname()}:{os.getpid()}"

    async def run(self, stop_event: asyncio.Event) -> None:
        cleanup_task = asyncio.create_task(
            self._cleanup_loop(stop_event),
            name="telegram_outbox_cleanup",
        )
        try:
            while not stop_event.is_set():
                try:
                    await self.store.ensure_ready()
                    claimed = await self.store.claim_batch(
                        batch_size=self.config.batch_size,
                        lease_seconds=self.config.lease_seconds,
                        worker_id=self.worker_id,
                    )
                    if not claimed:
                        await self.store.wait_for_work(
                            stop_event,
                            self.config.idle_poll_seconds,
                        )
                        continue

                    for notification in claimed:
                        if stop_event.is_set():
                            return
                        await self._process(notification)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:  # noqa: BLE001
                    log.warning("Notifier loop error: %s: %s", type(exc).__name__, exc)
                    await self.store.close()
                    await asyncio.sleep(min(self.config.retry_base_seconds, 5))
        finally:
            cleanup_task.cancel()
            await asyncio.gather(cleanup_task, return_exceptions=True)

    async def _process(self, notification: ClaimedNotification) -> None:
        try:
            title, message = self._render_message(notification)
        except ValueError as exc:
            log.warning(
                "Discarding unsupported notification id=%s event_type=%s: %s",
                notification.id,
                notification.event_type,
                exc,
            )
            await self.store.mark_discarded(
                notification.id,
                self.worker_id,
                str(exc),
            )
            return

        try:
            await asyncio.to_thread(
                send_telegram_message,
                self.config.telegram_bot_token,
                self.config.telegram_chat_id,
                title,
                message,
                self.config.telegram_disable_preview,
            )
        except RetryableSendError as exc:
            delay_seconds = exc.retry_after_seconds or backoff_seconds(
                notification.attempts,
                self.config.retry_base_seconds,
                self.config.retry_max_seconds,
            )
            log.warning(
                "Telegram send failed id=%s event_type=%s attempts=%s retry_in=%ss error=%s",
                notification.id,
                notification.event_type,
                notification.attempts,
                delay_seconds,
                exc,
            )
            await self.store.release_for_retry(
                notification.id,
                self.worker_id,
                error=str(exc),
                delay_seconds=delay_seconds,
            )
            return

        await self.store.mark_sent(notification.id, self.worker_id)
        log.info(
            "Telegram message sent id=%s event_type=%s source_event_key=%s",
            notification.id,
            notification.event_type,
            notification.source_event_key,
        )

    def _render_message(self, notification: ClaimedNotification) -> tuple[str, str]:
        if notification.event_type == "item_added":
            item = notification.payload.get("item")
            if not isinstance(item, dict):
                raise ValueError("item_added payload is missing item object")
            return format_item_added_message(item, self.config.vine_url_template)

        if notification.event_type == "collector_status":
            return format_collector_status_message(notification.payload)

        raise ValueError(f"unsupported event_type {notification.event_type!r}")

    async def _cleanup_loop(self, stop_event: asyncio.Event) -> None:
        interval_seconds = self.config.cleanup_interval_hours * 3600
        while not stop_event.is_set():
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=interval_seconds)
                return
            except asyncio.TimeoutError:
                pass
            try:
                rows = await self.store.cleanup_sent(self.config.sent_retention_days)
                log.info("Notification outbox cleanup removed %d rows", rows)
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001
                log.warning("Notification outbox cleanup failed: %s: %s", type(exc).__name__, exc)
                await self.store.close()


async def amain() -> int:
    config = load_config()
    health_state = HealthState(service="notifier")
    store = OutboxStore(config.database_url, health_state=health_state)
    notifier = TelegramNotifier(config, store)
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

    notifier_health_task = asyncio.create_task(
        healthcheck_task(
            path=config.healthcheck_file,
            interval_seconds=config.healthcheck_interval_seconds,
            state=health_state,
            stop_event=stop_event,
        ),
        name="notifier_healthcheck",
    )

    try:
        await notifier.run(stop_event)
    finally:
        stop_event.set()
        notifier_health_task.cancel()
        try:
            await notifier_health_task
        except (asyncio.CancelledError, Exception):  # noqa: BLE001
            pass
        await store.close()
    return 0


def main() -> int:
    try:
        return asyncio.run(amain())
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
