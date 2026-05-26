"use client";

import { useCallback, useEffect, useState } from "react";
import { Sparkles, ShieldCheck, DollarSign, Bell, Save } from "lucide-react";

interface Settings {
  autonomous_mode: boolean;
  require_user_approval: boolean;
  cost_caps_enforce: boolean;
  notify_on_delegation: boolean;
  default_reviewer_id: string | null;
  updated_at: string;
}

/**
 * Compact card with the four orchestration switches that the human user
 * cares about. Sits at the top of /agents next to the OpenClawDefaultsCard.
 *
 * `autonomous_mode` is the headline: when ON, Jarvis skips approvals for
 * both the plan-decompose step and the final delivery. Per-agent
 * `override_autonomous` (in the agent modal) lets advanced users force one
 * agent back to manual review even with global=ON.
 */
export function OrchestrationSettingsCard() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/orchestration", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setSettings(data.settings);
    } catch {
      // best effort
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const persist = useCallback(
    async (patch: Partial<Settings>) => {
      setSaving(true);
      try {
        const res = await fetch("/api/settings/orchestration", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (res.ok) {
          const data = await res.json();
          setSettings(data.settings);
        }
      } finally {
        setSaving(false);
      }
    },
    [],
  );

  if (!settings) {
    return (
      <div
        className="p-4 rounded-xl text-xs text-zinc-500"
        style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
      >
        Carregando configurações de orquestração...
      </div>
    );
  }

  const headlineColor = settings.autonomous_mode ? "#a855f7" : "#64748b";

  return (
    <div
      className="rounded-xl p-4"
      style={{ backgroundColor: "var(--card)", border: "1px solid var(--border)" }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4" style={{ color: headlineColor }} />
          <h3 className="font-bold text-sm text-white">Orquestração Multi-Agente</h3>
          {saving && (
            <span className="text-[10px] text-zinc-500 flex items-center gap-1">
              <Save className="w-3 h-3 animate-pulse" /> salvando…
            </span>
          )}
        </div>
        <span className="text-[10px] text-zinc-500">
          atualizado {new Date(settings.updated_at).toLocaleString()}
        </span>
      </div>

      {/* Hero toggle: autonomous_mode */}
      <label
        className="flex items-start gap-3 p-3 rounded-lg cursor-pointer transition-colors mb-3"
        style={{
          backgroundColor: settings.autonomous_mode ? "rgba(168,85,247,0.10)" : "rgba(0,0,0,0.20)",
          border: `1px solid ${settings.autonomous_mode ? "rgba(168,85,247,0.30)" : "var(--border)"}`,
        }}
      >
        <input
          type="checkbox"
          checked={settings.autonomous_mode}
          onChange={(e) => persist({ autonomous_mode: e.target.checked })}
          className="mt-0.5"
        />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-white flex items-center gap-1.5">
            🚀 Modo Autônomo
            {settings.autonomous_mode && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-purple-500/20 text-purple-300">
                ATIVO
              </span>
            )}
          </div>
          <div className="text-[11px] text-zinc-400 leading-relaxed mt-0.5">
            Quando ligado, Jarvis decompõe + executa sem pedir aprovação prévia e entrega
            direto ao final. Quando desligado, sempre pergunta antes de executar e antes de
            entregar. Bom para usuários técnicos que querem revisar cada passo.
          </div>
        </div>
      </label>

      {/* Secondary switches */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <Toggle
          icon={<ShieldCheck className="w-3.5 h-3.5" />}
          label="Aprovação humana antes de Done"
          help="Tasks em review aguardam 👍/👎 do usuário antes de marcar done."
          checked={settings.require_user_approval}
          onChange={(v) => persist({ require_user_approval: v })}
        />
        <Toggle
          icon={<DollarSign className="w-3.5 h-3.5" />}
          label="Aplicar Cost Caps"
          help="Dispatcher pausa quando um agente excede o cap diário/por-tarefa."
          checked={settings.cost_caps_enforce}
          onChange={(v) => persist({ cost_caps_enforce: v })}
        />
        <Toggle
          icon={<Bell className="w-3.5 h-3.5" />}
          label="Notificar ao delegar"
          help="Jarvis avisa que iniciou o trabalho assim que delega."
          checked={settings.notify_on_delegation}
          onChange={(v) => persist({ notify_on_delegation: v })}
        />
      </div>
    </div>
  );
}

interface ToggleProps {
  icon: React.ReactNode;
  label: string;
  help: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}

function Toggle({ icon, label, help, checked, onChange }: ToggleProps) {
  return (
    <label
      className="flex items-start gap-2 p-2.5 rounded-lg cursor-pointer transition-colors hover:bg-zinc-900/40"
      style={{ border: "1px solid var(--border)" }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold text-white flex items-center gap-1.5">
          {icon} {label}
        </div>
        <div className="text-[10px] text-zinc-500 leading-snug">{help}</div>
      </div>
    </label>
  );
}
