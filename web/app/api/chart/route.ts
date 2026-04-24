import { NextResponse } from 'next/server';
import { loadChartForApp } from '@/lib/dashboard-source';
import type { ChartResponse } from '@/lib/dashboard-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    const body: ChartResponse = await loadChartForApp();
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error('chart route failed', err);
    return NextResponse.json({ error: 'chart_failed' }, { status: 500 });
  }
}
