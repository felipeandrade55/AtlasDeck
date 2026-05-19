"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  Clock,
  RefreshCw,
  AlertCircle,
  LayoutGrid,
  CalendarDays,
  Zap,
  Search,
  ArrowUpDown,
  Users,
  ChevronDown,
  ChevronRight,
  Plus,
  Filter,
} from "lucide-react";
import { CronJobCard, type CronJob } from "@/components/CronJobCard";
import { CronWeeklyTimeline } from "@/components/CronWeeklyTimeline";

type ViewMode = "cards" | "timeline";
type StatusFilter = "all" | "active" | "paused";
type SortBy = "nextRun" | "lastRun" | "name" | "agentId";
type SortOrder = "asc" | "desc";

export default function CronJobsPage() {
  const [jobs, setJobs] = useState<CronJob[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("cards");
  const [runToast, setRunToast] = useState<{
    id: string;
    status: "success" | "error";
    name: string;
  } | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  // Filters & sorting
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [sortBy, setSortBy] = useState<SortBy>("nextRun");
  const [sortOrder, setSortOrder] = useState<SortOrder>("asc");
  const [groupByAgent, setGroupByAgent] = useState(false);
  const [showFilters, setShowFilters] = useState(false);

  const fetchJobs = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch("/api/cron");
      if (!res.ok) throw new Error("Failed to fetch jobs");
      const data = await res.json();
      setJobs(Array.isArray(data) ? data : []);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Initial fetch + auto-refresh every 10s
  useEffect(() => {
    fetchJobs();
    const interval = setInterval(fetchJobs, 10000);
    return () => clearInterval(interval);
  }, [fetchJobs]);

  const handleToggle = async (id: string, enabled: boolean) => {
    try {
      const res = await fetch("/api/cron", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, enabled }),
      });
      if (!res.ok) throw new Error("Failed to update job");
      setJobs((prev) =>
        prev.map((job) => (job.id === id ? { ...job, enabled } : job))
      );
    } catch (err) {
      console.error("Toggle error:", err);
      setError("Failed to update job status");
    }
  };

  const handleDelete = async (id: string) => {
    if (deleteConfirm !== id) {
      setDeleteConfirm(id);
      return;
    }
    try {
      const res = await fetch(`/api/cron?id=${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Failed to delete job");
      setJobs((prev) => prev.filter((job) => job.id !== id));
      setDeleteConfirm(null);
    } catch (err) {
      console.error("Delete error:", err);
      setError("Failed to delete job");
    }
  };

  const handleRun = async (id: string) => {
    const job = jobs.find((j) => j.id === id);
    const res = await fetch("/api/cron/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });

    const data = await res.json();

    if (!res.ok || !data.success) {
      setRunToast({ id, status: "error", name: job?.name || id });
      setTimeout(() => setRunToast(null), 4000);
      throw new Error(data.error || "Trigger failed");
    }

    setRunToast({ id, status: "success", name: job?.name || id });
    setTimeout(() => setRunToast(null), 4000);
  };

  // Filter + sort logic
  const processedJobs = useMemo(() => {
    let result = [...jobs];

    // Text search
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (j) =>
          j.name.toLowerCase().includes(q) ||
          j.agentId.toLowerCase().includes(q) ||
          j.description?.toLowerCase().includes(q) ||
          j.scheduleDisplay?.toLowerCase().includes(q)
      );
    }

    // Status filter
    if (statusFilter === "active") {
      result = result.filter((j) => j.enabled);
    } else if (statusFilter === "paused") {
      result = result.filter((j) => !j.enabled);
    }

    // Sorting
    result.sort((a, b) => {
      let cmp = 0;
      switch (sortBy) {
        case "name":
          cmp = a.name.localeCompare(b.name);
          break;
        case "agentId":
          cmp = a.agentId.localeCompare(b.agentId);
          break;
        case "nextRun": {
          const aTime = a.nextRun ? new Date(a.nextRun).getTime() : Infinity;
          const bTime = b.nextRun ? new Date(b.nextRun).getTime() : Infinity;
          cmp = aTime - bTime;
          break;
        }
        case "lastRun": {
          const aTime = a.lastRun
            ? new Date(a.lastRun).getTime()
            : -Infinity;
          const bTime = b.lastRun
            ? new Date(b.lastRun).getTime()
            : -Infinity;
          cmp = bTime - aTime; // default: most recent first
          break;
        }
      }
      return sortOrder === "asc" ? cmp : -cmp;
    });

    return result;
  }, [jobs, searchQuery, statusFilter, sortBy, sortOrder]);

  // Grouping
  const groupedJobs = useMemo(() => {
    if (!groupByAgent) return null;
    const map = new Map<string, CronJob[]>();
    processedJobs.forEach((job) => {
      const list = map.get(job.agentId) || [];
      list.push(job);
      map.set(job.agentId, list);
    });
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [processedJobs, groupByAgent]);

  const activeJobs = jobs.filter((j) => j.enabled).length;
  const pausedJobs = jobs.length - activeJobs;

  const isStale = lastUpdated
    ? Date.now() - lastUpdated.getTime() > 30000
    : false;

  return (
    <div className="p-4 md:p-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-4 md:mb-6">
        <div>
          <h1
            className="text-2xl md:text-3xl font-bold mb-1"
            style={{
              color: "var(--text-primary)",
              fontFamily: "var(--font-heading)",
            }}
          >
            Tarefas Agendadas
          </h1>
          <p
            className="text-sm md:text-base"
            style={{ color: "var(--text-secondary)" }}
          >
            Tarefas programadas do OpenClaw Gateway
            {lastUpdated && (
              <span className="ml-2 text-xs opacity-60">
                (atualizado{" "}
                {lastUpdated.toLocaleTimeString("pt-BR", {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                })}
                )
              </span>
            )}
          </p>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "0.5rem",
            flexWrap: "wrap",
          }}
        >
          {/* View mode toggle */}
          <div
            style={{
              display: "flex",
              backgroundColor: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: "0.5rem",
              padding: "3px",
            }}
          >
            <button
              onClick={() => setViewMode("cards")}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.35rem",
                padding: "0.4rem 0.75rem",
                borderRadius: "0.35rem",
                fontSize: "0.8rem",
                fontWeight: 600,
                backgroundColor:
                  viewMode === "cards" ? "var(--accent)" : "transparent",
                color: viewMode === "cards" ? "white" : "var(--text-secondary)",
                border: "none",
                cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              Cards
            </button>
            <button
              onClick={() => setViewMode("timeline")}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.35rem",
                padding: "0.4rem 0.75rem",
                borderRadius: "0.35rem",
                fontSize: "0.8rem",
                fontWeight: 600,
                backgroundColor:
                  viewMode === "timeline" ? "var(--accent)" : "transparent",
                color:
                  viewMode === "timeline" ? "white" : "var(--text-secondary)",
                border: "none",
                cursor: "pointer",
                transition: "all 0.15s",
              }}
            >
              <CalendarDays className="w-3.5 h-3.5" />
              Timeline
            </button>
          </div>

          <button
            onClick={() => {
              setIsLoading(true);
              fetchJobs();
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              padding: "0.5rem 1rem",
              backgroundColor: "var(--card)",
              color: "var(--text-primary)",
              borderRadius: "0.5rem",
              border: "1px solid var(--border)",
              cursor: "pointer",
              fontWeight: 500,
              transition: "opacity 0.2s",
            }}
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
            Atualizar
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 md:gap-4 mb-4 md:mb-6">
        <div
          style={{
            backgroundColor: "color-mix(in srgb, var(--card) 50%, transparent)",
            border: "1px solid var(--border)",
            borderRadius: "0.75rem",
            padding: "1rem",
            display: "flex",
            alignItems: "center",
            gap: "1rem",
          }}
        >
          <div
            style={{
              padding: "0.75rem",
              backgroundColor:
                "color-mix(in srgb, var(--info) 20%, transparent)",
              borderRadius: "0.5rem",
            }}
          >
            <Clock className="w-6 h-6" style={{ color: "var(--info)" }} />
          </div>
          <div>
            <p
              style={{
                fontSize: "1.5rem",
                fontWeight: 700,
                color: "var(--text-primary)",
              }}
            >
              {jobs.length}
            </p>
            <p
              style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}
            >
              Total
            </p>
          </div>
        </div>
        <div
          style={{
            backgroundColor: "color-mix(in srgb, var(--card) 50%, transparent)",
            border: "1px solid var(--border)",
            borderRadius: "0.75rem",
            padding: "1rem",
            display: "flex",
            alignItems: "center",
            gap: "1rem",
          }}
        >
          <div
            style={{
              padding: "0.75rem",
              backgroundColor:
                "color-mix(in srgb, var(--success) 20%, transparent)",
              borderRadius: "0.5rem",
            }}
          >
            <RefreshCw
              className="w-6 h-6"
              style={{ color: "var(--success)" }}
            />
          </div>
          <div>
            <p
              style={{
                fontSize: "1.5rem",
                fontWeight: 700,
                color: "var(--text-primary)",
              }}
            >
              {activeJobs}
            </p>
            <p
              style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}
            >
              Ativos
            </p>
          </div>
        </div>
        <div
          style={{
            backgroundColor: "color-mix(in srgb, var(--card) 50%, transparent)",
            border: "1px solid var(--border)",
            borderRadius: "0.75rem",
            padding: "1rem",
            display: "flex",
            alignItems: "center",
            gap: "1rem",
          }}
        >
          <div
            style={{
              padding: "0.75rem",
              backgroundColor:
                "color-mix(in srgb, var(--warning) 20%, transparent)",
              borderRadius: "0.5rem",
            }}
          >
            <AlertCircle
              className="w-6 h-6"
              style={{ color: "var(--warning)" }}
            />
          </div>
          <div>
            <p
              style={{
                fontSize: "1.5rem",
                fontWeight: 700,
                color: "var(--text-primary)",
              }}
            >
              {pausedJobs}
            </p>
            <p
              style={{ fontSize: "0.875rem", color: "var(--text-secondary)" }}
            >
              Pausados
            </p>
          </div>
        </div>
      </div>

      {/* Toolbar: Search, Filters, Sort, Group */}
      <div
        className="flex flex-col md:flex-row gap-3 mb-4 md:mb-6"
        style={{
          backgroundColor: "color-mix(in srgb, var(--card) 50%, transparent)",
          border: "1px solid var(--border)",
          borderRadius: "0.75rem",
          padding: "0.75rem 1rem",
        }}
      >
        {/* Search */}
        <div className="relative flex-1 min-w-0">
          <Search
            className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4"
            style={{ color: "var(--text-muted)" }}
          />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Buscar por nome, agente, descrição..."
            className="w-full text-sm"
            style={{
              padding: "0.5rem 0.75rem 0.5rem 2.25rem",
              backgroundColor: "var(--card-elevated)",
              border: "1px solid var(--border)",
              borderRadius: "0.5rem",
              color: "var(--text-primary)",
              outline: "none",
            }}
          />
        </div>

        {/* Filter toggle */}
        <button
          onClick={() => setShowFilters((s) => !s)}
          className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg"
          style={{
            backgroundColor: showFilters
              ? "color-mix(in srgb, var(--accent) 15%, transparent)"
              : "var(--card-elevated)",
            color: showFilters ? "var(--accent)" : "var(--text-secondary)",
            border: "1px solid var(--border)",
            cursor: "pointer",
            fontWeight: 500,
          }}
        >
          <Filter className="w-4 h-4" />
          Filtros
        </button>
      </div>

      {/* Expanded filters */}
      {showFilters && (
        <div
          className="flex flex-wrap gap-3 mb-4 md:mb-6"
          style={{
            backgroundColor: "color-mix(in srgb, var(--card) 30%, transparent)",
            border: "1px solid var(--border)",
            borderRadius: "0.75rem",
            padding: "0.75rem 1rem",
          }}
        >
          {/* Status pills */}
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
              Status:
            </span>
            {(["all", "active", "paused"] as StatusFilter[]).map((s) => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className="px-2.5 py-1 text-xs rounded-full font-medium"
                style={{
                  backgroundColor:
                    statusFilter === s
                      ? "color-mix(in srgb, var(--accent) 20%, transparent)"
                      : "var(--card-elevated)",
                  color:
                    statusFilter === s ? "var(--accent)" : "var(--text-secondary)",
                  border: "1px solid",
                  borderColor:
                    statusFilter === s
                      ? "color-mix(in srgb, var(--accent) 40%, transparent)"
                      : "var(--border)",
                  cursor: "pointer",
                  textTransform: "capitalize",
                }}
              >
                {s === "all"
                  ? "Todos"
                  : s === "active"
                  ? "Ativos"
                  : "Pausados"}
              </button>
            ))}
          </div>

          {/* Sort */}
          <div className="flex items-center gap-2">
            <ArrowUpDown className="w-3.5 h-3.5" style={{ color: "var(--text-muted)" }} />
            <select
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortBy)}
              className="text-xs rounded-md px-2 py-1"
              style={{
                backgroundColor: "var(--card-elevated)",
                color: "var(--text-secondary)",
                border: "1px solid var(--border)",
                outline: "none",
              }}
            >
              <option value="nextRun">Próx. execução</option>
              <option value="lastRun">Últ. execução</option>
              <option value="name">Nome</option>
              <option value="agentId">Agente</option>
            </select>
            <button
              onClick={() => setSortOrder((o) => (o === "asc" ? "desc" : "asc"))}
              className="text-xs px-2 py-1 rounded-md"
              style={{
                backgroundColor: "var(--card-elevated)",
                color: "var(--text-secondary)",
                border: "1px solid var(--border)",
                cursor: "pointer",
              }}
            >
              {sortOrder === "asc" ? "↑" : "↓"}
            </button>
          </div>

          {/* Group by agent */}
          <button
            onClick={() => setGroupByAgent((g) => !g)}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-full font-medium"
            style={{
              backgroundColor: groupByAgent
                ? "color-mix(in srgb, var(--info) 20%, transparent)"
                : "var(--card-elevated)",
              color: groupByAgent ? "var(--info)" : "var(--text-secondary)",
              border: "1px solid",
              borderColor: groupByAgent
                ? "color-mix(in srgb, var(--info) 40%, transparent)"
                : "var(--border)",
              cursor: "pointer",
            }}
          >
            <Users className="w-3.5 h-3.5" />
            Agrupar por Agente
          </button>

          {/* Results count */}
          <div className="ml-auto flex items-center">
            <span className="text-xs" style={{ color: "var(--text-muted)" }}>
              {processedJobs.length} resultado
              {processedJobs.length !== 1 ? "s" : ""}
            </span>
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div
          style={{
            marginBottom: "1.5rem",
            padding: "1rem",
            backgroundColor: "color-mix(in srgb, var(--error) 10%, transparent)",
            border: "1px solid color-mix(in srgb, var(--error) 30%, transparent)",
            borderRadius: "0.5rem",
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
          }}
        >
          <AlertCircle className="w-5 h-5" style={{ color: "var(--error)" }} />
          <span style={{ color: "var(--error)" }}>{error}</span>
          <button
            onClick={() => setError(null)}
            style={{
              marginLeft: "auto",
              color: "var(--error)",
              background: "none",
              border: "none",
              cursor: "pointer",
            }}
          >
            Fechar
          </button>
        </div>
      )}

      {/* Stale warning */}
      {isStale && !error && !isLoading && (
        <div
          style={{
            marginBottom: "1.5rem",
            padding: "0.75rem 1rem",
            backgroundColor: "color-mix(in srgb, var(--warning) 10%, transparent)",
            border: "1px solid color-mix(in srgb, var(--warning) 30%, transparent)",
            borderRadius: "0.5rem",
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
          }}
        >
          <AlertCircle className="w-4 h-4" style={{ color: "var(--warning)" }} />
          <span className="text-sm" style={{ color: "var(--warning)" }}>
            Os dados podem estar desatualizados. Clique em Atualizar.
          </span>
        </div>
      )}

      {/* Loading */}
      {isLoading && jobs.length === 0 ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "3rem 0",
          }}
        >
          <div
            style={{
              width: "2rem",
              height: "2rem",
              border: "2px solid var(--accent)",
              borderTopColor: "transparent",
              borderRadius: "50%",
              animation: "spin 1s linear infinite",
            }}
          />
        </div>
      ) : processedJobs.length === 0 ? (
        <div style={{ textAlign: "center", padding: "4rem 0" }}>
          <Clock className="w-8 h-8 mx-auto mb-4" style={{ color: "var(--text-muted)" }} />
          <h3
            style={{
              fontSize: "1.125rem",
              fontWeight: 500,
              color: "var(--text-primary)",
              marginBottom: "0.5rem",
            }}
          >
            {jobs.length === 0
              ? "Nenhuma tarefa agendada encontrada"
              : "Nenhuma tarefa corresponde aos filtros"}
          </h3>
          <p style={{ color: "var(--text-secondary)" }}>
            {jobs.length === 0
              ? "Crie tarefas via Telegram ou OpenClaw CLI"
              : "Tente ajustar a busca ou os filtros"}
          </p>
          {jobs.length > 0 && (
            <button
              onClick={() => {
                setSearchQuery("");
                setStatusFilter("all");
              }}
              className="mt-4 text-sm font-medium"
              style={{
                color: "var(--accent)",
                background: "none",
                border: "none",
                cursor: "pointer",
              }}
            >
              Limpar filtros
            </button>
          )}
        </div>
      ) : viewMode === "timeline" ? (
        /* Timeline View */
        <div
          className="rounded-xl overflow-hidden"
          style={{
            backgroundColor: "var(--card)",
            border: "1px solid var(--border)",
            padding: "1.25rem",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.75rem",
              marginBottom: "1.25rem",
              paddingBottom: "1rem",
              borderBottom: "1px solid var(--border)",
            }}
          >
            <CalendarDays className="w-5 h-5" style={{ color: "var(--accent)" }} />
            <h2
              style={{
                fontSize: "1rem",
                fontWeight: 700,
                color: "var(--text-primary)",
                fontFamily: "var(--font-heading)",
              }}
            >
              Programação dos Próximos 7 Dias
            </h2>
            <span
              style={{
                marginLeft: "auto",
                fontSize: "0.75rem",
                color: "var(--text-muted)",
                backgroundColor: "var(--card-elevated)",
                padding: "0.25rem 0.6rem",
                borderRadius: "0.35rem",
              }}
            >
              Horários no fuso local
            </span>
          </div>
          <CronWeeklyTimeline jobs={processedJobs} />
        </div>
      ) : groupByAgent && groupedJobs ? (
        /* Grouped Cards View */
        <div className="flex flex-col gap-6">
          {groupedJobs.map(([agentId, agentJobs]) => (
            <AgentGroup
              key={agentId}
              agentId={agentId}
              jobs={agentJobs}
              deleteConfirm={deleteConfirm}
              setDeleteConfirm={setDeleteConfirm}
              onToggle={handleToggle}
              onDelete={handleDelete}
              onRun={handleRun}
            />
          ))}
        </div>
      ) : (
        /* Flat Cards View */
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4">
          {processedJobs.map((job) => (
            <div key={job.id} style={{ position: "relative" }}>
              <CronJobCard
                job={job}
                onToggle={handleToggle}
                onEdit={() => {}}
                onDelete={handleDelete}
                onRun={handleRun}
              />
              {deleteConfirm === job.id && (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    backgroundColor: "rgba(12, 12, 12, 0.9)",
                    borderRadius: "0.75rem",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    backdropFilter: "blur(4px)",
                    zIndex: 10,
                  }}
                >
                  <div style={{ textAlign: "center" }}>
                    <p style={{ color: "var(--text-primary)", marginBottom: "1rem" }}>
                      Excluir &quot;{job.name}&quot;?
                    </p>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.75rem",
                      }}
                    >
                      <button
                        onClick={() => setDeleteConfirm(null)}
                        style={{
                          padding: "0.5rem 1rem",
                          color: "var(--text-secondary)",
                          background: "none",
                          border: "none",
                          borderRadius: "0.5rem",
                          cursor: "pointer",
                        }}
                      >
                        Cancelar
                      </button>
                      <button
                        onClick={() => handleDelete(job.id)}
                        style={{
                          padding: "0.5rem 1rem",
                          backgroundColor: "var(--error)",
                          color: "var(--text-primary)",
                          border: "none",
                          borderRadius: "0.5rem",
                          cursor: "pointer",
                        }}
                      >
                        Excluir
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Run toast notification */}
      {runToast && (
        <div
          style={{
            position: "fixed",
            bottom: "2.5rem",
            right: "1.5rem",
            zIndex: 100,
            display: "flex",
            alignItems: "center",
            gap: "0.75rem",
            padding: "0.875rem 1.25rem",
            borderRadius: "0.75rem",
            backdropFilter: "blur(12px)",
            backgroundColor:
              runToast.status === "success"
                ? "color-mix(in srgb, var(--success) 15%, rgba(12,12,12,0.95))"
                : "color-mix(in srgb, var(--error) 15%, rgba(12,12,12,0.95))",
            border: `1px solid ${
              runToast.status === "success"
                ? "color-mix(in srgb, var(--success) 40%, transparent)"
                : "color-mix(in srgb, var(--error) 40%, transparent)"
            }`,
            boxShadow: "0 8px 32px rgba(0,0,0,0.4)",
            color: "var(--text-primary)",
            fontSize: "0.875rem",
            fontWeight: 500,
            animation: "slideInRight 0.3s ease",
          }}
        >
          <Zap
            className="w-4 h-4"
            style={{
              color:
                runToast.status === "success"
                  ? "var(--success)"
                  : "var(--error)",
            }}
          />
          {runToast.status === "success"
            ? `✓ "${runToast.name}" disparado!`
            : `✗ Falha ao disparar "${runToast.name}"`}
        </div>
      )}

      <style jsx global>{`
        @keyframes slideInRight {
          from {
            transform: translateX(2rem);
            opacity: 0;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }
      `}</style>
    </div>
  );
}

// Agent group sub-component
function AgentGroup({
  agentId,
  jobs,
  deleteConfirm,
  setDeleteConfirm,
  onToggle,
  onDelete,
  onRun,
}: {
  agentId: string;
  jobs: CronJob[];
  deleteConfirm: string | null;
  setDeleteConfirm: (id: string | null) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
  onRun: (id: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(true);

  const AGENT_EMOJI: Record<string, string> = {
    main: "🦞",
    academic: "🎓",
    infra: "🔧",
    studio: "🎬",
    social: "📱",
    linkedin: "💼",
    freelance: "💼",
  };

  const emoji = AGENT_EMOJI[agentId] || "🤖";
  const activeCount = jobs.filter((j) => j.enabled).length;

  return (
    <div
      style={{
        backgroundColor: "color-mix(in srgb, var(--card) 50%, transparent)",
        border: "1px solid var(--border)",
        borderRadius: "0.75rem",
        overflow: "hidden",
      }}
    >
      {/* Group header */}
      <button
        onClick={() => setExpanded((e) => !e)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left"
        style={{
          backgroundColor: "color-mix(in srgb, var(--card) 80%, transparent)",
          border: "none",
          borderBottom: expanded ? "1px solid var(--border)" : "none",
          cursor: "pointer",
        }}
      >
        <span className="text-lg">{emoji}</span>
        <span
          className="font-semibold text-sm"
          style={{
            color: "var(--text-primary)",
            fontFamily: "var(--font-heading)",
          }}
        >
          {agentId}
        </span>
        <span
          className="text-xs px-2 py-0.5 rounded-full"
          style={{
            backgroundColor: "var(--card-elevated)",
            color: "var(--text-muted)",
          }}
        >
          {jobs.length} tarefa{jobs.length !== 1 ? "s" : ""} · {activeCount} ativa
          {activeCount !== 1 ? "s" : ""}
        </span>
        {expanded ? (
          <ChevronDown className="w-4 h-4 ml-auto" style={{ color: "var(--text-muted)" }} />
        ) : (
          <ChevronRight className="w-4 h-4 ml-auto" style={{ color: "var(--text-muted)" }} />
        )}
      </button>

      {/* Group content */}
      {expanded && (
        <div className="p-3 md:p-4 grid grid-cols-1 lg:grid-cols-2 gap-3 md:gap-4">
          {jobs.map((job) => (
            <div key={job.id} style={{ position: "relative" }}>
              <CronJobCard
                job={job}
                onToggle={onToggle}
                onEdit={() => {}}
                onDelete={onDelete}
                onRun={onRun}
              />
              {deleteConfirm === job.id && (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    backgroundColor: "rgba(12, 12, 12, 0.9)",
                    borderRadius: "0.75rem",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    backdropFilter: "blur(4px)",
                    zIndex: 10,
                  }}
                >
                  <div style={{ textAlign: "center" }}>
                    <p
                      style={{
                        color: "var(--text-primary)",
                        marginBottom: "1rem",
                      }}
                    >
                      Excluir &quot;{job.name}&quot;?
                    </p>
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "0.75rem",
                      }}
                    >
                      <button
                        onClick={() => setDeleteConfirm(null)}
                        style={{
                          padding: "0.5rem 1rem",
                          color: "var(--text-secondary)",
                          background: "none",
                          border: "none",
                          borderRadius: "0.5rem",
                          cursor: "pointer",
                        }}
                      >
                        Cancelar
                      </button>
                      <button
                        onClick={() => onDelete(job.id)}
                        style={{
                          padding: "0.5rem 1rem",
                          backgroundColor: "var(--error)",
                          color: "var(--text-primary)",
                          border: "none",
                          borderRadius: "0.5rem",
                          cursor: "pointer",
                        }}
                      >
                        Excluir
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
