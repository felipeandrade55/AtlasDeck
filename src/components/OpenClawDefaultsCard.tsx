"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Settings2,
  Save,
  RotateCcw,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Info,
  Sparkles,
  Shield,
  Database,
  RefreshCw,
} from "lucide-react";
import { ModelPicker } from "./ModelPicker";

interface DefaultsView {
  primary: string;
  fallback: string | null;
  fallbackShape: "string" | "array" | "none";
  reserveTokensFloor: number | null;
  isFallbackConfig: boolean;
  configPath: string;
}

interface Props {
  /** Called after a successful save so parent can re-fetch agents (which inherit defaults). */
  onSaved?: () => void;
}

export function OpenClawDefaultsCard({ onSaved }: Props) {
  const [data, setData] = useState<DefaultsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Local edits (compared against `data` to determine "dirty")
  const [primary, setPrimary] = useState("");
  const [fallback, setFallback] = useState("");
  const [reserveTokens, setReserveTokens] = useState<string>("");

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/openclaw/agents-config", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: DefaultsView = await res.json();
      setData(json);
      setPrimary(json.primary || "");
      setFallback(json.fallback || "");
      setReserveTokens(json.reserveTokensFloor != null ? String(json.reserveTokensFloor) : "");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const dirty =
    !!data && (
      (primary || "") !== (data.primary || "") ||
      (fallback || "") !== (data.fallback || "") ||
      (reserveTokens === "" ? null : Number(reserveTokens)) !== data.reserveTokensFloor
    );

  const revert = () => {
    if (!data) return;
    setPrimary(data.primary || "");
    setFallback(data.fallback || "");
    setReserveTokens(data.reserveTokensFloor != null ? String(data.reserveTokensFloor) : "");
    setSaveError(null);
  };

  const save = async () => {
    if (!data) return;
    setSaving(true);
    setSaveError(null);
    try {
      const body: Record<string, unknown> = {};
      if ((primary || "") !== (data.primary || "")) body.primary = primary.trim();
      if ((fallback || "") !== (data.fallback || "")) {
        body.fallback = fallback.trim() ? fallback.trim() : null;
      }
      const reserveNum = reserveTokens === "" ? null : Number(reserveTokens);
      if (reserveNum !== data.reserveTokensFloor) {
        body.reserveTokensFloor = reserveNum;
      }

      const res = await fetch("/api/openclaw/agents-config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) {
        setSaveError(json.error || `HTTP ${res.status}`);
        return;
      }
      setSavedAt(new Date());
      await load();
      onSaved?.();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (loading && !data) {
    return (
      <div
        className="rounded-xl p-6 flex items-center justify-center gap-3"
        style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
      >
        <Loader2 className="w-4 h-4 animate-spin" style={{ color: "var(--accent)" }} />
        <span className="text-sm" style={{ color: "var(--text-secondary)" }}>
          Lendo defaults do OpenClaw…
        </span>
      </div>
    );
  }

  if (error) {
    return (
      <div
        className="rounded-xl p-4 flex items-start gap-3"
        style={{
          backgroundColor: "rgba(239,68,68,0.08)",
          border: "1px solid rgba(239,68,68,0.3)",
        }}
      >
        <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" style={{ color: "#f87171" }} />
        <div className="flex-1">
          <h3 className="font-semibold text-sm" style={{ color: "#fca5a5" }}>
            Não consegui ler o openclaw.json
          </h3>
          <p className="text-xs mt-1" style={{ color: "var(--text-secondary)" }}>{error}</p>
        </div>
        <button
          onClick={load}
          className="text-xs px-2 py-1 rounded-lg flex items-center gap-1.5"
          style={{ backgroundColor: "rgba(255,255,255,0.04)", color: "var(--text-secondary)", border: "1px solid var(--border)" }}
        >
          <RefreshCw className="w-3 h-3" />
          Tentar novamente
        </button>
      </div>
    );
  }

  return (
    <div
      className="rounded-xl overflow-hidden"
      style={{
        backgroundColor: "var(--card)",
        border: "1px solid rgba(139, 92, 246, 0.3)",
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between gap-3 px-5 py-3 border-b"
        style={{ borderColor: "var(--border)", background: "linear-gradient(135deg, rgba(139,92,246,0.08), transparent)" }}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
            style={{ backgroundColor: "rgba(139, 92, 246, 0.15)" }}
          >
            <Settings2 className="w-4.5 h-4.5" style={{ color: "#a78bfa" }} />
          </div>
          <div className="min-w-0">
            <h2 className="font-bold text-sm md:text-base" style={{ color: "var(--text-primary)" }}>
              Defaults globais do OpenClaw
            </h2>
            <p className="text-[11px] truncate" style={{ color: "var(--text-muted)" }}>
              Aplicados a todos os agentes que não sobrescrevem manualmente
            </p>
          </div>
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="p-1.5 rounded-md hover:bg-white/5 disabled:opacity-30"
          title="Recarregar do arquivo"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? "animate-spin" : ""}`} style={{ color: "var(--text-secondary)" }} />
        </button>
      </div>

      {data?.isFallbackConfig && (
        <div
          className="px-5 py-2.5 flex items-start gap-2 text-xs border-b"
          style={{
            backgroundColor: "rgba(234, 179, 8, 0.08)",
            color: "#fde68a",
            borderColor: "rgba(234, 179, 8, 0.2)",
          }}
        >
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            Este servidor não tem <code className="px-1 rounded bg-black/30">openclaw.json</code> real ainda — alterações são gravadas no fallback local do AtlasDeck e serão usadas na primeira inicialização do OpenClaw.
          </span>
        </div>
      )}

      {/* Body */}
      <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <label className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide" style={{ color: "var(--text-secondary)" }}>
            <Sparkles className="w-3.5 h-3.5" style={{ color: "#a78bfa" }} />
            Modelo Primário (padrão)
          </label>
          <ModelPicker value={primary} onChange={setPrimary} />
        </div>

        <div className="space-y-1.5">
          <label className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide" style={{ color: "var(--text-secondary)" }}>
            <Shield className="w-3.5 h-3.5" style={{ color: "#facc15" }} />
            Modelo de Fallback (padrão)
          </label>
          <ModelPicker
            value={fallback}
            onChange={setFallback}
            allowEmpty
            emptyLabel="(sem fallback)"
          />
        </div>

        <div className="space-y-1.5 md:col-span-2">
          <label className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide" style={{ color: "var(--text-secondary)" }}>
            <Database className="w-3.5 h-3.5" style={{ color: "#60a5fa" }} />
            Reserve Tokens Floor (compaction)
          </label>
          <div className="flex items-stretch gap-2">
            <input
              type="number"
              min={1000}
              max={200000}
              step={1000}
              value={reserveTokens}
              onChange={(e) => setReserveTokens(e.target.value)}
              placeholder="ex: 20000"
              className="flex-1 px-3 py-2 rounded-lg text-xs outline-none bg-zinc-900 border text-white font-mono"
              style={{ borderColor: "var(--border)" }}
            />
            {[10000, 20000, 40000].map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setReserveTokens(String(v))}
                className="px-2.5 py-1 rounded-lg text-[10px] font-medium uppercase tracking-wider text-zinc-400 hover:bg-zinc-800 border"
                style={{ borderColor: "var(--border)" }}
              >
                {(v / 1000).toFixed(0)}k
              </button>
            ))}
          </div>
          <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            Reserva de tokens mantida livre durante compaction. Suba se você está vendo &ldquo;Context limit exceeded&rdquo;.
            Faixa: 1.000 – 200.000.
          </p>
        </div>
      </div>

      {/* Footer */}
      <div
        className="flex items-center justify-between flex-wrap gap-3 px-5 py-3 border-t"
        style={{ borderColor: "var(--border)", backgroundColor: "rgba(0,0,0,0.2)" }}
      >
        <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>
          {saveError ? (
            <span style={{ color: "#fca5a5" }}>⚠ {saveError}</span>
          ) : savedAt && !dirty ? (
            <span style={{ color: "#34d399" }}>
              <CheckCircle2 className="w-3 h-3 inline mr-1" />
              Salvo às {savedAt.toLocaleTimeString()}
            </span>
          ) : dirty ? (
            <span style={{ color: "#fde68a" }}>Alterações não salvas</span>
          ) : data?.configPath ? (
            <span className="font-mono truncate" title={data.configPath}>{data.configPath}</span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={revert}
            disabled={!dirty || saving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs disabled:opacity-30"
            style={{
              backgroundColor: "rgba(255,255,255,0.04)",
              color: "var(--text-secondary)",
              border: "1px solid var(--border)",
            }}
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Reverter
          </button>
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-medium disabled:opacity-40"
            style={{
              backgroundColor: "rgba(139, 92, 246, 0.2)",
              color: "#c4b5fd",
              border: "1px solid rgba(139, 92, 246, 0.4)",
            }}
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
            {saving ? "Salvando…" : "Salvar defaults"}
          </button>
        </div>
      </div>
    </div>
  );
}
