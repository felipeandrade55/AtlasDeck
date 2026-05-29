/**
 * Real-time activity stream via SSE
 * GET /api/activities/stream
 * Sends new activities as they arrive (polling SQLite every 2 seconds)
 */
import { NextRequest } from 'next/server';
import { getActivities } from '@/lib/activities-db';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const encoder = new TextEncoder();
  let lastId: string | null = null;
  let closed = false;

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {}
      };

      // Send initial ping
      send({ type: 'connected', ts: new Date().toISOString() });

      const poll = async () => {
        if (closed) return;

        try {
          const result = getActivities({ limit: 10, sort: 'newest' });
          const activities = result.activities;

          if (activities.length > 0) {
            const newest = activities[0];

            if (lastId === null) {
              // First run: send a batch of recent activities
              send({ type: 'batch', activities: activities.slice(0, 5) });
              lastId = newest.id;
            } else if (newest.id !== lastId) {
              // New activities since last check
              const newActivities = activities.filter((a) => {
                // Send activities newer than lastId
                const lastIdx = activities.findIndex((x) => x.id === lastId);
                if (lastIdx === -1) return true;
                return activities.indexOf(a) < lastIdx;
              });

              for (const activity of newActivities.reverse()) {
                send({ type: 'new', activity });
              }
              lastId = newest.id;
            }
          }
        } catch {}

        if (!closed) {
          setTimeout(poll, 2000);
        }
      };

      poll();

      request.signal?.addEventListener('abort', () => {
        closed = true;
        try { controller.close(); } catch {}
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
