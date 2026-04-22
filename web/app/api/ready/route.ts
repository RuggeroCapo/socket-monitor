import { NextResponse } from 'next/server';
import { pingDatabase } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    await pingDatabase();
    return NextResponse.json(
      { status: 'ok' },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    console.error('ready route failed', err);
    return NextResponse.json(
      { status: 'error' },
      {
        status: 503,
        headers: { 'Cache-Control': 'no-store' },
      }
    );
  }
}
