import type { QueueCode } from '@/lib/dashboard-types';

export const QUEUE_ORDER: QueueCode[] = ['AI', 'AFA', 'RFY', 'OTHER'];

const QUEUE_ALIASES: Record<string, QueueCode> = {
  ai: 'AI',
  encore: 'AI',
  afa: 'AFA',
  last_chance: 'AFA',
  rfy: 'RFY',
  potluck: 'RFY',
};

export function normalizeQueue(queue: string | null | undefined): QueueCode {
  const normalized = queue?.trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!normalized) return 'OTHER';
  return QUEUE_ALIASES[normalized] ?? 'OTHER';
}

export function queueLabel(queue: QueueCode | 'ALL'): string {
  return queue === 'OTHER' ? 'ALTRO' : queue;
}
