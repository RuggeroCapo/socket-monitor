import { NextResponse } from 'next/server';
import { loadProductsForApp } from '@/lib/dashboard-source';
import type { ProductSortMode, QueueCode } from '@/lib/dashboard-types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;
const SORT_MODES = new Set<ProductSortMode>(['newest', 'value_desc', 'value_asc']);
const QUEUE_CODES = new Set<QueueCode>(['AI', 'AFA', 'RFY', 'OTHER']);

export async function GET(request: Request): Promise<Response> {
  const { searchParams } = new URL(request.url);
  const offset = Math.max(0, parseInt(searchParams.get('offset') ?? '0', 10));
  const limit = Math.min(
    100,
    Math.max(1, parseInt(searchParams.get('limit') ?? String(PAGE_SIZE), 10))
  );
  const search = searchParams.get('search')?.trim() ?? '';
  const sortParam = searchParams.get('sort');
  const queueParam = searchParams.get('queue');
  const sinceParam = searchParams.get('since');
  const untilParam = searchParams.get('until');
  const sort = SORT_MODES.has(sortParam as ProductSortMode)
    ? (sortParam as ProductSortMode)
    : 'newest';
  const queue = QUEUE_CODES.has(queueParam as QueueCode)
    ? (queueParam as QueueCode)
    : undefined;

  const isValidDate = (v: string | null): v is string =>
    v !== null && Number.isFinite(Date.parse(v));

  const since = isValidDate(sinceParam) ? sinceParam : undefined;
  const until = isValidDate(untilParam) ? untilParam : undefined;

  try {
    const body = await loadProductsForApp({
      offset,
      limit,
      search,
      sort,
      queue,
      since,
      until,
    });
    return NextResponse.json(
      body,
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    console.error('products route failed', err);
    return NextResponse.json({ error: 'products_failed' }, { status: 500 });
  }
}
