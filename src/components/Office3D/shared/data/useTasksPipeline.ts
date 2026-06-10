'use client';

/**
 * Live task list for the videowall kanban/mission panels. Same pattern as
 * LiveMissionTab: bootstrap GET /api/tasks, then a debounced refetch on any
 * task.* SSE event (no client-side patching — the API is the truth).
 */
import { useState, useEffect, useRef } from 'react';
import type { Task } from '@/components/LiveMission/types';
import { useOfficeBus } from './OfficeDataProvider';

export function useTasksPipeline(): { tasks: Task[] } {
  const bus = useOfficeBus();
  const [tasks, setTasks] = useState<Task[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchTasks = async () => {
      try {
        const res = await fetch('/api/tasks?limit=200');
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && Array.isArray(data.tasks)) setTasks(data.tasks);
      } catch {
        // best effort — next event retries
      }
    };
    fetchTasks();
    const unsubscribe = bus.subscribe((e) => {
      if (!e.event_type.startsWith('task.')) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(fetchTasks, 800);
    });
    return () => {
      cancelled = true;
      unsubscribe();
      if (timer.current) clearTimeout(timer.current);
    };
  }, [bus]);

  return { tasks };
}
