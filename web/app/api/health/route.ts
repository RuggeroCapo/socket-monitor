import { NextResponse } from 'next/server';
import { loadHealth } from '@/lib/dashboard-data';
import type { HealthResponse } from '@/lib/dashboard-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    const body: HealthResponse = await loadHealth();

    return NextResponse.json(body, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    console.error('health route failed', err);
    return NextResponse.json(
      { error: 'health_failed' },
      { status: 500 }
    );
  }
}
