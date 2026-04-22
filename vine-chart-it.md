## Vine Stats IT — Project Brief

**Obiettivo:** Sito di monitoraggio e analytics best-effort per Amazon Vine Italia, ispirato a vinechart.com ma con focus su dati live, trend storici e recap semplici.

**Posizionamento corretto:** non è una dashboard mission critical e non usa snapshot ufficiali della pagina Amazon. I numeri storici sono stime derivate dagli eventi live catturati dal collector.

**Utenza attesa:** ~5000 utenti max, con poche centinaia di utenti concorrenti nei momenti migliori.

---

### Vincoli reali

- Il feed socket fornisce eventi live di aggiunta e rimozione/claim item.
- Non è disponibile uno snapshot affidabile dello stato corrente senza polling della pagina Amazon.
- Di conseguenza il sistema non può garantire un totale assoluto perfetto dopo restart o gap di connessione.
- Il sistema deve esplicitare quando i dati sono parziali o potenzialmente incompleti.

---

### Stack

- **VM:** Hetzner CX22
- **Reverse proxy:** Caddy
- **Database:** PostgreSQL + TimescaleDB
- **Backend + Frontend:** Next.js
- **Collector/Writer:** Python (processo esistente che legge il socket Vine IT)
- **Deploy:** Docker Compose, tutto sulla stessa VM

---

### Architettura

```text
Socket Amazon Vine IT
        │
        ▼
[ Writer Python ]
  - connessione socket
  - parsing eventi
  - dedupe applicativo
  - batch insert raw events
  - registra gap / reconnect / restart
  - NOTIFY vine_events dopo ogni commit
        │
        ▼
[ PostgreSQL + TimescaleDB ]
  - raw events append-only (retention 7gg)
  - aggregati orari (retention lunga)
  - health/gap events
        │
        ├── LISTEN vine_events ──┐
        ▼                        │
[ Next.js ]                      │
  ├── API Routes → query Postgres│
  └── SSE route ◄────────────────┘
       broadcast live updates ai client
        │
        ▼
[ React FE ]
  ├── live chart / live counters
  ├── fetch per storico
  └── indicatori qualità dati
```

---

### Principi di prodotto

- Il numero hero è `added_7d`: quanti item sono passati negli ultimi 7 giorni rolling. È sempre positivo, non dipende dal saldo, ed è auto-correttivo: ogni errore di conteggio esce dalla finestra entro una settimana.
- Non esiste un "totale assoluto da sempre". Il sistema non lo può misurare onestamente e non lo espone.
- I raw events hanno retention 7 giorni. Oltre quella soglia restano solo gli aggregati orari (vedi sezione retention).
- I dati storici sono attendibili solo nei periodi senza gap noti.
- Ogni disconnessione, timeout, restart del writer o errore critico produce un marker di gap nel DB.
- L'interfaccia deve mostrare chiaramente quando una finestra temporale include dati parziali, incluso il numero hero se la finestra rolling 7gg interseca un gap.

**Disclaimer UI suggerito:**

> I dati sono raccolti passivamente dagli eventi live di Vine. Totali storici e statistiche drop sono stime best-effort e possono essere incompleti durante interruzioni di connessione o restart del servizio.

---

### Writer Python

Il writer esistente va evoluto da notifier Telegram a collector persistente.

Responsabilità:

- leggere gli eventi `item_added` e `item_removed` / `item_claimed`
- estrarre i campi disponibili: `asin`, titolo, value details, queue, timestamp sorgente, eventuali altri metadati
- generare una chiave di dedupe stabile per evitare duplicati dopo reconnect
- scrivere eventi raw nel DB con `ON CONFLICT DO NOTHING`
- registrare eventi di health:
  - `connected`
  - `disconnected`
  - `timeout`
  - `restart`
  - `gap_opened`
  - `gap_closed`

Nota: la dedupe in-memory da sola non basta. La dedupe definitiva deve stare nel database.

---

### Data Model

Il modello deve essere event-sourced, non snapshot-based.

#### 1. Raw item events

```sql
CREATE TABLE vine_item_events (
  id                  BIGSERIAL PRIMARY KEY,
  event_time          TIMESTAMPTZ NOT NULL,
  ingest_time         TIMESTAMPTZ NOT NULL DEFAULT now(),
  marketplace         TEXT NOT NULL DEFAULT 'IT',
  event_type          TEXT NOT NULL, -- item_added / item_removed
  asin                TEXT NOT NULL,
  queue               TEXT,
  title               TEXT,
  item_value          NUMERIC(10,2),
  currency            TEXT,
  source_event_key    TEXT NOT NULL,
  raw_payload         JSONB NOT NULL
);

CREATE UNIQUE INDEX vine_item_events_source_event_key_idx
  ON vine_item_events (source_event_key);

SELECT create_hypertable('vine_item_events', 'event_time');
```

#### 2. Collector health and gap tracking

```sql
CREATE TABLE collector_events (
  id            BIGSERIAL PRIMARY KEY,
  time          TIMESTAMPTZ NOT NULL,
  event_type    TEXT NOT NULL, -- connected / disconnected / timeout / restart / gap_opened / gap_closed
  details       JSONB
);

SELECT create_hypertable('collector_events', 'time');
```

#### 3. Retention policy

I raw events vivono 7 giorni, poi vengono eliminati dai chunk Timescale. Gli aggregati orari (vedi sezione successiva) sopravvivono indefinitamente e coprono tutto lo storico per heatmap, drop history e trend.

```sql
SELECT add_retention_policy('vine_item_events', INTERVAL '7 days');
```

#### 4. Dedupe e unique constraint su hypertable

Timescale richiede che ogni unique index su hypertable includa la colonna di partizionamento. Quindi `UNIQUE(source_event_key)` puro **non funziona**. Soluzione adottata: tabella separata di dedupe non-hypertable, con TTL allineato alla retention.

```sql
CREATE TABLE vine_event_dedupe (
  source_event_key TEXT PRIMARY KEY,
  first_seen       TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Il writer fa prima `INSERT ... ON CONFLICT DO NOTHING` su `vine_event_dedupe`; se l'insert ha avuto effetto, allora scrive l'evento in `vine_item_events`. Un job giornaliero pulisce le righe più vecchie di 8 giorni (margine sopra la retention raw).

`source_event_key` va definita esplicitamente nel writer prima di scrivere codice. Proposta: combinazione di `event_type + asin + source_timestamp` se la sorgente espone un timestamp stabile per evento, altrimenti hash del payload raw normalizzato. Da confermare ispezionando un campione di eventi reali.

---

### Derivazioni analytics

Le metriche vanno calcolate da eventi raw (finestra 7gg) e da aggregati orari (storico lungo) + gap markers.

- **`added_7d` (hero):** count `item_added` negli ultimi 7 giorni rolling. Calcolato dai raw, sempre disponibile, sempre positivo.
- **`net_7d` (secondario):** `added_7d − removed_7d`, mostrato come info aggiuntiva ma non come hero.
- **Live activity:** numero aggiunte/rimozioni negli ultimi N minuti, dai raw.
- **Heatmap:** volume eventi per ora del giorno × giorno settimana, calcolato dagli aggregati orari (copre tutto lo storico).
- **Drop stats:** finestre di attività con definizione esplicita.
- **Value trends:** media / somma / distribuzione del valore item, solo se il campo è disponibile.

#### Calcolo `data_quality` per una finestra

Una finestra temporale `[from, to]` è marcata `partial` se almeno una di queste condizioni è vera:
- esiste un `gap_opened` o `gap_closed` in `collector_events` che interseca la finestra
- la copertura `connected` è inferiore al 95% della durata della finestra
- per il numero hero `added_7d`: si applica la stessa regola sulla finestra rolling 7gg che precede `now()`

Questa regola va implementata una sola volta come funzione SQL o helper applicativo, non duplicata in ogni endpoint.

Definizione pratica di `drop` per v1:

- un drop è una finestra continua di attività
- la finestra si apre con il primo `item_added`
- resta aperta finché continuano ad arrivare eventi
- si chiude dopo N minuti di inattività

Questo non è un concetto assoluto di Amazon, ma una definizione applicativa coerente.

---

### Continuous aggregates / query layer

Due livelli di aggregazione, allineati alla retention dei raw:

**Bucket 5 minuti** — vita breve, usato per i grafici live e history degli ultimi giorni. Retention allineata ai raw (7gg) o leggermente superiore.

```sql
CREATE MATERIALIZED VIEW vine_events_5m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('5 minutes', event_time) AS bucket,
  count(*) FILTER (WHERE event_type = 'item_added')   AS added_count,
  count(*) FILTER (WHERE event_type = 'item_removed') AS removed_count,
  avg(item_value) FILTER (WHERE item_value IS NOT NULL) AS avg_item_value
FROM vine_item_events
GROUP BY bucket;
```

**Bucket 1 ora** — vita lunga, sopravvive al drop dei raw. È la base di tutti gli analytics storici (heatmap, trend, drop history) oltre i 7 giorni. Nessuna retention policy.

```sql
CREATE MATERIALIZED VIEW vine_events_1h
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', event_time) AS bucket,
  count(*) FILTER (WHERE event_type = 'item_added')   AS added_count,
  count(*) FILTER (WHERE event_type = 'item_removed') AS removed_count,
  avg(item_value) FILTER (WHERE item_value IS NOT NULL) AS avg_item_value,
  sum(item_value) FILTER (WHERE item_value IS NOT NULL) AS sum_item_value
FROM vine_item_events
GROUP BY bucket;
```

**Refresh policy:** entrambi i CAGG devono avere una finestra di refresh che guarda *indietro* di almeno qualche ora, per assorbire eventi tardivi che arrivano dopo un reconnect. Esempio:

```sql
SELECT add_continuous_aggregate_policy('vine_events_1h',
  start_offset => INTERVAL '6 hours',
  end_offset   => INTERVAL '5 minutes',
  schedule_interval => INTERVAL '5 minutes');
```

**Importante:** il CAGG 1h deve essere materializzato *prima* che il chunk raw sottostante venga eliminato dalla retention policy. La schedule deve essere comodamente più frequente del lag massimo accettabile e ben dentro i 7 giorni di vita dei raw.

**Timezone:** la sorgente resta in UTC nel DB, ma tutte le aggregazioni lato prodotto devono essere interpretate in `Europe/Rome`. Heatmap e confronti temporali devono rispettare CET/CEST. I bucket UTC vanno riproiettati in locale al momento del query, non al momento dell'aggregazione, per evitare buchi al cambio ora legale.

---

### API Routes Next.js

```text
GET /api/live
  SSE con broadcast live dal processo web

GET /api/live/snapshot
  stato corrente di hero counter e contatori live, usato dai client al reconnect SSE

GET /api/history
  ?from=&to=&interval=5m
  ritorna bucket storici, estimated_total, added_count, removed_count, data_quality

GET /api/stats/heatmap
  aggregato per ora locale / giorno settimana

GET /api/stats/drops
  lista drop stimati con start, end, durata, added_count, removed_count, data_quality

GET /api/stats/value
  recap valore medio / distribuzione se item_value disponibile

GET /api/health
  stato collector, ultimo evento ricevuto, ultimo gap, data quality recente
```

---

### SSE strategy

SSE resta una scelta corretta per questo progetto.

- attesi pochi centinaia di client concorrenti, non migliaia simultanei
- il processo web deve fare fanout di un piccolo payload live condiviso
- evitare query Postgres per ogni connessione SSE
- usare heartbeat SSE e cleanup corretto delle connessioni

**Sorgente eventi live:** una sola connessione `LISTEN vine_events` aperta dal processo Next.js verso Postgres. Ogni `NOTIFY` del writer alimenta un dispatcher in-memory che fa fanout a tutti i client SSE connessi. Niente Redis, niente broker, niente polling. Payload `NOTIFY` minimale (`{type, asin, time}`, max ~7KB di safety per il limite Postgres).

**Reconnect lato client:** ogni deploy del container web droppa tutte le connessioni SSE. Il client deve avere reconnect con exponential backoff e, al reconnect, fare una `GET /api/live/snapshot` per riallinearsi sui contatori correnti senza perdere coerenza visiva. Senza questa pulizia il numero hero può "saltare" all'occhio dell'utente dopo ogni deploy.

**Modalità Next.js:** il processo va deployato come server long-running standalone, non come funzioni serverless. SSE e `LISTEN` richiedono uno stato condiviso in-process che il modello serverless non supporta.

---

### Feature FE v1

1. **Hero counter** `added_7d` con badge `partial` se la finestra rolling include un gap, e `net_7d` come metrica secondaria
2. **Live chart** con attività live (added/removed per minuto) alimentata da SSE
3. **History chart** con range temporale e badge `partial data` dove necessario
4. **Heatmap** eventi per ora × giorno della settimana in `Europe/Rome`, alimentata dal CAGG 1h
5. **Drop stats** con definizione semplice e disclaimer
6. **Value recap** se il valore item è disponibile
7. **Collector health panel** con stato connessione e ultimi gap

---

### Fuori scope per v1

- categorie nel tempo, se il feed non le espone
- confronti sofisticati week-over-week / month-over-month se prima non è chiaro il livello di qualità dati
- metriche che implicano accuratezza assoluta del catalogo
- polling o scraping della pagina Amazon per ricostruire snapshot

---

### Docker Compose

```yaml
services:
  db:
    image: timescale/timescaledb:latest-pg16
    restart: unless-stopped
    volumes:
      - pgdata:/var/lib/postgresql/data
    environment:
      POSTGRES_PASSWORD: ${DB_PASSWORD}

  writer:
    build: ./writer
    restart: unless-stopped
    depends_on:
      - db
    environment:
      DATABASE_URL: ${DATABASE_URL}

  web:
    build: ./web
    restart: unless-stopped
    depends_on:
      - db
    environment:
      DATABASE_URL: ${DATABASE_URL}
    ports:
      - "3000:3000"

  caddy:
    image: caddy:alpine
    restart: unless-stopped
    depends_on:
      - web
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile
      - caddy_data:/data

volumes:
  pgdata:
  caddy_data:
```

---

### Roadmap v1

1. Ispezionare un campione reale di eventi dal socket e definire `source_event_key`
2. Schema DB: `vine_item_events` (hypertable), `vine_event_dedupe`, `collector_events`, retention 7gg sui raw
3. Writer: dedupe via `vine_event_dedupe`, batch insert raw, health events, `NOTIFY vine_events` post-commit
4. CAGG 1h con refresh policy che precede la retention dei raw
5. Funzione `data_quality(from, to)` come unica fonte di verità per i badge
6. Esporre API `history`, `live`, `live/snapshot`, `health`
7. Next.js: dispatcher in-memory alimentato da `LISTEN vine_events` + fanout SSE
8. FE minimale: hero `added_7d`, live chart, health panel, disclaimer visibile
9. Heatmap, drop stats, value recap

### Operatività

- **Backup:** dump giornaliero di Postgres (`pg_dump` o snapshot del volume) verso storage esterno. Senza backup, una corruzione del volume azzera tutto lo storico aggregato e il sistema non lo può ricostruire dalla sorgente live.
- **Build Next.js:** non buildare in-place sulla CX22 (rischio OOM con 4GB). Build su CI o locale, push su registry, pull sulla VM.
- **Connessione DB del writer:** una sola connessione persistente, batch commit ogni N eventi o T secondi, reconnect a Postgres gestito separatamente dal reconnect al socket Vine.

---

### Decisione finale

Il progetto è fattibile come dashboard best-effort a basso costo, purché il prodotto dichiari esplicitamente che:

- la metrica hero è una finestra rolling 7gg, non un totale assoluto
- i raw events vivono 7 giorni, gli aggregati orari sopravvivono indefinitamente
- i periodi con gap sono marcati e impattano anche il numero hero
- non esiste una fonte snapshot ufficiale usata per riallineare lo stato
