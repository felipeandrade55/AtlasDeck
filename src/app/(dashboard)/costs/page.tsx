"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Activity,
  Clock,
  Database,
  DollarSign,
  Hash,
  PieChart as PieChartIcon,
  RefreshCw,
  Save,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

interface CostData {
  today: number;
  yesterday: number;
  thisMonth: number;
  lastMonth: number;
  projected: number;
  budget: number;
  alertThreshold: number;
  totals: { cost: number; tokens: number; inputTokens: number; outputTokens: number };
  byAgent: Array<{ agent: string; cost: number; tokens: number; inputTokens: number; outputTokens: number; percentOfTotal: number }>;
  byModel: Array<{ model: string; cost: number; tokens: number; inputTokens: number; outputTokens: number; percentOfTotal: number }>;
  bySession: Array<{ sessionKey: string; sessionId: string | null; agent: string; model: string; cost: number; tokens: number; inputTokens: number; outputTokens: number; lastSeenAt: number }>;
  daily: Array<{ date: string; dateIso: string; cost: number; input: number; output: number }>;
  hourly: Array<{ hour: string; timestamp: number; cost: number }>;
  pricing: Array<{ id: string; name: string; alias: string | null; input: number; output: number; contextWindow: number }>;
  collection: {
    status: "fresh" | "cached" | "stale" | "unavailable" | "empty";
    error: string | null;
    lastCollectedAt: number | null;
    lastCollectionSource: string | null;
    lastSessionsSeen: number;
    lastSnapshotsInserted: number;
    lastSnapshotAt: number | null;
    storedSnapshots: number;
    trackedSessions: number;
    autoCollectIntervalMs: number;
    lastRun: {
      collectedAt: number;
      source: string;
      sessionsSeen: number;
      snapshotsInserted: number;
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      cost: number;
    } | null;
  };
}

const COLORS = ["#FF3B30", "#FF9500", "#FFCC00", "#34C759", "#00C7BE", "#32ADE6", "#007AFF", "#5856D6", "#AF52DE", "#FF2D55"];

const tooltipStyle = {
  backgroundColor: "var(--card-elevated)",
  border: "1px solid var(--border)",
  borderRadius: "8px",
  color: "var(--text-primary)",
};

function money(value: number): string {
  const safe = Number.isFinite(value) ? value : 0;
  return `$${safe.toFixed(2)}`;
}

function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

function percent(value: number, total: number): number {
  return total > 0 ? (value / total) * 100 : 0;
}

function changePercent(current: number, previous: number): number | null {
  if (previous <= 0) return current > 0 ? null : 0;
  return ((current - previous) / previous) * 100;
}

function shortModel(model: string): string {
  const clean = model.replace("openai/", "").replace("anthropic/", "").replace("google/", "").replace("claude-", "");
  return clean
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
    .replace("Gpt", "GPT");
}

function shortSession(key: string): string {
  if (key.length <= 36) return key;
  const parts = key.split(":").filter(Boolean);
  return parts.length >= 3 ? parts.slice(0, 4).join(":") : `${key.slice(0, 18)}...${key.slice(-10)}`;
}

function formatTimestamp(timestamp: number | null): string {
  if (!timestamp) return "Nunca";
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function collectionLabel(status: CostData["collection"]["status"]): { label: string; color: string } {
  switch (status) {
    case "fresh":
      return { label: "Atualizado agora", color: "var(--success)" };
    case "cached":
      return { label: "Em cache", color: "var(--accent)" };
    case "stale":
      return { label: "Coleta com falha", color: "var(--warning)" };
    case "unavailable":
      return { label: "OpenClaw indisponível", color: "var(--error)" };
    default:
      return { label: "Sem dados", color: "var(--text-muted)" };
  }
}

function KpiCard({
  label,
  value,
  detail,
  change,
  tone,
}: {
  label: string;
  value: string;
  detail: string;
  change?: number | null;
  tone?: string;
}) {
  const hasChange = typeof change === "number" && Number.isFinite(change) && change !== 0;
  const positive = hasChange && change > 0;

  return (
    <div className="p-6 rounded-xl" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
      <div className="flex items-center justify-between gap-3 mb-2">
        <span className="text-sm" style={{ color: "var(--text-secondary)" }}>{label}</span>
        {hasChange && (
          <div className="flex items-center gap-1">
            {positive ? (
              <TrendingUp className="w-3 h-3" style={{ color: "var(--error)" }} />
            ) : (
              <TrendingDown className="w-3 h-3" style={{ color: "var(--success)" }} />
            )}
            <span className="text-xs font-medium" style={{ color: positive ? "var(--error)" : "var(--success)" }}>
              {Math.abs(change).toFixed(1)}%
            </span>
          </div>
        )}
      </div>
      <div className="text-3xl font-bold" style={{ color: tone ?? "var(--text-primary)" }}>
        {value}
      </div>
      <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>{detail}</p>
    </div>
  );
}

function EmptyPanel({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center h-[300px] rounded-lg" style={{ backgroundColor: "var(--card-elevated)", color: "var(--text-muted)" }}>
      {label}
    </div>
  );
}

export default function CostsPage() {
  const [costData, setCostData] = useState<CostData | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timeframe, setTimeframe] = useState<"7d" | "30d" | "90d">("30d");
  const [budgetDraft, setBudgetDraft] = useState("100");
  const [alertDraft, setAlertDraft] = useState("80");

  const fetchCostData = useCallback(async (force = false) => {
    if (force) setRefreshing(true);
    setError(null);

    try {
      const res = await fetch(`/api/costs?timeframe=${timeframe}${force ? "&refresh=1" : ""}`, { cache: "no-store" });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.detail || data?.error || "Falha ao carregar dados de custo");
      }
      setCostData(data);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Falha ao carregar dados de custo");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [timeframe]);

  useEffect(() => {
    fetchCostData();
    const interval = setInterval(() => fetchCostData(), 60_000);
    return () => clearInterval(interval);
  }, [fetchCostData]);

  useEffect(() => {
    if (!costData || settingsDirty) return;
    setBudgetDraft(String(costData.budget));
    setAlertDraft(String(costData.alertThreshold));
  }, [costData, settingsDirty]);

  const saveSettings = async () => {
    setSavingSettings(true);
    setError(null);

    try {
      const res = await fetch("/api/costs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          budget: Number(budgetDraft),
          alertThreshold: Number(alertDraft),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.detail || data?.error || "Falha ao salvar orçamento");
      }
      setSettingsDirty(false);
      await fetchCostData(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Falha ao salvar orçamento");
    } finally {
      setSavingSettings(false);
    }
  };

  const derived = useMemo(() => {
    if (!costData) return null;

    const budgetPercent = percent(costData.thisMonth, costData.budget);
    const budgetColor = budgetPercent < 60 ? "var(--success)" : budgetPercent < costData.alertThreshold ? "var(--warning)" : "var(--error)";
    const status = collectionLabel(costData.collection.status);

    return {
      budgetPercent,
      budgetColor,
      status,
      todayChange: changePercent(costData.today, costData.yesterday),
      monthChange: changePercent(costData.thisMonth, costData.lastMonth),
      hasUsage: costData.totals.tokens > 0 || costData.totals.cost > 0,
    };
  }, [costData]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 mx-auto mb-4" style={{ borderColor: "var(--accent)" }} />
          <p style={{ color: "var(--text-secondary)" }}>Carregando custos...</p>
        </div>
      </div>
    );
  }

  if (!costData || !derived) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <div className="text-center max-w-lg">
          <DollarSign className="w-16 h-16 mx-auto mb-4" style={{ color: "var(--text-muted)" }} />
          <p style={{ color: "var(--text-secondary)" }}>{error || "Falha ao carregar dados de custo"}</p>
          <button
            type="button"
            onClick={() => fetchCostData(true)}
            className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all"
            style={{ backgroundColor: "var(--accent)", color: "white" }}
          >
            <RefreshCw className="w-4 h-4" />
            Tentar novamente
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-3">
            <h1
              className="text-3xl font-bold"
              style={{
                fontFamily: "var(--font-heading)",
                color: "var(--text-primary)",
              }}
            >
              Custos & Analytics
            </h1>
            <span
              className="inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold"
              style={{ color: derived.status.color, backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
            >
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: derived.status.color }} />
              {derived.status.label}
            </span>
          </div>
          <p className="mt-2" style={{ color: "var(--text-secondary)" }}>
            Monitoramento real de tokens, custos, agentes, modelos e sessões.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => fetchCostData(true)}
            disabled={refreshing}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-all disabled:opacity-60"
            style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
          >
            <RefreshCw className={`w-4 h-4 ${refreshing ? "animate-spin" : ""}`} />
            Atualizar
          </button>

          <div className="flex gap-2 p-1 rounded-lg" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
            {(["7d", "30d", "90d"] as const).map((tf) => (
              <button
                key={tf}
                type="button"
                onClick={() => setTimeframe(tf)}
                className="px-4 py-2 rounded-md text-sm font-medium transition-all"
                style={{
                  backgroundColor: timeframe === tf ? "var(--accent)" : "transparent",
                  color: timeframe === tf ? "white" : "var(--text-secondary)",
                }}
              >
                {tf === "7d" ? "7 dias" : tf === "30d" ? "30 dias" : "90 dias"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {(error || costData.collection.error || !derived.hasUsage) && (
        <div
          className="flex flex-col gap-3 rounded-xl p-5 text-sm"
          style={{ backgroundColor: "var(--card)", border: `1px solid ${error || costData.collection.error ? "var(--warning)" : "var(--border)"}` }}
        >
          <div className="flex items-center gap-2 font-semibold" style={{ color: error || costData.collection.error ? "var(--warning)" : "var(--text-primary)" }}>
            <AlertTriangle className="w-4 h-4 flex-shrink-0" />
            {error || costData.collection.error
              ? costData.collection.status === "unavailable"
                ? "OpenClaw não está acessível"
                : "Coleta parcial de custos"
              : "Aguardando uso registrado"}
          </div>
          <p style={{ color: "var(--text-secondary)" }}>
            {error || costData.collection.error
              ? costData.collection.status === "unavailable"
                ? "Não foi possível conectar ao OpenClaw para coletar dados de uso. Verifique se o OpenClaw está instalado e configurado corretamente."
                : "A coleta de custos encontrou um problema, mas dados anteriores ainda estão disponíveis."
              : "A API de custos está pronta, mas ainda não há deltas de tokens salvos no banco local."}
          </p>
          <div className="flex flex-wrap items-center gap-3">
            {(costData.collection.status === "unavailable" || error) && (
              <a
                href="/costs"
                onClick={(e) => {
                  e.preventDefault();
                  window.open("/api/openclaw/config?test=1", "_blank");
                }}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                style={{ backgroundColor: "var(--card-elevated)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
              >
                🔧 Diagnóstico OpenClaw
              </a>
            )}
            {(error || costData.collection.error) && (
              <details className="text-xs w-full">
                <summary className="cursor-pointer select-none" style={{ color: "var(--text-muted)" }}>
                  Detalhes técnicos
                </summary>
                <pre
                  className="mt-2 p-3 rounded-lg overflow-x-auto whitespace-pre-wrap break-all"
                  style={{ backgroundColor: "var(--card-elevated)", color: "var(--text-muted)", fontSize: "11px", lineHeight: "1.5" }}
                >
                  {error || costData.collection.error}
                </pre>
              </details>
            )}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <KpiCard
          label="Hoje"
          value={money(costData.today)}
          detail={`vs ${money(costData.yesterday)} ontem`}
          change={derived.todayChange}
        />
        <KpiCard
          label="Este mês"
          value={money(costData.thisMonth)}
          detail={`vs ${money(costData.lastMonth)} mês passado`}
          change={derived.monthChange}
        />
        <KpiCard
          label="Projetado"
          value={money(costData.projected)}
          detail="Estimativa para o fim do mês"
          tone="var(--warning)"
        />
        <div className="p-6 rounded-xl" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm" style={{ color: "var(--text-secondary)" }}>Orçamento</span>
            {derived.budgetPercent >= costData.alertThreshold && (
              <AlertTriangle className="w-4 h-4" style={{ color: "var(--error)" }} />
            )}
          </div>
          <div className="text-3xl font-bold" style={{ color: derived.budgetColor }}>
            {derived.budgetPercent.toFixed(0)}%
          </div>
          <div className="mt-2 h-2 rounded-full overflow-hidden" style={{ backgroundColor: "var(--card-elevated)" }}>
            <div
              className="h-full transition-all duration-500"
              style={{ width: `${Math.min(derived.budgetPercent, 100)}%`, backgroundColor: derived.budgetColor }}
            />
          </div>
          <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>
            {money(costData.thisMonth)} / {money(costData.budget)}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        {[
          { icon: Hash, label: "Tokens no período", value: compactNumber(costData.totals.tokens), detail: `${compactNumber(costData.totals.inputTokens)} entrada / ${compactNumber(costData.totals.outputTokens)} saída` },
          { icon: Activity, label: "Sessões rastreadas", value: String(costData.collection.trackedSessions), detail: `${costData.collection.storedSnapshots} snapshots salvos` },
          { icon: Database, label: "Última coleta", value: formatTimestamp(costData.collection.lastCollectedAt), detail: `${costData.collection.lastSessionsSeen} sessões vistas` },
          { icon: Clock, label: "Último delta", value: formatTimestamp(costData.collection.lastSnapshotAt), detail: `${costData.collection.lastSnapshotsInserted} deltas na última coleta` },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.label} className="p-4 rounded-xl" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
              <div className="flex items-center gap-2 mb-2">
                <Icon className="w-4 h-4" style={{ color: "var(--accent)" }} />
                <span className="text-sm" style={{ color: "var(--text-secondary)" }}>{item.label}</span>
              </div>
              <div className="text-lg font-bold" style={{ color: "var(--text-primary)" }}>{item.value}</div>
              <p className="text-xs mt-1" style={{ color: "var(--text-muted)" }}>{item.detail}</p>
            </div>
          );
        })}
      </div>

      <div className="p-6 rounded-xl" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
        <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
          <div>
            <h3 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>Controle de orçamento</h3>
            <p className="text-sm mt-1" style={{ color: "var(--text-secondary)" }}>Configuração persistida no banco de custos.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-[160px_150px_auto] gap-3 w-full md:w-auto">
            <label className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
              Orçamento mensal
              <input
                type="number"
                min="1"
                step="1"
                value={budgetDraft}
                onChange={(event) => {
                  setBudgetDraft(event.target.value);
                  setSettingsDirty(true);
                }}
                className="mt-1 w-full rounded-lg px-3 py-2 text-sm outline-none"
                style={{ backgroundColor: "var(--card-elevated)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
              />
            </label>
            <label className="text-xs font-medium" style={{ color: "var(--text-secondary)" }}>
              Alerta (%)
              <input
                type="number"
                min="1"
                max="100"
                step="1"
                value={alertDraft}
                onChange={(event) => {
                  setAlertDraft(event.target.value);
                  setSettingsDirty(true);
                }}
                className="mt-1 w-full rounded-lg px-3 py-2 text-sm outline-none"
                style={{ backgroundColor: "var(--card-elevated)", border: "1px solid var(--border)", color: "var(--text-primary)" }}
              />
            </label>
            <button
              type="button"
              onClick={saveSettings}
              disabled={savingSettings || !settingsDirty}
              className="inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-all disabled:opacity-50 sm:self-end"
              style={{ backgroundColor: "var(--accent)", color: "white" }}
            >
              <Save className="w-4 h-4" />
              Salvar
            </button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="p-6 rounded-xl" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
          <h3 className="text-lg font-semibold mb-4" style={{ color: "var(--text-primary)" }}>Tendência diária</h3>
          <ResponsiveContainer width="100%" height={300}>
            <LineChart data={costData.daily}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" stroke="var(--text-muted)" style={{ fontSize: "12px" }} />
              <YAxis stroke="var(--text-muted)" style={{ fontSize: "12px" }} tickFormatter={(value) => `$${value}`} />
              <Tooltip contentStyle={tooltipStyle} formatter={(value) => money(Number(value))} />
              <Legend />
              <Line type="monotone" dataKey="cost" stroke="var(--accent)" strokeWidth={2} name="Custo" dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="p-6 rounded-xl" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
          <h3 className="text-lg font-semibold mb-4" style={{ color: "var(--text-primary)" }}>Últimas 24h</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={costData.hourly}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="hour" stroke="var(--text-muted)" style={{ fontSize: "12px" }} interval={2} />
              <YAxis stroke="var(--text-muted)" style={{ fontSize: "12px" }} tickFormatter={(value) => `$${value}`} />
              <Tooltip contentStyle={tooltipStyle} formatter={(value) => money(Number(value))} />
              <Bar dataKey="cost" fill="var(--accent)" name="Custo" />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="p-6 rounded-xl" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
          <h3 className="text-lg font-semibold mb-4" style={{ color: "var(--text-primary)" }}>Custo por agente</h3>
          {costData.byAgent.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={costData.byAgent}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                <XAxis dataKey="agent" stroke="var(--text-muted)" style={{ fontSize: "12px" }} />
                <YAxis stroke="var(--text-muted)" style={{ fontSize: "12px" }} tickFormatter={(value) => `$${value}`} />
                <Tooltip contentStyle={tooltipStyle} formatter={(value) => money(Number(value))} />
                <Bar dataKey="cost" fill="#32ADE6" name="Custo" />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <EmptyPanel label="Sem custos por agente" />
          )}
        </div>

        <div className="p-6 rounded-xl" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
          <h3 className="text-lg font-semibold mb-4" style={{ color: "var(--text-primary)" }}>Custo por modelo</h3>
          {costData.byModel.length > 0 ? (
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie
                  data={costData.byModel}
                  dataKey="cost"
                  nameKey="model"
                  cx="50%"
                  cy="50%"
                  innerRadius={58}
                  outerRadius={100}
                  paddingAngle={2}
                >
                  {costData.byModel.map((entry, index) => (
                    <Cell key={entry.model} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip contentStyle={tooltipStyle} formatter={(value, _name, props) => [money(Number(value)), shortModel(String(props.payload?.model ?? ""))]} />
                <Legend formatter={(value) => shortModel(String(value))} />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <EmptyPanel label="Sem custos por modelo" />
          )}
        </div>

        <div className="p-6 rounded-xl xl:col-span-2" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
          <h3 className="text-lg font-semibold mb-4" style={{ color: "var(--text-primary)" }}>Uso diário de tokens</h3>
          <ResponsiveContainer width="100%" height={300}>
            <BarChart data={costData.daily}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" stroke="var(--text-muted)" style={{ fontSize: "12px" }} />
              <YAxis stroke="var(--text-muted)" style={{ fontSize: "12px" }} tickFormatter={(value) => compactNumber(Number(value))} />
              <Tooltip contentStyle={tooltipStyle} formatter={(value) => compactNumber(Number(value))} />
              <Legend />
              <Bar dataKey="input" stackId="tokens" fill="#60A5FA" name="Entrada" />
              <Bar dataKey="output" stackId="tokens" fill="#F59E0B" name="Saída" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div className="p-6 rounded-xl" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
          <div className="flex items-center gap-2 mb-4">
            <PieChartIcon className="w-5 h-5" style={{ color: "var(--accent)" }} />
            <h3 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>Detalhamento por agente</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <th className="text-left py-3 px-4 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>Agente</th>
                  <th className="text-right py-3 px-4 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>Tokens</th>
                  <th className="text-right py-3 px-4 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>Custo</th>
                  <th className="text-right py-3 px-4 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>%</th>
                </tr>
              </thead>
              <tbody>
                {costData.byAgent.length === 0 && (
                  <tr>
                    <td className="py-6 px-4 text-center" colSpan={4} style={{ color: "var(--text-muted)" }}>Sem agentes com custo no período</td>
                  </tr>
                )}
                {costData.byAgent.map((agent) => (
                  <tr key={agent.agent} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td className="py-3 px-4 font-medium" style={{ color: "var(--text-primary)" }}>{agent.agent}</td>
                    <td className="py-3 px-4 text-right font-mono text-sm" style={{ color: "var(--text-secondary)" }}>{compactNumber(agent.tokens)}</td>
                    <td className="py-3 px-4 text-right font-semibold" style={{ color: "var(--text-primary)" }}>{money(agent.cost)}</td>
                    <td className="py-3 px-4 text-right" style={{ color: "var(--text-secondary)" }}>{agent.percentOfTotal.toFixed(1)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="p-6 rounded-xl" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
          <div className="flex items-center gap-2 mb-4">
            <Hash className="w-5 h-5" style={{ color: "var(--accent)" }} />
            <h3 className="text-lg font-semibold" style={{ color: "var(--text-primary)" }}>Sessões mais caras</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr style={{ borderBottom: "1px solid var(--border)" }}>
                  <th className="text-left py-3 px-4 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>Sessão</th>
                  <th className="text-left py-3 px-4 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>Modelo</th>
                  <th className="text-right py-3 px-4 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>Tokens</th>
                  <th className="text-right py-3 px-4 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>Custo</th>
                </tr>
              </thead>
              <tbody>
                {costData.bySession.length === 0 && (
                  <tr>
                    <td className="py-6 px-4 text-center" colSpan={4} style={{ color: "var(--text-muted)" }}>Sem sessões com custo no período</td>
                  </tr>
                )}
                {costData.bySession.map((session) => (
                  <tr key={`${session.sessionKey}:${session.model}`} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td className="py-3 px-4">
                      <div className="font-medium" style={{ color: "var(--text-primary)" }}>{shortSession(session.sessionKey)}</div>
                      <div className="text-xs" style={{ color: "var(--text-muted)" }}>{session.agent} · {formatTimestamp(session.lastSeenAt)}</div>
                    </td>
                    <td className="py-3 px-4 text-sm" style={{ color: "var(--text-secondary)" }}>{shortModel(session.model)}</td>
                    <td className="py-3 px-4 text-right font-mono text-sm" style={{ color: "var(--text-secondary)" }}>{compactNumber(session.tokens)}</td>
                    <td className="py-3 px-4 text-right font-semibold" style={{ color: "var(--text-primary)" }}>{money(session.cost)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="p-6 rounded-xl" style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
        <h3 className="text-lg font-semibold mb-4" style={{ color: "var(--text-primary)" }}>Preços de referência</h3>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                <th className="text-left py-3 px-4 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>Modelo</th>
                <th className="text-right py-3 px-4 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>Entrada / 1M</th>
                <th className="text-right py-3 px-4 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>Saída / 1M</th>
                <th className="text-right py-3 px-4 text-sm font-medium" style={{ color: "var(--text-secondary)" }}>Contexto</th>
              </tr>
            </thead>
            <tbody>
              {costData.pricing.map((model) => (
                <tr key={model.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td className="py-3 px-4">
                    <div className="font-medium" style={{ color: "var(--text-primary)" }}>{model.name}</div>
                    <div className="text-xs" style={{ color: "var(--text-muted)" }}>{model.id}</div>
                  </td>
                  <td className="py-3 px-4 text-right" style={{ color: "var(--text-primary)" }}>{money(model.input)}</td>
                  <td className="py-3 px-4 text-right" style={{ color: "var(--text-primary)" }}>{money(model.output)}</td>
                  <td className="py-3 px-4 text-right font-mono text-sm" style={{ color: "var(--text-secondary)" }}>{compactNumber(model.contextWindow)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
