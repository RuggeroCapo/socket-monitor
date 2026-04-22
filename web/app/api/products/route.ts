import { NextResponse } from 'next/server';
import { loadMoreProducts } from '@/lib/dashboard-data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const offset = Math.max(0, parseInt(searchParams.get('offset') ?? '0', 10));
  const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') ?? String(PAGE_SIZE), 10)));

  try {
    const products = await loadMoreProducts(offset, limit);
    return NextResponse.json({ products, offset, limit }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error('products route failed', err);
    return NextResponse.json({ error: 'products_failed' }, { status: 500 });
  }
}
