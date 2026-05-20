"use client";

import { useEffect, useState, useCallback } from "react";
import { Database, Download, Play, RefreshCw, Settings as SettingsIcon, Zap } from "lucide-react";
import { useToast } from "@/components/Toast";
import { ExtractorPanel, type ExtractorProvider } from "@/components/memory/ExtractorPanel";

interface SettingsState {
  embedding_provider: string;
  embedding_model: string;
  forgetting_threshold: number;
  forgetting_age_days: number;
  inject_into_memory_md: boolean;
  extraction_enabled: boolean;
  extractor_provider: ExtractorProvider;
  ollama_model: string;
}

interface Stats {
  total: number;
  archived: number;
  pinned: number;
  byType: Record<string, number>;
  byWorkspace: Record<string, number>;
  embeddingModel: string | null;
  lastExtractionAt: string | null;
  cursors: number;
  fts: { totalFiles: number; lastIndexedAt: string | null };
  embeddingReady: boolean;
}

export function MemorySettings() {
  const toast = useToast();
  const [settings, setSettings] = useState<SettingsState | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, t] = await Promise.all([
        fetch("/api/memory/settings").then((r) => r.json()),
        fetch("/api/memory/stats").then((r) => r.json()),
      ]);
      setSettings(s);
      setStats(t);
    } catch {
      toast.error("Falha ao carregar configurações");
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const patch = async (patch: Partial<SettingsState>) => {
    try {
      const res = await fetch("/api/memory/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error("Falha");
      const data = await res.json();
      setSettings(data);
      toast.success("Configurações atualizadas");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha");
    }
  };

  const runAction = async (
    label: string,
    url: string,
    body?: Record<string, unknown>,
  ) => {
    try {
      setBusy(label);
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error || "Falha");
      toast.success(`${label}: ${JSON.stringify(data).slice(0, 80)}`);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Falha");
    } finally {
      setBusy(null);
    }
  };

  if (!settings || !stats) {
    return (
      <div style={{ padding: 24, color: "var(--text-muted)" }}>
        Carregando configurações…
      </div>
    );
  }

  return (
    <div style={{ padding: 24, overflowY: "auto", flex: 1 }}>
      <div style={{ maxWidth: 880, marginInline: "auto", display: "flex", flexDirection: "column", gap: 24 }}>
        {/* Stats panel */}
        <section style={cardStyle}>
          <h3 style={sectionTitleStyle}>
            <Database size={14} /> Estatísticas
          </h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12, marginTop: 12 }}>
            <StatBlock label="Memórias ativas" value={stats.total - stats.archived} />
            <StatBlock label="Pinadas" value={stats.pinned} />
            <StatBlock label="Arquivadas" value={stats.archived} />
            <StatBlock label="Sessões processadas" value={stats.cursors} />
            <StatBlock label="Arquivos no índice FTS" value={stats.fts.totalFiles} />
          </div>
          <div style={{ marginTop: 14, display: "flex", gap: 16, flexWrap: "wrap", fontSize: 12, color: "var(--text-muted)" }}>
            {Object.entries(stats.byType).map(([type, n]) => (
              <span key={type}>{type}: <strong style={{ color: "var(--text-primary)" }}>{n}</strong></span>
            ))}
          </div>
          <div style={{ marginTop: 10, fontSize: 11, color: "var(--text-muted)" }}>
            Modelo de embedding em uso: {stats.embeddingModel || "(ainda sem embeddings)"} {" · "}
            Pronto: {stats.embeddingReady ? "✓" : "carregando sob demanda"}
          </div>
          {stats.lastExtractionAt && (
            <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
              Última extração: {new Date(stats.lastExtractionAt).toLocaleString("pt-BR")}
            </div>
          )}
        </section>

        {/* Actions */}
        <section style={cardStyle}>
          <h3 style={sectionTitleStyle}>
            <Play size={14} /> Ações
          </h3>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
            <button
              type="button"
              disabled={busy === "Import"}
              onClick={() => runAction("Import", "/api/memory/import", { embed: true })}
              style={actionButtonStyle}
            >
              <Download size={13} /> Importar markdown existente
            </button>
            <button
              type="button"
              disabled={busy === "Extract"}
              onClick={() => runAction("Extract", "/api/memory/extract/run", { maxSessions: 20 })}
              style={actionButtonStyle}
            >
              <Zap size={13} /> Extrair sessões recentes
            </button>
            <button
              type="button"
              disabled={busy === "Inject"}
              onClick={() => runAction("Inject", "/api/memory/inject/run", {})}
              style={actionButtonStyle}
            >
              <RefreshCw size={13} /> Atualizar AUTO-RECALL nos MEMORY.md
            </button>
            <button
              type="button"
              disabled={busy === "Reindex"}
              onClick={() => runAction("Reindex", "/api/memory/index", {})}
              style={actionButtonStyle}
            >
              <Database size={13} /> Reindexar FTS
            </button>
          </div>
          {busy && (
            <div style={{ marginTop: 10, fontSize: 12, color: "var(--text-muted)" }}>
              Rodando: {busy}…
            </div>
          )}
        </section>

        {/* Toggles */}
        <section style={cardStyle}>
          <h3 style={sectionTitleStyle}>
            <SettingsIcon size={14} /> Comportamento
          </h3>
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
            <ToggleRow
              label="Extração automática de sessões"
              hint="A cada 15 minutos, lê novos JSONLs e cria memórias."
              value={settings.extraction_enabled}
              onChange={(v) => patch({ extraction_enabled: v })}
            />
            <ToggleRow
              label="Injetar memórias no MEMORY.md dos workspaces"
              hint="Cria/atualiza uma seção gerenciada com as memórias top — o agente lê no boot."
              value={settings.inject_into_memory_md}
              onChange={(v) => patch({ inject_into_memory_md: v })}
            />
          </div>
        </section>

        <ExtractorPanel
          provider={settings.extractor_provider}
          ollamaModel={settings.ollama_model}
          onSettingsChange={patch}
        />

        <section style={cardStyle}>
          <h3 style={sectionTitleStyle}>Esquecimento</h3>
          <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <NumberRow
              label="Limiar de importância (abaixo arquiva)"
              value={settings.forgetting_threshold}
              min={0}
              max={1}
              step={0.05}
              onChange={(v) => patch({ forgetting_threshold: v })}
            />
            <NumberRow
              label="Idade mínima (dias) sem acesso"
              value={settings.forgetting_age_days}
              min={1}
              max={365}
              step={1}
              onChange={(v) => patch({ forgetting_age_days: Math.round(v) })}
            />
          </div>
        </section>

        <section style={cardStyle}>
          <h3 style={sectionTitleStyle}>Embeddings</h3>
          <div style={{ marginTop: 10, fontSize: 12, color: "var(--text-muted)" }}>
            Provider atual: <strong style={{ color: "var(--text-primary)" }}>{settings.embedding_provider}</strong> · modelo {settings.embedding_model}
          </div>
          <div style={{ marginTop: 6, fontSize: 11, color: "var(--text-muted)" }}>
            Padrão é Xenova rodando 100% local (zero custo, ~30MB no primeiro uso). Outros providers serão habilitados em uma versão futura.
          </div>
        </section>
      </div>
    </div>
  );
}

function StatBlock({ label, value }: { label: string; value: number | string }) {
  return (
    <div style={{ background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 6, padding: 10 }}>
      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{label}</div>
      <div style={{ fontFamily: "var(--font-heading)", fontSize: 22, fontWeight: 700, color: "var(--text-primary)" }}>
        {value}
      </div>
    </div>
  );
}

function ToggleRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, justifyContent: "space-between" }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, color: "var(--text-primary)", fontWeight: 500 }}>{label}</div>
        {hint && <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{hint}</div>}
      </div>
      <button
        type="button"
        onClick={() => onChange(!value)}
        aria-pressed={value}
        style={{
          width: 38,
          height: 22,
          borderRadius: 999,
          border: "none",
          background: value ? "var(--accent)" : "var(--border)",
          cursor: "pointer",
          position: "relative",
          transition: "background 120ms ease",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: value ? 18 : 2,
            width: 18,
            height: 18,
            borderRadius: 999,
            background: "var(--text-primary)",
            transition: "left 120ms ease",
          }}
        />
      </button>
    </div>
  );
}

function NumberRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={{ fontSize: 12, color: "var(--text-secondary)" }}>{label}</span>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{
          padding: "6px 8px",
          borderRadius: 6,
          border: "1px solid var(--border)",
          background: "var(--bg)",
          color: "var(--text-primary)",
          fontSize: 13,
          outline: "none",
        }}
      />
    </label>
  );
}

const cardStyle: React.CSSProperties = {
  background: "var(--card)",
  border: "1px solid var(--border)",
  borderRadius: 10,
  padding: 16,
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: "var(--text-primary)",
  display: "flex",
  alignItems: "center",
  gap: 6,
};

const actionButtonStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "8px 12px",
  borderRadius: 6,
  border: "1px solid var(--border)",
  background: "var(--bg)",
  color: "var(--text-primary)",
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
};
