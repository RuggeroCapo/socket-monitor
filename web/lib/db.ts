import { Pool } from 'pg';

declare global {
  // eslint-disable-next-line no-var
  var __vinePgPool: Pool | undefined;
}

function buildPool(): Pool {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }
  return new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30_000,
  });
}

export function getPool(): Pool {
  if (!global.__vinePgPool) {
    global.__vinePgPool = buildPool();
  }
  return global.__vinePgPool;
}

export async function pingDatabase(): Promise<void> {
  const client = await getPool().connect();
  try {
    await client.query('SELECT 1');
  } finally {
    client.release();
  }
}
