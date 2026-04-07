# Socket Monitor

Standalone Socket.IO monitor that listens for `newItem` events and sends them to Telegram.

## Required environment variables

- `SOCKET_URL`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

## Optional environment variables

- `QUEUE_FILTER`
- `NOTIFY_DEDUPE_SECONDS`
- `RECONNECT_DELAY_SECONDS`
- `HEARTBEAT_TIMEOUT_SECONDS`
- `STATUS_DEDUPE_SECONDS`
- `TELEGRAM_DISABLE_PREVIEW`
- `VINE_URL_TEMPLATE`

## Local run

```bash
pip install -r requirements.txt
python socket_probe.py --probe-once
python socket_probe.py
```

## Docker

```bash
docker build -t vine-socket-monitor .
docker run --rm \
  -e SOCKET_URL='wss://api.v-helper.com/socket.io/?...' \
  -e TELEGRAM_BOT_TOKEN='123456:abc' \
  -e TELEGRAM_CHAT_ID='-1001234567890' \
  vine-socket-monitor
```

## Railway

Point Railway at this folder as the project root, or import this folder into a dedicated repo.
