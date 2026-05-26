"use client";

import { useEffect, useState } from "react";
import { Sparkles, Check } from "lucide-react";

export interface AgentTemplate {
  id: string;
  name: string;
  emoji: string;
  color: string;
  role: "orchestrator" | "specialist" | "reviewer";
  specialty: string[];
  inherit_jarvis_skills: boolean;
  suggested_model: string;
  suggested_fallback?: string;
  suggested_skills: string[];
  personality: string;
  system_prompt: string;
  default_cost_caps?: { per_task_cents?: number; per_day_cents?: number };
}

interface Props {
  selectedTemplateId?: string;
  onPick: (template: AgentTemplate) => void;
}

/**
 * Inline gallery of pre-built agent templates. Sits inside the create-agent
 * modal as a collapsible section. Clicking a card pre-fills the surrounding
 * form via `onPick(template)` — everything stays editable afterwards (the
 * template is just a starting point, not a binding contract).
 */
export function AgentTemplatePicker({ selectedTemplateId, onPick }: Props) {
  const [templates, setTemplates] = useState<AgentTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/agent-templates")
      .then((r) => r.json())
      .then((data) => {
        if (cancelled) return;
        if (data.error) setError(data.error);
        setTemplates(Array.isArray(data.templates) ? data.templates : []);
      })
      .catch((e) => !cancelled && setError(String(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <div className="p-3 rounded-lg text-xs text-zinc-500 bg-zinc-900/40 border" style={{ borderColor: "var(--border)" }}>
        Carregando templates...
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-3 rounded-lg text-xs text-amber-400 bg-amber-950/30 border border-amber-500/30">
        Não foi possível carregar templates: {error}
      </div>
    );
  }
  if (templates.length === 0) return null;

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-bold text-zinc-400 uppercase tracking-wide">
        <Sparkles className="w-3 h-3" />
        Começar a partir de um template
      </div>
      <div className="text-[10px] text-zinc-500 leading-relaxed">
        Pré-preenche o formulário com prompt, personalidade e skills sugeridas. Você pode editar tudo depois.
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 max-h-56 overflow-y-auto p-1">
        {templates.map((t) => {
          const selected = selectedTemplateId === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onPick(t)}
              className="text-left p-2.5 rounded-lg border transition-all hover:scale-[1.02] hover:border-zinc-500 group"
              style={{
                backgroundColor: selected ? "rgba(59,130,246,0.10)" : "rgba(24,24,27,0.6)",
                borderColor: selected ? t.color : "var(--border)",
                cursor: "pointer",
              }}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xl leading-none" aria-hidden>
                  {t.emoji}
                </span>
                {selected && <Check className="w-3.5 h-3.5" style={{ color: t.color }} />}
              </div>
              <div className="text-xs font-semibold text-white leading-tight">{t.name}</div>
              <div className="text-[10px] text-zinc-500 mt-0.5 leading-snug line-clamp-2">
                {t.specialty.slice(0, 3).join(", ")}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
