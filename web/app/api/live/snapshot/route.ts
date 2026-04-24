import { NextResponse } from 'next/server';
import { loadSnapshotForApp } from '@/lib/dashboard-source';
import type { SnapshotResponse } from '@/lib/dashboard-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    const body: SnapshotResponse = await loadSnapshotForApp();

    return NextResponse.json(body, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (err) {
    console.error('snapshot route failed', err);
    return NextResponse.json(
      { error: 'snapshot_failed' },
      { status: 500 }
    );
  }
}
