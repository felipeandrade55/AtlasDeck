"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import {
  FileText,
  Search,
  MessageSquare,
  Terminal,
  CheckCircle,
  XCircle,
  Clock,
  Zap,
  Shield,
  Hammer,
  Timer,
  Brain,
  CalendarDays,
  Save,
  Download,
  RefreshCw,
  Bot,
  Settings as SettingsIcon,
} from "lucide-react";
import { RichDescription } from "./RichDescription";

interface Activity {
  id: string;
  timestamp: string;
  type: string;
  description: string;
  status: string;
  duration_ms: number | null;
  tokens_used: number | null;
}

interface ActivitiesResponse {
  activities: Activity[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

const typeConfig: Record<string, { 
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  color: string;
  bgColor: string;
  label: string;
}> = {
  file: { icon: FileText, color: 'var(--type-file)', bgColor: 'var(--type-file-bg)', label: 'Arquivo' },
  search: { icon: Search, color: 'var(--type-search)', bgColor: 'var(--type-search-bg)', label: 'Busca' },
  message: { icon: MessageSquare, color: 'var(--type-message)', bgColor: 'var(--type-message-bg)', label: 'Mensagem' },
  command: { icon: Terminal, color: 'var(--type-command)', bgColor: 'var(--type-command-bg)', label: 'Comando' },
  security: { icon: Shield, color: 'var(--type-security)', bgColor: 'var(--type-security-bg)', label: 'Segurança' },
  build: { icon: Hammer, color: 'var(--type-build)', bgColor: 'var(--type-build-bg)', label: 'Build' },
  cron: { icon: Timer, color: 'var(--type-cron)', bgColor: 'var(--type-cron-bg)', label: 'Cron' },
  memory: { icon: Brain, color: 'var(--info)', bgColor: 'var(--info-bg)', label: 'Memória' },
  calendar: { icon: CalendarDays, color: '#FF3B30', bgColor: 'rgba(255, 59, 48, 0.12)', label: 'Calendário' },
  backup: { icon: Save, color: '#4ade80', bgColor: 'rgba(74, 222, 128, 0.12)', label: 'Backup' },
  restore: { icon: Download, color: '#fbbf24', bgColor: 'rgba(251, 191, 36, 0.12)', label: 'Restore' },
  update: { icon: RefreshCw, color: '#60a5fa', bgColor: 'rgba(96, 165, 250, 0.12)', label: 'Update' },
  agent: { icon: Bot, color: '#a78bfa', bgColor: 'rgba(167, 139, 250, 0.12)', label: 'Agente' },
  config: { icon: SettingsIcon, color: 'var(--text-secondary)', bgColor: 'var(--card-elevated)', label: 'Config' },
  default: { icon: Zap, color: 'var(--text-secondary)', bgColor: 'var(--card-elevated)', label: 'Ação' },
};

const statusConfig: Record<string, { 
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  color: string;
  bgColor: string;
}> = {
  success: { icon: CheckCircle, color: 'var(--success)', bgColor: 'var(--success-bg)' },
  error: { icon: XCircle, color: 'var(--error)', bgColor: 'var(--error-bg)' },
  pending: { icon: Clock, color: 'var(--warning)', bgColor: 'var(--warning-bg)' },
};

interface ActivityFeedProps {
  limit?: number;
}

async function fetchActivitiesWithTimeout(limit: number, timeoutMs = 8000): Promise<Activity[]> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`/api/activities?limit=${limit}&sort=newest`, {
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null) as ActivitiesResponse | null;
    if (!res.ok) {
      throw new Error(data && "error" in data ? String(data.error) : `HTTP ${res.status}`);
    }
    return data?.activities ?? [];
  } finally {
    window.clearTimeout(timeout);
  }
}

export function ActivityFeed({ limit = 10 }: ActivityFeedProps) {
  const [activities, setActivities] = useState<Activity[] | null>(null);
  const router = useRouter();
  const connectionRef = useRef<EventSource | ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    // Initial load via REST
    fetchActivitiesWithTimeout(limit)
      .then((items) => setActivities(items))
      .catch(() => setActivities([]));

    // Real-time updates via SSE
    const es = new EventSource('/api/activities/stream');
    connectionRef.current = es;

    es.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'batch') {
          setActivities(prev => prev === null ? msg.activities.slice(0, limit) : prev);
        } else if (msg.type === 'new') {
          setActivities(prev => {
            const base = prev ?? [];
            return [msg.activity, ...base].slice(0, limit);
          });
        }
      } catch {}
    };

    es.onerror = () => {
      es.close();
      const id = setInterval(() => {
        fetchActivitiesWithTimeout(limit)
          .then((items) => setActivities(items))
          .catch(() => {});
      }, 30_000);
      connectionRef.current = id;
    };

    return () => {
      const ref = connectionRef.current;
      if (ref instanceof EventSource) {
        ref.close();
      } else if (ref !== null) {
        clearInterval(ref as ReturnType<typeof setInterval>);
      }
      connectionRef.current = null;
    };
  }, [limit]);

  if (!activities) {
    return (
      <div className="animate-pulse">
        {[...Array(5)].map((_, i) => (
          <div 
            key={i} 
            className="h-16 mx-4 my-2 rounded-lg"
            style={{ backgroundColor: 'var(--card-elevated)' }}
          />
        ))}
      </div>
    );
  }

  if (activities.length === 0) {
    return (
      <div className="text-center py-12" style={{ color: 'var(--text-secondary)' }}>
        <Zap className="w-12 h-12 mx-auto mb-4 opacity-50" />
        <p>Nenhuma atividade registrada ainda</p>
      </div>
    );
  }

  return (
    <div>
      {activities.map((activity) => {
        const type = typeConfig[activity.type] || typeConfig.default;
        const status = statusConfig[activity.status] || statusConfig.success;
        const TypeIcon = type.icon;

        return (
          <div
            key={activity.id}
            className="flex items-center gap-2 md:gap-3 px-3 md:px-4 py-2 md:py-3 transition-colors cursor-pointer"
            style={{
              borderRadius: '8px',
            }}
            onClick={() => router.push('/activity')}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = 'var(--card-elevated)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = 'transparent';
            }}
          >
            {/* Icon */}
            <div 
              className="w-7 h-7 md:w-9 md:h-9 rounded-lg flex items-center justify-center flex-shrink-0"
              style={{ backgroundColor: type.bgColor }}
            >
              <TypeIcon className="w-3.5 h-3.5 md:w-[18px] md:h-[18px]" style={{ color: type.color }} />
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-1.5 md:gap-2 mb-0.5">
                <span 
                  className="text-[10px] md:text-xs font-semibold uppercase"
                  style={{ color: type.color }}
                >
                  {type.label}
                </span>
                {activity.status === 'success' && (
                  <span
                    className="badge text-[10px] md:text-xs py-0.5 px-1.5 md:px-2 hidden sm:inline-block"
                    style={{
                      backgroundColor: status.bgColor,
                      color: status.color,
                    }}
                  >
                    Sucesso
                  </span>
                )}
                {activity.status === 'error' && (
                  <span
                    className="badge text-[10px] md:text-xs py-0.5 px-1.5 md:px-2"
                    style={{
                      backgroundColor: status.bgColor,
                      color: status.color,
                    }}
                  >
                    Erro
                  </span>
                )}
              </div>
              <RichDescription 
                text={activity.description}
                className="text-xs md:text-sm"
                style={{ color: 'var(--text-primary)' }}
              />
            </div>

            {/* Time */}
            <time 
              className="text-[10px] md:text-xs whitespace-nowrap flex-shrink-0"
              style={{ color: 'var(--text-muted)' }}
            >
              {formatDistanceToNow(new Date(activity.timestamp), { addSuffix: false, locale: ptBR })}
            </time>
          </div>
        );
      })}
    </div>
  );
}
