import { NextResponse } from 'next/server';
import { loadChartData } from '@/lib/chart-data';
import type { ChartResponse } from '@/lib/dashboard-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    const points = await loadChartData();
    const body: ChartResponse = { points };
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error('chart route failed', err);
    return NextResponse.json({ error: 'chart_failed' }, { status: 500 });
  }
}
