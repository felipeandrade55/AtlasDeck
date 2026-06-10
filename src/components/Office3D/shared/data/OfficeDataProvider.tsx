'use client';

/**
 * Single SSE connection for the whole /office page. Everything that needs
 * live events (agent states, the videowall feed, the envelope system)
 * subscribes to this bus instead of opening its own EventSource — two
 * connections would double the replay traffic and can starve the browser's
 * per-host connection pool.
 *
 * Mount order guarantees: children's `useEffect` subscriptions run BEFORE
 * this provider's own effect opens the EventSource, so nothing mounted with
 * the provider misses the `replay=80` backlog. Late subscribers (panels
 * opened after load) catch up via `getRecent()`.
 */
import { createContext, useContext, useEffect, useMemo, useRef } from 'react';
import type { LiveEvent } from '@/components/LiveMission/types';

const RING_BUFFER_SIZE = 200;

export interface OfficeBus {
  subscribe(cb: (e: LiveEvent) => void): () => void;
  /** Last ~200 events, oldest first. */
  getRecent(): LiveEvent[];
}

const OfficeBusContext = createContext<OfficeBus | null>(null);

export function useOfficeBus(): OfficeBus {
  const bus = useContext(OfficeBusContext);
  if (!bus) throw new Error('useOfficeBus must be used inside <OfficeDataProvider>');
  return bus;
}

export default function OfficeDataProvider({ children }: { children: React.ReactNode }) {
  const listeners = useRef(new Set<(e: LiveEvent) => void>());
  const recent = useRef<LiveEvent[]>([]);

  const bus = useMemo<OfficeBus>(
    () => ({
      subscribe(cb) {
        listeners.current.add(cb);
        return () => {
          listeners.current.delete(cb);
        };
      },
      getRecent: () => recent.current,
    }),
    [],
  );

  useEffect(() => {
    const es = new EventSource('/api/agents/live?replay=80');
    es.addEventListener('event', (msg) => {
      try {
        const e = JSON.parse((msg as MessageEvent).data) as LiveEvent;
        if (recent.current.length >= RING_BUFFER_SIZE) {
          recent.current = recent.current.slice(-(RING_BUFFER_SIZE - 1));
        }
        recent.current.push(e);
        for (const cb of listeners.current) cb(e);
      } catch {
        // ignore malformed frames
      }
    });
    es.onerror = () => {
      // Native auto-reconnect — log only in dev
      if (process.env.NODE_ENV === 'development') {
        console.warn('[OfficeDataProvider] SSE error, EventSource will reconnect');
      }
    };
    return () => es.close();
  }, []);

  return <OfficeBusContext.Provider value={bus}>{children}</OfficeBusContext.Provider>;
}
