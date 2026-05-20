"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { DollarSign, AlertTriangle, RefreshCw, Wifi, WifiOff, Terminal } from "lucide-react";
import Link from "next/link";

interface CostSummary {
  today: number;
  thisMonth: number;
  budget: number;
}

interface CollectionInfo {
  status: "fresh" | "cached" | "stale" | "unavailable" | "empty";
  lastSnapshotAt: number | null;
  error: string | null;
}

interface Diagnostics {
  bin: string;
  resolvedPath: string | null;
  binExists: boolean;
  openclawDir: string;
  openclawWorkspace: string;
  pathEnv: string;
  platform: string;
}

export function CostWidget() {
  const [data, setData] = useState<CostSummary | null>(null);
  const [collection, setCollection] = useState<CollectionInfo | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const cycleRef = useRef(0);

  const load = useCallback((forceRefresh = false) => {
    setIsLoading(true);
    const url = forceRefresh ? "/api/costs?refresh=1" : "/api/costs";
    fetch(url)
      .then((r) => r.json())
      .then((d) => {
        if (d.error) return;
        setData({
          today: d.today ?? 0,
          thisMonth: d.thisMonth ?? 0,
          budget: d.budget ?? 100,
        });
        setCollection({
          status: d.collection?.status ?? "unknown",
          lastSnapshotAt: d.collection?.lastSnapshotAt ?? null,
          error: d.collection?.error ?? null,
        });
        setDiagnostics(d.diagnostics ?? null);
        setLastUpdated(new Date());
      })
      .catch(() => {})
      .finally(() => setIsLoading(false));
  }, []);

  useEffect(() => {
    load(true);
    const id = setInterval(() => {
      cycleRef.current += 1;
      const force = cycleRef.current % 4 === 0;
      load(force);
    }, 15_000);
    return () => clearInterval(id);
  }, [load]);

  if (!data) return null;

  const pct = Math.min((data.thisMonth / data.budget) * 100, 100);
  const barColor =
    pct < 60 ? "var(--success)" : pct < 85 ? "var(--warning)" : "var(--error)";

  const hasIssue =
    collection?.status === "unavailable" ||
    collection?.status === "empty" ||
    collection?.status === "stale" ||
    !!collection?.error;

  const statusIcon =
    collection?.status === "fresh" || collection?.status === "cached" ? (
      <Wifi className="w-3 h-3" style={{ color: "var(--success)" }} />
    ) : (
      <WifiOff className="w-3 h-3" style={{ color: "var(--warning)" }} />
    );

  const timeString = lastUpdated
    ? lastUpdated.toLocaleTimeString("pt-BR", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "--:--:--";

  return (
    <div
      className="flex flex-col gap-2 px-4 py-3 rounded-xl transition-all"
      style={{
        backgroundColor: "var(--card)",
        border: "1px solid var(--border)",
      }}
    >
      <Link
        href="/costs"
        className="flex items-center gap-3 md:gap-4 flex-wrap"
        style={{ textDecoration: "none" }}
      >
        <DollarSign
          className="w-4 h-4 flex-shrink-0"
          style={{ color: "var(--text-muted)" }}
        />

        <div className="flex items-center gap-1.5">
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            Hoje:
          </span>
          <span
            className="text-sm font-bold"
            style={{ color: "var(--text-primary)" }}
          >
            ${data.today.toFixed(2)}
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-xs" style={{ color: "var(--text-muted)" }}>
            Este mês:
          </span>
          <span
            className="text-sm font-bold"
            style={{ color: "var(--text-primary)" }}
          >
            ${data.thisMonth.toFixed(2)}
          </span>
        </div>

        <div className="flex items-center gap-2 flex-1">
          <span
            className="text-xs hidden sm:inline"
            style={{ color: "var(--text-muted)" }}
          >
            Orçamento:
          </span>
          <div
            className="flex-1 h-1.5 rounded-full overflow-hidden"
            style={{ backgroundColor: "var(--card-elevated)", maxWidth: "120px" }}
          >
            <div
              className="h-full transition-all duration-500"
              style={{ width: `${pct}%`, backgroundColor: barColor }}
            />
          </div>
          <span className="text-xs font-semibold" style={{ color: barColor }}>
            {pct.toFixed(0)}%
          </span>
          {pct >= 80 && (
            <AlertTriangle
              className="w-3.5 h-3.5 flex-shrink-0"
              style={{ color: "var(--error)" }}
            />
          )}
        </div>

        <div className="flex items-center gap-3 ml-auto">
          <div
            className="flex flex-col items-end"
            style={{
              padding: "0.25rem 0.75rem",
              backgroundColor: "rgba(255,255,255,0.03)",
              borderRadius: "0.5rem",
              border: "1px solid var(--border)",
            }}
          >
            <span className="text-[0.65rem]" style={{ color: "var(--text-muted)" }}>
              Custo mensal
            </span>
            <span
              className="text-sm font-bold"
              style={{ color: "var(--text-primary)", lineHeight: 1 }}
            >
              ${data.thisMonth.toFixed(2)}
            </span>
          </div>

          <span
            className="text-xs flex-shrink-0"
            style={{ color: "var(--accent)" }}
          >
            Ver custos →
          </span>
        </div>
      </Link>

      {/* Status / realtime */}
      <div className="flex items-center justify-between">
        <div
          className="flex items-center gap-2 text-[0.7rem]"
          style={{ color: "var(--text-muted)" }}
        >
          <span className="flex items-center gap-1">
            {statusIcon}
            {collection?.status === "fresh"
              ? "Dados em tempo real"
              : collection?.status === "cached"
              ? "Dados em cache"
              : collection?.status === "stale"
              ? "Dados desatualizados"
              : collection?.status === "unavailable"
              ? "OpenClaw indisponível"
              : collection?.status === "empty"
              ? "Sem dados de custo"
              : "Status desconhecido"}
          </span>
          {collection?.error && (
            <span
              className="hidden sm:inline max-w-[300px] truncate"
              style={{ color: "var(--warning)" }}
              title={collection.error}
            >
              ({collection.error.length > 50 ? collection.error.slice(0, 50) + "…" : collection.error})
            </span>
          )}
        </div>

        <div
          className="flex items-center gap-1.5 text-[0.7rem]"
          style={{ color: "var(--text-muted)" }}
        >
          <RefreshCw
            className={`w-3 h-3 ${isLoading ? "animate-spin" : ""}`}
          />
          <span>Atualizado às {timeString}</span>
        </div>
      </div>

      {/* Diagnostics panel */}
      {hasIssue && diagnostics && (
        <div
          className="mt-1 rounded-lg overflow-hidden"
          style={{ border: "1px solid var(--border)" }}
        >
          <button
            onClick={() => setShowDiagnostics((s) => !s)}
            className="flex items-center gap-2 w-full px-3 py-2 text-left text-[0.7rem]"
            style={{
              backgroundColor: "rgba(255,193,7,0.05)",
              color: "var(--warning)",
            }}
          >
            <Terminal className="w-3 h-3" />
            <span className="font-semibold">
              {showDiagnostics ? "Ocultar diagnóstico" : "Mostrar diagnóstico do OpenClaw"}
            </span>
          </button>

          {showDiagnostics && (
            <div
              className="px-3 py-2 text-[0.7rem] space-y-1"
              style={{
                backgroundColor: "var(--card-elevated)",
                color: "var(--text-secondary)",
              }}
            >
              <div>
                <span style={{ color: "var(--text-muted)" }}>Binário configurado:</span>{" "}
                <code style={{ color: "var(--text-primary)" }}>{diagnostics.bin}</code>
              </div>
              <div>
                <span style={{ color: "var(--text-muted)" }}>Caminho resolvido:</span>{" "}
                <code style={{ color: diagnostics.resolvedPath ? "var(--success)" : "var(--error)" }}>
                  {diagnostics.resolvedPath || "NÃO ENCONTRADO NO PATH"}
                </code>
              </div>
              <div>
                <span style={{ color: "var(--text-muted)" }}>Arquivo existe:</span>{" "}
                <span style={{ color: diagnostics.binExists ? "var(--success)" : "var(--error)" }}>
                  {diagnostics.binExists ? "Sim" : "Não"}
                </span>
              </div>
              <div>
                <span style={{ color: "var(--text-muted)" }}>Diretório:</span>{" "}
                <code>{diagnostics.openclawDir}</code>
              </div>
              <div>
                <span style={{ color: "var(--text-muted)" }}>Workspace:</span>{" "}
                <code>{diagnostics.openclawWorkspace}</code>
              </div>
              <div>
                <span style={{ color: "var(--text-muted)" }}>Plataforma:</span>{" "}
                <code>{diagnostics.platform}</code>
              </div>
              <div className="pt-1" style={{ borderTop: "1px solid var(--border)" }}>
                <span style={{ color: "var(--text-muted)" }}>PATH:</span>
                <div className="mt-0.5 break-all" style={{ color: "var(--text-muted)", fontSize: "0.6rem" }}>
                  {diagnostics.pathEnv}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
