import { Client } from 'pg';

export type LiveItemEvent = {
  t: 'item_added';
  a: string;   // asin
  queue?: string | null;
  ts: string;  // ISO timestamp
};

export type LiveItemValueUpdatedEvent = {
  t: 'item_value_updated';
  a: string;
  item_value: number;
  currency: string | null;
  ts: string;
};

export type LiveCollectorStatusEvent = {
  t: 'collector_status';
  status: 'online' | 'offline';
  event_type: string;
  ts: string;
};

export type LiveEvent =
  | LiveItemEvent
  | LiveItemValueUpdatedEvent
  | LiveCollectorStatusEvent;

type Subscriber = (event: LiveEvent) => void;

declare global {
  // eslint-disable-next-line no-var
  var __vineLiveBus: LiveBus | undefined;
}

class LiveBus {
  private subscribers = new Set<Subscriber>();
  private client: Client | null = null;
  private connecting = false;
  private backoffMs = 1000;

  subscribe(fn: Subscriber): () => void {
    this.subscribers.add(fn);
    void this.ensureConnected();
    return () => {
      this.subscribers.delete(fn);
    };
  }

  private async ensureConnected(): Promise<void> {
    if (this.client || this.connecting) return;
    this.connecting = true;
    try {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) {
        throw new Error('DATABASE_URL is not set');
      }
      const client = new Client({ connectionString });
      client.on('notification', (msg) => {
        if (msg.channel !== 'vine_events' || !msg.payload) return;
        let parsed: LiveEvent | null = null;
        try {
          parsed = JSON.parse(msg.payload) as LiveEvent;
        } catch {
          return;
        }
        for (const sub of this.subscribers) {
          try {
            sub(parsed);
          } catch (err) {
            console.error('live-bus subscriber error', err);
          }
        }
      });
      client.on('error', (err) => {
        console.warn('live-bus client error, will reconnect', err);
        this.handleDisconnect();
      });
      client.on('end', () => {
        console.warn('live-bus client ended, will reconnect');
        this.handleDisconnect();
      });
      await client.connect();
      await client.query('LISTEN vine_events');
      this.client = client;
      this.backoffMs = 1000;
      console.log('live-bus connected and LISTENing on vine_events');
    } catch (err) {
      console.warn('live-bus connect failed, retrying', err);
      this.scheduleReconnect();
    } finally {
      this.connecting = false;
    }
  }

  private handleDisconnect(): void {
    if (this.client) {
      try {
        void this.client.end();
      } catch {
        // ignore
      }
      this.client = null;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30_000);
    setTimeout(() => {
      void this.ensureConnected();
    }, delay);
  }
}

export const liveBus: LiveBus = global.__vineLiveBus ?? new LiveBus();
if (process.env.NODE_ENV !== 'production') {
  global.__vineLiveBus = liveBus;
}
