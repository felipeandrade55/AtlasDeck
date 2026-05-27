/**
 * SSE stream of multi-agent orchestration events. Used by the Live Mission
 * tab in /agents to render the kanban + activity feed in real-time.
 *
 * Wire:
 *   1. Replay last N events from SQLite for `?since=` continuation or for
 *      first-connect bootstrap.
 *   2. Subscribe to the in-process EventEmitter and forward each event.
 *   3. 15s keepalive ping (some proxies drop idle SSE connections).
 *
 * Filter via query params:
 *   - event_types=task.created,mailbox.message  (comma-separated)
 *   - task_id=<id>
 *   - agent_id=<id>
 *   - replay=30   (how many events to bootstrap with, default 50)
 *   - since=<iso> (only events strictly newer than this timestamp)
 */
import { NextRequest } from "next/server";
import {
  subscribe,
  listEvents,
  type LiveEvent,
  type LiveEventType,
} from "@/lib/live-events";

export const dynamic = "force-dynamic";

const ALL_EVENT_TYPES: LiveEventType[] = [
  "task.created",
  "task.status_changed",
  "task.checkpoint",
  "task.completed",
  "task.reviewed",
  "task.approved",
  "mailbox.message",
  "agent.heartbeat",
  "agent.state_changed",
  "dispatcher.run",
  "chat.turn_started",
  "chat.tool_use",
  "chat.turn_completed",
];

function parseEventTypes(raw: string | null): LiveEventType[] | undefined {
  if (!raw) return undefined;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is LiveEventType => (ALL_EVENT_TYPES as string[]).includes(s));
  return parts.length ? parts : undefined;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const event_types = parseEventTypes(searchParams.get("event_types"));
  const task_id = searchParams.get("task_id") || undefined;
  const agent_id = searchParams.get("agent_id") || undefined;
  const since = searchParams.get("since") || undefined;
  const replay = Number(searchParams.get("replay") || 50);

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;
      let unsub: (() => void) | null = null;

      const send = (type: string, data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {}
      };

      const matches = (e: LiveEvent): boolean => {
        if (event_types && !event_types.includes(e.event_type)) return false;
        if (task_id && e.task_id !== task_id) return false;
        if (agent_id && e.agent_id !== agent_id) return false;
        return true;
      };

      // 1) Initial handshake
      send("connected", { ts: new Date().toISOString() });

      // 2) Replay recent (or strictly-newer-than-since) events
      try {
        const backlog = listEvents({
          since,
          event_types,
          task_id,
          agent_id,
          limit: replay,
        });
        for (const ev of backlog) {
          send("event", ev);
        }
        send("replay_done", { count: backlog.length });
      } catch (e) {
        send("error", { stage: "replay", message: (e as Error).message });
      }

      // 3) Live subscription
      unsub = subscribe((ev) => {
        if (closed) return;
        if (!matches(ev)) return;
        send("event", ev);
      });

      // 4) Keepalive — 15s comment so proxies don't drop the connection
      const keepalive = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`));
        } catch {}
      }, 15000);

      // 5) Cleanup on client disconnect
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        if (unsub) unsub();
        try {
          controller.close();
        } catch {}
      };
      request.signal?.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
