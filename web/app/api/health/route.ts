import { NextResponse } from 'next/server';
import { loadHealthForApp } from '@/lib/dashboard-source';
import type { HealthResponse } from '@/lib/dashboard-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    const body: HealthResponse = await loadHealthForApp();

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
