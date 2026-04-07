#!/usr/bin/env python3
"""Socket.IO monitor for Vine-style newItem events.

This script connects directly to a Socket.IO endpoint over the WebSocket
transport, performs the Engine.IO and Socket.IO handshakes, keeps the
connection alive, and sends Telegram notifications for `newItem` events.

Primary use cases:
  - local debugging:
      python3 socket_probe.py --probe-once
  - long-running monitor:
      python3 socket_probe.py
  - Railway/container deployment:
      SOCKET_URL=... TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... python3 socket_probe.py
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
import time
from collections import deque
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote, urlsplit, urlunsplit
from urllib.request import Request, urlopen

try:
    import websockets
    from websockets.exceptions import ConnectionClosed
except ImportError:
    print(
        "Missing dependency: websockets\n"
        "Install it with: pip install -r requirements.txt",
        file=sys.stderr,
    )
    raise SystemExit(1)


DEFAULT_URL = (
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
DEFAULT_VINE_URL_TEMPLATE = "https://www.amazon.it/dp/{asin}"


@dataclass(slots=True)
class MonitorConfig:
    socket_url: str
    telegram_bot_token: str
    telegram_chat_id: str
    telegram_disable_preview: bool
    queue_filter: set[str]
    notify_dedupe_seconds: int
    reconnect_delay_seconds: int
    heartbeat_timeout_seconds: float
    max_messages: int
    probe_once: bool
    vine_url_template: str
    status_dedupe_seconds: int


class RecentEventCache:
    """Small TTL cache for deduping repeated events after reconnects."""

    def __init__(self, ttl_seconds: int) -> None:
        self.ttl_seconds = ttl_seconds
        self.events: dict[str, float] = {}
        self.order: deque[tuple[str, float]] = deque()

    def seen_recently(self, key: str) -> bool:
        now = time.time()
        self._prune(now)
        return key in self.events

    def add(self, key: str) -> None:
        now = time.time()
        self._prune(now)
        self.events[key] = now
        self.order.append((key, now))

    def _prune(self, now: float) -> None:
        cutoff = now - self.ttl_seconds
        while self.order and self.order[0][1] < cutoff:
            key, ts = self.order.popleft()
            if self.events.get(key) == ts:
                del self.events[key]


def sanitize_url(raw_url: str) -> str:
    cleaned = raw_url.strip()
    parts = urlsplit(cleaned)
    return urlunsplit(parts)


def env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def parse_queue_filter(raw_value: str) -> set[str]:
    if not raw_value.strip():
        return set()
    return {part.strip() for part in raw_value.split(",") if part.strip()}


def build_vine_url(asin: str, template: str) -> str:
    return template.format(asin=quote(asin, safe=""))


def format_new_item_message(item: dict[str, Any], vine_url_template: str) -> tuple[str, str]:
    asin = str(item.get("asin") or "unknown")
    title = str(item.get("title") or asin)
    queue = str(item.get("queue") or "unknown")
    reason = str(item.get("reason") or "new item")
    tier = str(item.get("tier") or "unknown")
    added_at = str(item.get("date_added") or item.get("date") or "")
    image_url = str(item.get("img_url") or "")
    vine_url = build_vine_url(asin, vine_url_template)

    body_lines = [
        title,
        "",
        f"ASIN: {asin}",
        f"Queue: {queue}",
        f"Reason: {reason}",
        f"Tier: {tier}",
    ]

    if added_at:
        body_lines.append(f"Added: {added_at}")
    if image_url:
        body_lines.append(f"Image: {image_url}")
    body_lines.append(f"Open Product: {vine_url}")

    title_text = f"New Vine Item [{queue}]"
    return title_text, "\n".join(body_lines)


def send_telegram_message(
    bot_token: str,
    chat_id: str,
    title: str,
    message: str,
    disable_preview: bool,
) -> None:
    text = f"🟠 {title}\n\n{message}"
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

    with urlopen(request, timeout=20) as response:  # noqa: S310
        data = json.loads(response.read().decode("utf-8"))
        if not data.get("ok"):
            raise RuntimeError(f"Telegram API returned error payload: {data}")


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


class SocketMonitor:
    def __init__(self, config: MonitorConfig) -> None:
        self.config = config
        self.recent_events = RecentEventCache(config.notify_dedupe_seconds)
        self.recent_statuses = RecentEventCache(config.status_dedupe_seconds)

    async def run(self) -> int:
        if self.config.probe_once:
            return await self._connect_once()

        while True:
            try:
                code = await self._connect_once()
                if code == 0:
                    print("Connection ended cleanly, reconnecting...")
                    await self._notify_status(
                        "Socket reconnecting",
                        f"Connection ended cleanly. Reconnecting in {self.config.reconnect_delay_seconds}s.",
                        status_key="reconnecting:clean",
                    )
                else:
                    print(f"Connection ended with code {code}, reconnecting...")
                    await self._notify_status(
                        "Socket reconnecting",
                        (
                            f"Connection ended with code `{code}`. "
                            f"Reconnecting in {self.config.reconnect_delay_seconds}s."
                        ),
                        status_key=f"reconnecting:{code}",
                    )
            except KeyboardInterrupt:
                print("Interrupted, exiting.")
                return 130
            except Exception as exc:  # noqa: BLE001
                print(f"Monitor loop error: {type(exc).__name__}: {exc}", file=sys.stderr)
                await self._notify_status(
                    "Socket error",
                    f"Monitor loop raised {type(exc).__name__}: {exc}",
                    status_key=f"loop-error:{type(exc).__name__}:{exc}",
                )

            await asyncio.sleep(self.config.reconnect_delay_seconds)

    async def _connect_once(self) -> int:
        print(f"Connecting to: {self.config.socket_url}")
        namespace_connected = False
        messages_seen = 0

        try:
            async with websockets.connect(
                self.config.socket_url,
                open_timeout=self.config.heartbeat_timeout_seconds,
                close_timeout=5,
                ping_interval=None,
                max_size=None,
            ) as ws:
                print("CONNECTED transport=websocket")

                while True:
                    if self.config.max_messages > 0 and messages_seen >= self.config.max_messages:
                        if namespace_connected:
                            print("Reached configured message limit, exiting connection.")
                            return 0
                        print("Reached message limit before namespace connection.")
                        return 4

                    try:
                        frame = await asyncio.wait_for(
                            ws.recv(),
                            timeout=self.config.heartbeat_timeout_seconds,
                        )
                    except asyncio.TimeoutError:
                        print(
                            f"TIMEOUT after {self.config.heartbeat_timeout_seconds:.1f}s "
                            "waiting for server frame"
                        )
                        await self._notify_status(
                            "Socket error",
                            (
                                "Timed out waiting for a server frame after "
                                f"{self.config.heartbeat_timeout_seconds:.1f} seconds."
                            ),
                            status_key="timeout",
                        )
                        return 2

                    messages_seen += 1
                    print(f"RECV[{messages_seen}]: {frame}")

                    if frame == "2":
                        await ws.send("3")
                        print("SEND: 3  # Engine.IO pong")
                        continue

                    if isinstance(frame, str) and frame.startswith("0"):
                        await ws.send("40")
                        print("SEND: 40  # Socket.IO connect namespace")
                        continue

                    if frame == "40" or (isinstance(frame, str) and frame.startswith("40{")):
                        namespace_connected = True
                        print("INFO: namespace connected")
                        await self._notify_status(
                            "Socket connected",
                            "Socket transport and namespace handshake completed successfully.",
                            status_key="connected",
                        )
                        if self.config.probe_once and self.config.max_messages <= 0:
                            return 0
                        continue

                    parsed = try_parse_event_frame(frame) if isinstance(frame, str) else None
                    if not parsed:
                        continue

                    event_name, event_payload = parsed
                    print(f"EVENT: {event_name}")
                    if event_payload is not None:
                        print(
                            json.dumps(
                                event_payload,
                                indent=2,
                                ensure_ascii=False,
                                sort_keys=True,
                            )
                        )

                    if event_name == "connection_error":
                        print("RESULT: server rejected session parameters")
                        await self._notify_status(
                            "Socket error",
                            "Server returned connection_error: "
                            f"{json.dumps(event_payload, ensure_ascii=False, sort_keys=True)}",
                            status_key=f"connection_error:{json.dumps(event_payload, sort_keys=True)}",
                        )
                        return 3

                    if event_name == "newItem":
                        await self._handle_new_item(event_payload)
                        if self.config.probe_once:
                            return 0

        except ConnectionClosed as exc:
            print(f"CLOSED code={exc.code} reason={exc.reason!r}")
            await self._notify_status(
                "Socket disconnected",
                (
                    f"WebSocket closed with code {exc.code}"
                    + (
                        f" and reason {exc.reason}."
                        if exc.reason
                        else "."
                    )
                ),
                status_key=f"closed:{exc.code}:{exc.reason}",
            )
            return 5
        except KeyboardInterrupt:
            raise
        except Exception as exc:  # noqa: BLE001
            print(f"ERROR: {type(exc).__name__}: {exc}")
            await self._notify_status(
                "Socket error",
                f"Unhandled exception {type(exc).__name__}: {exc}",
                status_key=f"error:{type(exc).__name__}:{exc}",
            )
            return 1

    async def _handle_new_item(self, payload: Any) -> None:
        item = payload.get("item") if isinstance(payload, dict) else None
        if not isinstance(item, dict):
            print("Ignoring malformed newItem payload")
            return

        asin = str(item.get("asin") or "").strip()
        queue = str(item.get("queue") or "").strip()
        if not asin:
            print("Ignoring newItem without ASIN")
            return

        if self.config.queue_filter and queue not in self.config.queue_filter:
            print(f"Ignoring ASIN {asin}: queue {queue!r} not in filter")
            return

        dedupe_key = f"{queue}:{asin}"
        if self.recent_events.seen_recently(dedupe_key):
            print(f"Skipping duplicate notification for {dedupe_key}")
            return

        title, message = format_new_item_message(item, self.config.vine_url_template)
        print(f"NEW ITEM {asin}: {item.get('title')}")

        if self.config.telegram_bot_token and self.config.telegram_chat_id:
            await asyncio.to_thread(
                send_telegram_message,
                self.config.telegram_bot_token,
                self.config.telegram_chat_id,
                title,
                message,
                self.config.telegram_disable_preview,
            )
            print(f"Telegram notification sent for {asin}")
        else:
            print("Telegram credentials not configured; printing event only.")

        self.recent_events.add(dedupe_key)

    async def _notify_status(self, title: str, message: str, status_key: str) -> None:
        if not self.config.telegram_bot_token or not self.config.telegram_chat_id:
            return

        if self.recent_statuses.seen_recently(status_key):
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
            self.recent_statuses.add(status_key)
        except Exception as exc:  # noqa: BLE001
            print(f"Failed to send status notification: {type(exc).__name__}: {exc}", file=sys.stderr)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Monitor a Socket.IO WebSocket endpoint")
    parser.add_argument(
        "--url",
        default=os.getenv("SOCKET_URL", DEFAULT_URL),
        help="Full wss:// Socket.IO URL to connect to",
    )
    parser.add_argument(
        "--telegram-bot-token",
        default=os.getenv("TELEGRAM_BOT_TOKEN", ""),
        help="Telegram bot token for notifications",
    )
    parser.add_argument(
        "--telegram-chat-id",
        default=os.getenv("TELEGRAM_CHAT_ID", ""),
        help="Telegram chat/channel ID for notifications",
    )
    parser.add_argument(
        "--disable-preview",
        action="store_true",
        default=env_bool("TELEGRAM_DISABLE_PREVIEW", False),
        help="Disable Telegram link previews",
    )
    parser.add_argument(
        "--queue-filter",
        default=os.getenv("QUEUE_FILTER", ""),
        help="Comma-separated queue whitelist, e.g. encore,potluck",
    )
    parser.add_argument(
        "--notify-dedupe-seconds",
        type=int,
        default=int(os.getenv("NOTIFY_DEDUPE_SECONDS", "900")),
        help="Suppress duplicate ASIN notifications for this many seconds",
    )
    parser.add_argument(
        "--reconnect-delay",
        type=int,
        default=int(os.getenv("RECONNECT_DELAY_SECONDS", "5")),
        help="Seconds to wait before reconnecting after disconnect/error",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=float(os.getenv("HEARTBEAT_TIMEOUT_SECONDS", "45")),
        help="Seconds to wait for open and per-frame receive timeouts",
    )
    parser.add_argument(
        "--max-messages",
        type=int,
        default=int(os.getenv("MAX_MESSAGES", "0")),
        help="Optional message limit; 0 means run indefinitely",
    )
    parser.add_argument(
        "--probe-once",
        action="store_true",
        help="Connect once and exit instead of reconnecting forever",
    )
    parser.add_argument(
        "--vine-url-template",
        default=os.getenv("VINE_URL_TEMPLATE", DEFAULT_VINE_URL_TEMPLATE),
        help="Product URL template, use {asin} as placeholder",
    )
    parser.add_argument(
        "--status-dedupe-seconds",
        type=int,
        default=int(os.getenv("STATUS_DEDUPE_SECONDS", "60")),
        help="Suppress duplicate status notifications for this many seconds",
    )
    return parser.parse_args()


def build_config(args: argparse.Namespace) -> MonitorConfig:
    return MonitorConfig(
        socket_url=sanitize_url(args.url),
        telegram_bot_token=args.telegram_bot_token.strip(),
        telegram_chat_id=args.telegram_chat_id.strip(),
        telegram_disable_preview=bool(args.disable_preview),
        queue_filter=parse_queue_filter(args.queue_filter),
        notify_dedupe_seconds=max(1, int(args.notify_dedupe_seconds)),
        reconnect_delay_seconds=max(1, int(args.reconnect_delay)),
        heartbeat_timeout_seconds=max(5.0, float(args.timeout)),
        max_messages=max(0, int(args.max_messages)),
        probe_once=bool(args.probe_once),
        vine_url_template=args.vine_url_template.strip() or DEFAULT_VINE_URL_TEMPLATE,
        status_dedupe_seconds=max(1, int(args.status_dedupe_seconds)),
    )


def validate_config(config: MonitorConfig) -> None:
    if not config.socket_url:
        raise ValueError("Socket URL is required")

    if config.probe_once:
        return

    missing = []
    if not config.telegram_bot_token:
        missing.append("TELEGRAM_BOT_TOKEN")
    if not config.telegram_chat_id:
        missing.append("TELEGRAM_CHAT_ID")

    if missing:
        raise ValueError(
            "Missing required Telegram configuration for monitor mode: "
            + ", ".join(missing)
        )


def main() -> int:
    args = parse_args()
    config = build_config(args)

    try:
        validate_config(config)
    except ValueError as exc:
        print(f"Configuration error: {exc}", file=sys.stderr)
        return 2

    monitor = SocketMonitor(config)
    return asyncio.run(monitor.run())


if __name__ == "__main__":
    raise SystemExit(main())
