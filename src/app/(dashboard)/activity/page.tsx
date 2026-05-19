"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { format, subDays, startOfDay, endOfDay, isToday, isYesterday, formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { ActivityHeatmap } from "@/components/ActivityHeatmap";
import {
  FileText,
  Search,
  MessageSquare,
  Terminal,
  CheckCircle,
  XCircle,
  Clock,
  Zap,
  Filter,
  RefreshCw,
  Shield,
  Wrench,
  Calendar,
  ChevronDown,
  Timer,
  Coins,
  Brain,
  RotateCcw,
  ArrowUpDown,
  Download,
  Star,
  Loader2,
  Activity,
  TrendingUp,
  User,
  Radio,
} from "lucide-react";
import { RichDescription } from "@/components/RichDescription";

interface ActivityItem {
  id: string;
  timestamp: string;
  type: string;
  description: string;
  status: string;
  duration_ms: number | null;
  tokens_used: number | null;
  agent?: string | null;
  pinned?: boolean;
  metadata?: Record<string, unknown>;
}

interface StatsData {
  today: number;
  successRate: number;
  avgDuration: number | null;
  totalTokens: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
}

interface ActivitiesResponse {
  activities: ActivityItem[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  agents?: string[];
  stats?: StatsData;
}

const typeIcons: Record<string, React.ComponentType<{ className?: string; style?: React.CSSProperties }>> = {
  file: FileText,
  search: Search,
  message: MessageSquare,
  command: Terminal,
  security: Shield,
  build: Wrench,
  task: Zap,
  cron: RotateCcw,
  memory: Brain,
  default: Zap,
};

const typeColorVars: Record<string, string> = {
  file: "--type-file",
  search: "--type-search",
  message: "--type-message",
  command: "--type-command",
  security: "--type-security",
  build: "--type-build",
  task: "--type-task",
  cron: "--type-cron",
  memory: "--type-memory",
};

const statusConfig: Record<string, { icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>; colorVar: string }> = {
  success: { icon: CheckCircle, colorVar: "--success" },
  error: { icon: XCircle, colorVar: "--error" },
  pending: { icon: Clock, colorVar: "--warning" },
  running: { icon: Loader2, colorVar: "--info, #3b82f6" },
};

const allTypes = ["file", "search", "message", "command", "security", "build", "task", "cron", "memory"];

const datePresets = [
  { label: "Hoje", days: 0 },
  { label: "Últimos 7 dias", days: 7 },
  { label: "Últimos 30 dias", days: 30 },
  { label: "Todo o período", days: -1 },
];

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatTokens(tokens: number): string {
  if (tokens < 1000) return tokens.toString();
  if (tokens < 1_000_000) return `${(tokens / 1000).toFixed(1)}k`;
  return `${(tokens / 1_000_000).toFixed(2)}M`;
}

function relativeTime(timestamp: string): string {
  const d = new Date(timestamp);
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 24 * 60 * 60 * 1000) {
    return formatDistanceToNow(d, { addSuffix: true, locale: ptBR });
  }
  return format(d, "MMM d, yyyy HH:mm");
}

function getDateGroupKey(timestamp: string): string {
  const d = new Date(timestamp);
  if (isToday(d)) return "Hoje";
  if (isYesterday(d)) return "Ontem";
  return format(d, "EEEE, d 'de' MMMM", { locale: ptBR });
}

export default function ActivityPage() {
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [stats, setStats] = useState<StatsData | null>(null);
  const [agents, setAgents] = useState<string[]>([]);
  
  // Filters
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterAgent, setFilterAgent] = useState<string>("all");
  const [searchText, setSearchText] = useState<string>("");
  const [startDate, setStartDate] = useState<string>("");
  const [endDate, setEndDate] = useState<string>("");
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const [activePreset, setActivePreset] = useState<number | null>(1);
  const [showPinned, setShowPinned] = useState(false);

  // Live feed
  const [liveMode, setLiveMode] = useState(false);
  const [newActivityIds, setNewActivityIds] = useState<Set<string>>(new Set());
  const sseRef = useRef<EventSource | null>(null);

  // Infinite scroll
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const limit = 25;

  const buildParams = useCallback(() => {
    const params = new URLSearchParams();
    params.set("limit", limit.toString());
    params.set("sort", sort);
    if (selectedTypes.size > 0 && selectedTypes.size < allTypes.length) {
      params.set("type", Array.from(selectedTypes).join(','));
    }
    if (filterStatus !== "all") params.set("status", filterStatus);
    if (filterAgent !== "all") params.set("agent", filterAgent);
    if (searchText.trim()) params.set("search", searchText.trim());
    if (startDate) params.set("startDate", startDate);
    if (endDate) params.set("endDate", endDate);
    if (showPinned) params.set("pinned", "true");
    return params;
  }, [sort, selectedTypes, filterStatus, filterAgent, searchText, startDate, endDate, showPinned]);

  const fetchActivities = useCallback(async (append = false) => {
    const currentOffset = append ? offset : 0;
    if (append) { setLoadingMore(true); } else { setLoading(true); }

    try {
      const params = buildParams();
      params.set("offset", currentOffset.toString());
      if (!append) params.set("withStats", "true");

      const res = await fetch(`/api/activities?${params.toString()}`);
      const data: ActivitiesResponse = await res.json();
      
      if (append) {
        setActivities(prev => [...prev, ...data.activities]);
      } else {
        setActivities(data.activities);
        if (data.stats) setStats(data.stats);
        if (data.agents) setAgents(data.agents);
      }
      
      setTotal(data.total);
      setHasMore(data.hasMore);
      setOffset(currentOffset + data.activities.length);
    } catch (error) {
      console.error("Failed to fetch activities:", error);
      if (!append) setActivities([]);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [offset, buildParams]);

  // Reload on filter change
  useEffect(() => {
    setOffset(0);
    fetchActivities(false);
  }, [sort, selectedTypes, filterStatus, filterAgent, startDate, endDate, showPinned]);

  // Debounced search
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setOffset(0);
      fetchActivities(false);
    }, 350);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [searchText]);

  // Initial date range
  useEffect(() => {
    const end = format(endOfDay(new Date()), "yyyy-MM-dd");
    const start = format(startOfDay(subDays(new Date(), 7)), "yyyy-MM-dd");
    setStartDate(start);
    setEndDate(end);
  }, []);

  // SSE Live Feed
  useEffect(() => {
    if (!liveMode) {
      if (sseRef.current) { sseRef.current.close(); sseRef.current = null; }
      return;
    }
    const es = new EventSource("/api/activities/stream");
    sseRef.current = es;
    es.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === "new" && msg.activity) {
          setActivities(prev => {
            if (prev.some(a => a.id === msg.activity.id)) return prev;
            return [msg.activity, ...prev];
          });
          setNewActivityIds(prev => new Set(prev).add(msg.activity.id));
          setTotal(t => t + 1);
          // Clear highlight after 5s
          setTimeout(() => {
            setNewActivityIds(prev => {
              const n = new Set(prev);
              n.delete(msg.activity.id);
              return n;
            });
          }, 5000);
        }
      } catch {}
    };
    es.onerror = () => { es.close(); setLiveMode(false); };
    return () => { es.close(); sseRef.current = null; };
  }, [liveMode]);

  // Infinite scroll
  useEffect(() => {
    if (!sentinelRef.current || !hasMore) return;
    const observer = new IntersectionObserver(
      (entries) => { if (entries[0].isIntersecting && !loadingMore) fetchActivities(true); },
      { rootMargin: "200px" }
    );
    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [hasMore, loadingMore, fetchActivities]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      if (e.key === "r") fetchActivities(false);
      if (e.key === "l") setLiveMode(p => !p);
      if (e.key === "f") document.getElementById("activity-search")?.focus();
      if (e.key === "Escape") { setSelectedTypes(new Set()); setFilterStatus("all"); setFilterAgent("all"); setSearchText(""); setShowPinned(false); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [fetchActivities]);

  const handlePresetClick = (days: number, index: number) => {
    setActivePreset(index);
    const end = format(endOfDay(new Date()), "yyyy-MM-dd");
    if (days === -1) { setStartDate(""); setEndDate(""); }
    else if (days === 0) { setStartDate(format(startOfDay(new Date()), "yyyy-MM-dd")); setEndDate(end); }
    else { setStartDate(format(startOfDay(subDays(new Date(), days)), "yyyy-MM-dd")); setEndDate(end); }
  };

  const toggleType = (type: string) => {
    const n = new Set(selectedTypes);
    n.has(type) ? n.delete(type) : n.add(type);
    setSelectedTypes(n);
    setActivePreset(null);
  };

  const handlePin = async (id: string) => {
    try {
      const res = await fetch("/api/activities", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "pin", id }),
      });
      const data = await res.json();
      setActivities(prev => prev.map(a => a.id === id ? { ...a, pinned: data.pinned } : a));
    } catch {}
  };

  // Build CSV export URL with current filters
  const csvUrl = (() => {
    const p = buildParams();
    p.set("format", "csv");
    p.set("limit", "10000");
    p.delete("offset");
    return `/api/activities?${p.toString()}`;
  })();

  if (loading && activities.length === 0) {
    return (
      <div style={{ padding: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '3rem 0' }}>
          <RefreshCw className="w-8 h-8 animate-spin" style={{ color: 'var(--accent)' }} />
        </div>
      </div>
    );
  }

  const selectStyle = { backgroundColor: 'var(--card-elevated)', color: 'var(--text-secondary)', padding: '0.5rem 0.75rem', borderRadius: '0.5rem', border: '1px solid var(--border)', outline: 'none', cursor: 'pointer', fontSize: '0.875rem' };

  // Group activities by date
  const groupedActivities: Array<{ label: string; items: ActivityItem[] }> = [];
  let currentGroup = "";
  for (const a of activities) {
    const group = getDateGroupKey(a.timestamp);
    if (group !== currentGroup) {
      groupedActivities.push({ label: group, items: [a] });
      currentGroup = group;
    } else {
      groupedActivities[groupedActivities.length - 1].items.push(a);
    }
  }

  return (
    <div className="p-4 md:p-8">
      {/* Header */}
      <div className="mb-4 md:mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl md:text-3xl font-bold mb-1" style={{ color: 'var(--text-primary)', fontFamily: 'var(--font-heading)' }}>
            Registro de Atividades
          </h1>
          <p style={{ color: 'var(--text-secondary)', fontSize: '0.875rem' }}>Histórico completo das ações dos agentes</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          {/* Live toggle */}
          <button onClick={() => setLiveMode(p => !p)} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 0.75rem', borderRadius: '9999px', fontSize: '0.8rem', fontWeight: 600, border: liveMode ? '1px solid rgba(239,68,68,0.3)' : '1px solid var(--border)', backgroundColor: liveMode ? 'rgba(239,68,68,0.12)' : 'var(--card)', color: liveMode ? '#f87171' : 'var(--text-secondary)', cursor: 'pointer', transition: 'all 0.2s' }}>
            {liveMode && <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: '#f87171', animation: 'pulse 1.5s infinite' }} />}
            <Radio className="w-3.5 h-3.5" />
            {liveMode ? 'Live' : 'Live'}
          </button>
          {/* Refresh */}
          <button onClick={() => fetchActivities(false)} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 0.75rem', borderRadius: '0.5rem', backgroundColor: 'var(--card)', color: 'var(--text-secondary)', border: '1px solid var(--border)', cursor: 'pointer', fontSize: '0.8rem' }}>
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
          {/* CSV */}
          <a href={csvUrl} download={`activities-${new Date().toISOString().split('T')[0]}.csv`} style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.5rem 0.75rem', borderRadius: '0.5rem', backgroundColor: 'var(--card)', color: 'var(--text-secondary)', border: '1px solid var(--border)', textDecoration: 'none', fontSize: '0.8rem', cursor: 'pointer' }}>
            <Download className="w-3.5 h-3.5" /> CSV
          </a>
        </div>
      </div>

      {/* KPI Cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4 md:mb-6">
          {[
            { icon: Activity, label: 'Hoje', value: stats.today.toString(), color: 'var(--accent)' },
            { icon: TrendingUp, label: 'Taxa de Sucesso', value: `${stats.successRate}%`, color: 'var(--success)' },
            { icon: Timer, label: 'Tempo Médio', value: stats.avgDuration ? formatDuration(stats.avgDuration) : '—', color: 'var(--warning)' },
            { icon: Coins, label: 'Tokens Total', value: formatTokens(stats.totalTokens), color: 'var(--info, #3b82f6)' },
          ].map((kpi) => {
            const KIcon = kpi.icon;
            return (
              <div key={kpi.label} style={{ padding: '1rem 1.25rem', borderRadius: '0.75rem', backgroundColor: 'var(--card)', border: '1px solid var(--border)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                  <KIcon className="w-4 h-4" style={{ color: kpi.color }} />
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.03em' }}>{kpi.label}</span>
                </div>
                <div style={{ fontSize: '1.5rem', fontWeight: 700, color: kpi.color }}>{kpi.value}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* Heatmap */}
      <div className="mb-4 md:mb-6"><ActivityHeatmap /></div>

      {/* Search + Filters bar */}
      <div className="p-3 md:p-4 mb-4 md:mb-6 rounded-xl" style={{ backgroundColor: 'var(--card)' }}>
        {/* Search input */}
        <div style={{ position: 'relative', marginBottom: '0.75rem' }}>
          <Search className="w-4 h-4" style={{ position: 'absolute', left: '0.75rem', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input id="activity-search" type="text" placeholder="Buscar atividades... (f)" value={searchText} onChange={e => setSearchText(e.target.value)}
            style={{ width: '100%', backgroundColor: 'var(--card-elevated)', color: 'var(--text-primary)', padding: '0.625rem 0.75rem 0.625rem 2.25rem', borderRadius: '0.5rem', border: '1px solid var(--border)', outline: 'none', fontSize: '0.875rem' }} />
        </div>

        {/* Date presets */}
        <div className="flex items-center gap-3 mb-3">
          <Calendar className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} />
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Período</span>
        </div>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          {datePresets.map((preset, index) => (
            <button key={preset.label} onClick={() => handlePresetClick(preset.days, index)}
              style={{ padding: '0.375rem 0.75rem', borderRadius: '0.5rem', fontSize: '0.8rem', fontWeight: 500, transition: 'all 0.2s', backgroundColor: activePreset === index ? 'rgba(255,59,48,0.2)' : 'var(--card-elevated)', color: activePreset === index ? 'var(--accent)' : 'var(--text-secondary)', border: activePreset === index ? '1px solid rgba(255,59,48,0.3)' : '1px solid transparent', cursor: 'pointer' }}>
              {preset.label}
            </button>
          ))}
          <div style={{ width: 1, height: '1.5rem', backgroundColor: 'var(--border)', margin: '0 0.25rem' }} />
          <input type="date" value={startDate} onChange={e => { setStartDate(e.target.value); setActivePreset(null); }} style={selectStyle} />
          <span style={{ color: 'var(--text-muted)', fontSize: '0.8rem' }}>até</span>
          <input type="date" value={endDate} onChange={e => { setEndDate(e.target.value); setActivePreset(null); }} style={selectStyle} />
        </div>

        {/* Type chips with counts */}
        <div className="flex items-center gap-3 mb-2">
          <Filter className="w-4 h-4" style={{ color: 'var(--text-secondary)' }} />
          <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Tipo</span>
          {selectedTypes.size > 0 && (
            <button onClick={() => setSelectedTypes(new Set())} style={{ fontSize: '0.7rem', color: 'var(--accent)', marginLeft: 'auto', background: 'none', border: 'none', cursor: 'pointer' }}>Limpar</button>
          )}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.375rem' }}>
          {allTypes.map(type => {
            const TI = typeIcons[type] || typeIcons.default;
            const cv = typeColorVars[type] || "--text-secondary";
            const sel = selectedTypes.has(type);
            const count = stats?.byType?.[type] ?? 0;
            return (
              <button key={type} onClick={() => toggleType(type)}
                style={{ display: 'flex', alignItems: 'center', gap: '0.375rem', padding: '0.25rem 0.625rem', borderRadius: '9999px', fontSize: '0.8rem', fontWeight: 500, transition: 'all 0.2s', backgroundColor: sel ? `color-mix(in srgb, var(${cv}) 15%, transparent)` : 'var(--card-elevated)', color: sel ? `var(${cv})` : 'var(--text-muted)', border: sel ? `1px solid color-mix(in srgb, var(${cv}) 30%, transparent)` : '1px solid var(--border)', cursor: 'pointer' }}>
                <TI className="w-3.5 h-3.5" />
                <span style={{ textTransform: 'capitalize' }}>{type}</span>
                {count > 0 && <span style={{ fontSize: '0.7rem', opacity: 0.7 }}>({count})</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* Status + Agent + Sort + Pinned */}
      <div className="flex flex-wrap items-center gap-2 mb-4 md:mb-6">
        <select value={filterStatus} onChange={e => setFilterStatus(e.target.value)} style={selectStyle}>
          <option value="all">Todos os Status</option>
          <option value="success">Sucesso</option>
          <option value="error">Erro</option>
          <option value="pending">Pendente</option>
          <option value="running">Em execução</option>
        </select>

        {agents.length > 0 && (
          <select value={filterAgent} onChange={e => setFilterAgent(e.target.value)} style={selectStyle}>
            <option value="all">Todos os Agentes</option>
            {agents.map(a => <option key={a} value={a}>{a}</option>)}
          </select>
        )}

        <button onClick={() => setSort(sort === "newest" ? "oldest" : "newest")}
          style={{ ...selectStyle, display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
          <ArrowUpDown className="w-3.5 h-3.5" />
          {sort === "newest" ? "Mais recente" : "Mais antigo"}
        </button>

        <button onClick={() => setShowPinned(!showPinned)}
          style={{ ...selectStyle, display: 'flex', alignItems: 'center', gap: '0.375rem', backgroundColor: showPinned ? 'rgba(250,204,21,0.12)' : selectStyle.backgroundColor, color: showPinned ? '#facc15' : selectStyle.color, border: showPinned ? '1px solid rgba(250,204,21,0.3)' : selectStyle.border }}>
          <Star className="w-3.5 h-3.5" />
          Marcadas
        </button>

        <div className="text-xs md:text-sm md:ml-auto" style={{ color: 'var(--text-muted)' }}>
          {activities.length} de {total}
        </div>
      </div>

      {/* Activity List with Date Groups */}
      <div className="rounded-xl overflow-hidden" style={{ backgroundColor: 'var(--card)' }}>
        {activities.length === 0 && (
          <div style={{ textAlign: 'center', padding: '3rem 0', color: 'var(--text-secondary)' }}>
            <Zap className="w-12 h-12" style={{ margin: '0 auto 1rem', opacity: 0.5 }} />
            <p>Nenhuma atividade encontrada</p>
            <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.5rem' }}>Tente ajustar os filtros ou o período</p>
          </div>
        )}

        {groupedActivities.map((group, gi) => (
          <div key={gi}>
            {/* Date group separator */}
            <div style={{ padding: '0.5rem 1.5rem', backgroundColor: 'var(--card-elevated)', borderBottom: '1px solid var(--border)', borderTop: gi > 0 ? '1px solid var(--border)' : 'none', position: 'sticky', top: 0, zIndex: 5 }}>
              <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'capitalize' }}>{group.label}</span>
            </div>

            {group.items.map((activity, index) => {
              const TIcon = typeIcons[activity.type] || typeIcons.default;
              const cVar = typeColorVars[activity.type] || "--text-secondary";
              const st = statusConfig[activity.status] || statusConfig.success;
              const StIcon = st.icon;
              const isNew = newActivityIds.has(activity.id);
              const isRunning = activity.status === "running";

              return (
                <div key={activity.id}
                  style={{ display: 'flex', alignItems: 'flex-start', gap: '0.75rem', padding: '1rem 1.5rem', transition: 'background-color 0.5s', borderBottom: index !== group.items.length - 1 ? '1px solid var(--border)' : 'none', backgroundColor: isNew ? 'rgba(255,59,48,0.06)' : 'transparent' }}>
                  {/* Type icon */}
                  <div style={{ padding: '0.625rem', borderRadius: '0.5rem', backgroundColor: `color-mix(in srgb, var(${cVar}) 15%, transparent)`, flexShrink: 0 }}>
                    <TIcon className="w-4 h-4" style={{ color: `var(${cVar})` }} />
                  </div>

                  {/* Content */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.25rem', flexWrap: 'wrap' }}>
                      <span style={{ fontWeight: 500, textTransform: 'capitalize', color: `var(${cVar})`, fontSize: '0.875rem' }}>{activity.type}</span>
                      <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', fontSize: '0.75rem', color: `var(${st.colorVar})`, backgroundColor: `color-mix(in srgb, var(${st.colorVar}) 15%, transparent)`, padding: '0.125rem 0.375rem', borderRadius: '0.25rem' }}>
                        <StIcon className={`w-3 h-3${isRunning ? ' animate-spin' : ''}`} />
                        {activity.status}
                      </span>
                      {activity.agent && (
                        <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                          <User className="w-3 h-3" /> {activity.agent}
                        </span>
                      )}
                    </div>

                    <RichDescription text={activity.description} style={{ color: 'var(--text-secondary)', marginBottom: '0.375rem', fontSize: '0.875rem' }} />

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', fontSize: '0.8rem' }}>
                      {activity.duration_ms !== null && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', color: 'var(--text-muted)' }}>
                          <Timer className="w-3 h-3" /> {formatDuration(activity.duration_ms)}
                        </span>
                      )}
                      {activity.tokens_used !== null && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: '0.25rem', color: 'var(--text-muted)' }}>
                          <Coins className="w-3 h-3" /> {formatTokens(activity.tokens_used)}
                        </span>
                      )}
                    </div>

                    {activity.metadata && Object.keys(activity.metadata).length > 0 && (
                      <details style={{ marginTop: '0.5rem' }}>
                        <summary style={{ fontSize: '0.7rem', color: 'var(--text-muted)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                          <ChevronDown className="w-3 h-3" /> Metadados
                        </summary>
                        <pre style={{ marginTop: '0.375rem', fontSize: '0.7rem', color: 'var(--text-muted)', backgroundColor: 'var(--card-elevated)', padding: '0.5rem', borderRadius: '0.375rem', overflowX: 'auto' }}>
                          {JSON.stringify(activity.metadata, null, 2)}
                        </pre>
                      </details>
                    )}
                  </div>

                  {/* Right: time + pin */}
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '0.375rem', flexShrink: 0 }}>
                    <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{relativeTime(activity.timestamp)}</span>
                    <button onClick={() => handlePin(activity.id)} title="Marcar" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '0.25rem', borderRadius: '0.25rem', color: activity.pinned ? '#facc15' : 'var(--text-muted)', opacity: activity.pinned ? 1 : 0.4, transition: 'all 0.2s' }}>
                      <Star className="w-3.5 h-3.5" style={{ fill: activity.pinned ? '#facc15' : 'none' }} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Infinite scroll sentinel */}
      <div ref={sentinelRef} style={{ height: 1 }} />

      {/* Loading more indicator */}
      {loadingMore && (
        <div style={{ display: 'flex', justifyContent: 'center', padding: '1.5rem 0' }}>
          <RefreshCw className="w-5 h-5 animate-spin" style={{ color: 'var(--accent)' }} />
        </div>
      )}

      {/* End indicator */}
      {!hasMore && activities.length > 0 && (
        <div style={{ textAlign: 'center', marginTop: '1.5rem', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
          — Fim do registro —
        </div>
      )}

      {/* Keyboard shortcuts hint */}
      <div style={{ textAlign: 'center', marginTop: '1rem', fontSize: '0.65rem', color: 'var(--text-muted)', opacity: 0.5 }}>
        Atalhos: R refresh · L live · F busca · Esc limpar filtros
      </div>
    </div>
  );
}

