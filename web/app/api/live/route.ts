import { liveBus, type LiveEvent } from '@/lib/live-bus';
import { proxyLiveStreamForApp } from '@/lib/dashboard-source';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request): Promise<Response> {
  const proxiedResponse = await proxyLiveStreamForApp(request);
  if (proxiedResponse) {
    return proxiedResponse;
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          closed = true;
        }
      };

      // Initial comment so the client opens the stream immediately
      safeEnqueue(': connected\n\n');

      const unsubscribe = liveBus.subscribe((event: LiveEvent) => {
        safeEnqueue(`data: ${JSON.stringify(event)}\n\n`);
      });

      const heartbeat = setInterval(() => {
        safeEnqueue(`: ping ${Date.now()}\n\n`);
      }, 15_000);

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // ignore
        }
      };

      request.signal.addEventListener('abort', cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
