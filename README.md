# Vine Stats IT

Multi-service stack that collects Vine IT Socket.IO events, persists them in TimescaleDB, and exposes a Next.js dashboard with live SSE updates.

## Architecture

| Service | Description |
|---------|-------------|
| `db` | TimescaleDB (PostgreSQL 16) — stores raw events |
| `writer` | Python collector (`socket_probe_v2.py`) — reads Socket.IO feed, dedupes, writes to DB, and enqueues durable notifications |
| `notifier` | Python worker (`telegram_notifier.py`) — drains the outbox table and sends Telegram messages with retries |
| `web` | Next.js frontend with live SSE stream |
| `caddy` | Reverse proxy with automatic HTTPS (Let's Encrypt) |

## Quick start (development)

```bash
# From the infra/ directory
cd infra

# Copy and fill in env vars
cp .env.example .env   # or create .env manually (see below)

# Build images locally and start the base stack
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

The web app will be available at `http://localhost:3000` (dev override exposes port 3000 directly).

The Telegram notifier is now opt-in. Enable it only when you have valid Telegram credentials:

```bash
docker compose \
  -f docker-compose.yml \
  -f docker-compose.dev.yml \
  --profile notifier \
  up --build
```

## Frontend locale con dati del deploy online

Se vuoi lanciare solo il frontend Next in locale ma leggere i dati dal deploy pubblico, non serve esporre il Postgres remoto. Il deploy su `https://ita-vine-stats.duckdns.org` espone gia' le API necessarie (`/api/health`, `/api/live/snapshot`, `/api/chart`, `/api/live`), quindi il frontend locale puo' usarle come upstream.

```bash
cd web
cp .env.local.example .env.local
npm install
npm run dev
```

In `web/.env.local` lascia:

```env
REMOTE_DASHBOARD_URL=https://ita-vine-stats.duckdns.org
```

Con questo env:

- la pagina iniziale server-side usa i dati del deploy remoto
- le route locali `/api/*` fanno da proxy verso il deploy remoto
- lo stream live `/api/live` continua a funzionare in locale senza accesso diretto al DB

Se invece vuoi davvero collegarti al Postgres remoto dal tuo Next locale, l'URL HTTPS del sito non basta: serve un `DATABASE_URL=postgres://...` raggiungibile dalla tua macchina, ad esempio via porta pubblica o tunnel SSH.

## Mock socket for e2e

When the real upstream Socket.IO feed is unavailable, you can run the stack against a local Node.js mock socket instead:

```bash
cd infra

docker compose \
  -f docker-compose.yml \
  -f docker-compose.dev.yml \
  -f docker-compose.mock-socket.yml \
  up --build
```

This adds a `mock-socket` service on `http://localhost:3101` and rewires the `writer` container to:

```text
ws://mock-socket:3101/socket.io/?EIO=4&transport=websocket&countryCode=it
```

By default the mock socket loops through a small deterministic scenario from `mock-socket/scenarios/default.json`. For fully controlled tests you can disable autoplay and inject events yourself:

```bash
curl -X POST http://localhost:3101/emit \
  -H 'Content-Type: application/json' \
  -d '{
    "event": "newItem",
    "item": {
      "asin": "MOCK-ASIN-999",
      "queue": "AFA",
      "title": "Manual e2e item",
      "item_value": 9.99,
      "currency": "EUR"
    }
  }'
```

Useful mock-socket env vars:

```env
MOCK_SOCKET_AUTOPLAY=false
MOCK_SOCKET_LOOP=false
MOCK_SOCKET_SCENARIO_FILE=/app/scenarios/reconnect.json
MOCK_SOCKET_PORT=3101
```

## Environment variables

Create `infra/.env`:

```env
# Database
DB_PASSWORD=changeme
DB_USER=postgres
DB_NAME=vinestats
DATABASE_URL=postgres://postgres:changeme@db/vinestats

# Socket.IO feed (optional — defaults to v-helper.com IT endpoint)
SOCKET_URL=wss://api.v-helper.com/socket.io/?...

# Caddy domain (production only)
WEB_DOMAIN=vine-stats.example.it

# Writer tuning (all optional)
LOG_LEVEL=INFO
HEARTBEAT_TIMEOUT_SECONDS=45
RECONNECT_DELAY_SECONDS=5
UNKNOWN_EVENT_LOG_INTERVAL=60
DEDUPE_CLEANUP_INTERVAL_HOURS=24

# Telegram notifier (required only when the notifier profile is enabled)
TELEGRAM_BOT_TOKEN=123456:example
TELEGRAM_CHAT_ID=-1001234567890
TELEGRAM_DISABLE_PREVIEW=true
TELEGRAM_BATCH_SIZE=10
TELEGRAM_IDLE_POLL_SECONDS=30
TELEGRAM_LEASE_SECONDS=120
TELEGRAM_RETRY_BASE_SECONDS=15
TELEGRAM_RETRY_MAX_SECONDS=900
TELEGRAM_SENT_RETENTION_DAYS=14
TELEGRAM_CLEANUP_INTERVAL_HOURS=24
TELEGRAM_VINE_URL_TEMPLATE=https://www.amazon.it/dp/{asin}
```

## Production deploy

```bash
cd infra

# Pull prebuilt images (tagged by commit hash) and start
WRITER_IMAGE=ghcr.io/your-user/socket-monitor-writer:abc1234 \
NOTIFIER_IMAGE=ghcr.io/your-user/socket-monitor-notifier:abc1234 \
WEB_IMAGE=ghcr.io/your-user/socket-monitor-web:abc1234 \
docker compose up -d
```

If you also want Telegram delivery enabled:

```bash
COMPOSE_PROFILES=notifier docker compose up -d
```

The repository includes a GitHub Actions workflow that builds these images and pushes them to GHCR with the short commit SHA as the tag.

## Database migration for existing deployments

`db/init.sql` only runs on first database boot. Existing deployments must apply the outbox migration manually before starting the notifier:

```bash
psql "$DATABASE_URL" -f db/migrations/20260420_add_notification_outbox.sql
```

The notifier is intentionally durable: if Telegram is temporarily unavailable, rows stay in `notification_outbox` and are retried with backoff after the service recovers.

## Useful commands

```bash
# View logs for a specific service
docker compose -f docker-compose.yml -f docker-compose.dev.yml logs -f writer
docker compose -f docker-compose.yml -f docker-compose.dev.yml logs -f notifier

# Restart a single service
docker compose restart web

# Stop everything
docker compose down

# Stop and wipe the database volume
docker compose down -v
```

## Standalone socket probe (legacy)

`socket_probe.py` in the repo root is the original single-file monitor that sends Telegram notifications. It is independent of the stack above.

```bash
pip install -r requirements.txt
python socket_probe.py --probe-once
python socket_probe.py
```

Required env vars: `SOCKET_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
